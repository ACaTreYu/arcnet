/**
 * ARCnet Protocol Core — v3 (framing + ACKs + retransmit + FEC + congestion control)
 *
 * Custom reliability protocol for real-time arena combat.
 * Runs on top of any transport (WebRTC DataChannel, WebSocket, etc.)
 *
 * Packet header (10 bytes):
 *   Byte 0:    [MAGIC: 0xAC]
 *   Byte 1:    [channel:2b (bits 7-6)][kind:2b (bits 5-4)][version:4b (bits 3-0)]
 *   Bytes 2-3: [sequence:u16 LE]     — per-channel outgoing sequence
 *   Bytes 4-5: [ackSeq:u16 LE]       — highest received seq from peer
 *   Bytes 6-9: [ackBitfield:u32 LE]  — bit N = "I received (ackSeq - N - 1)"
 *
 * FEC packet (kind = FEC_PARITY):
 *   Same header, payload = XOR of previous N data packets in the group.
 *   Receiver can reconstruct any single lost packet from the group.
 *
 * Congestion control:
 *   Monitors packet loss rate + RTT trends. Exposes a quality tier
 *   (GOOD/FAIR/POOR) that callers can use to throttle snapshot rate.
 */

// ─── Constants ───────────────────────────────────────────────────

/** On-wire protocol version — bump on any breaking header change. */
export const ARCNET_WIRE_VERSION = 1;
/** Legacy alias — kept for any external consumer that imported it. */
export const ARCNET_VERSION = ARCNET_WIRE_VERSION;
export const ARCNET_HEADER_SIZE = 10;
/** Magic byte to distinguish ARCnet packets from raw binary (0xAC = "AC"net) */
export const ARCNET_MAGIC = 0xAC;

export const enum Channel {
  /** Ordered + acked + retransmit. For death, score, match events. */
  CRITICAL = 0,
  /** Acked + retransmit, unordered. For fire events, hits. */
  RELIABLE = 1,
  /** Latest-only, drop stale. For state snapshots, input. */
  SEQUENCED = 2,
  /** Fire and forget. For cosmetics, particles. */
  VOLATILE = 3,
}

export const enum PacketFlags {
  NORMAL = 0,
  /** This packet is an FEC parity packet — payload is XOR of group */
  FEC_PARITY = 1,
  /** Input prediction "continue" — 0-byte payload */
  CONTINUE = 2,
}

/** Connection quality tier — callers use this to adapt behavior */
export const enum QualityTier {
  /** <2% loss, stable RTT — full rate */
  GOOD = 0,
  /** 2-8% loss or rising RTT — reduce non-essential traffic */
  FAIR = 1,
  /** >8% loss or RTT spike — aggressive throttle */
  POOR = 2,
}

// ─── Sequence math (u16 modular) ─────────────────────────────────

const SEQ_MAX = 0x10000;
const SEQ_HALF = 0x8000;

function seqNewer(a: number, b: number): boolean {
  const d = ((a - b + SEQ_MAX) % SEQ_MAX);
  return d > 0 && d < SEQ_HALF;
}

function seqNext(s: number): number {
  return (s + 1) % SEQ_MAX;
}

// ─── Packet Encode/Decode ────────────────────────────────────────

export interface ARCnetPacket {
  channel: Channel;
  flags: PacketFlags;
  sequence: number;
  ackSeq: number;
  ackBitfield: number;
  payload: ArrayBuffer;
}

/**
 * Encode: [magic:u8][byte1:u8][seq:u16 LE][ackSeq:u16 LE][ackBits:u32 LE][payload:N]
 * byte1 = [channel:2 (bits 7-6)][kind:2 (bits 5-4)][version:4 (bits 3-0)]
 * Total: 10 + payload bytes
 */
export function encodePacket(pkt: ARCnetPacket): ArrayBuffer {
  const size = ARCNET_HEADER_SIZE + pkt.payload.byteLength;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint8(0, ARCNET_MAGIC);
  view.setUint8(1,
    ((pkt.channel & 0x3) << 6) |
    ((pkt.flags & 0x3) << 4) |
    (ARCNET_WIRE_VERSION & 0xF)
  );
  view.setUint16(2, pkt.sequence, true);
  view.setUint16(4, pkt.ackSeq, true);
  view.setUint32(6, pkt.ackBitfield >>> 0, true);

  if (pkt.payload.byteLength > 0) {
    bytes.set(new Uint8Array(pkt.payload), ARCNET_HEADER_SIZE);
  }

  return buf;
}

/**
 * Decode an ARCnet packet. Returns null if not a valid ARCnet packet
 * (bad magic, wrong version, or too short).
 */
export function decodePacket(buf: ArrayBuffer): ARCnetPacket | null {
  if (buf.byteLength < ARCNET_HEADER_SIZE) return null;

  const view = new DataView(buf);
  if (view.getUint8(0) !== ARCNET_MAGIC) return null;

  const byte1 = view.getUint8(1);
  const version = byte1 & 0xF;
  if (version !== ARCNET_WIRE_VERSION) return null;

  const channel = ((byte1 >> 6) & 0x3) as Channel;
  const flags = ((byte1 >> 4) & 0x3) as PacketFlags;
  const sequence = view.getUint16(2, true);
  const ackSeq = view.getUint16(4, true);
  const ackBitfield = view.getUint32(6, true);
  const payload = buf.slice(ARCNET_HEADER_SIZE);

  return { channel, flags, sequence, ackSeq, ackBitfield, payload };
}

/** Quick check: is this buffer an ARCnet-framed packet? */
export function isARCnetPacket(data: ArrayBuffer | Buffer | Uint8Array): boolean {
  if (data.byteLength < ARCNET_HEADER_SIZE) return false;
  const first = data instanceof ArrayBuffer ? new Uint8Array(data)[0]
    : (data as any)[0];
  return first === ARCNET_MAGIC;
}

// ─── FEC (Forward Error Correction) ─────────────────────────────
//
// XOR parity with explicit seq tagging. Every FEC_GROUP_SIZE data packets
// the sender emits one parity packet whose payload carries:
//
//   [seq0:u16 LE][seq1:u16 LE][seq2:u16 LE]
//   [xor of (u16 LE length + payload bytes) for each of the 3 packets,
//    zero-padded to the max encoded length]
//
// The explicit seq tags make the protocol wrap-safe (no division by group
// size) and let the receiver deliver the recovered packet under its TRUE
// sequence number, not the parity's seq. The length-prefix preserves
// original payload sizes when the group contains variable-length packets.

/** Number of data packets per FEC group (parity emitted after each group) */
const FEC_GROUP_SIZE = 3;

/** Size in bytes of the seq-tag prefix at the start of a parity payload */
const FEC_PARITY_HEADER_SIZE = 2 * FEC_GROUP_SIZE;

/** Result of a successful FEC recovery — the missing packet's seq and its full payload. */
export interface FECRecovery {
  missingSeq: number;
  payload: ArrayBuffer;
}

/**
 * XOR a length-prefixed representation of `payload` into `xor[offset..]`.
 * Format: [u16 LE length][payload bytes]. Does NOT extend `xor` — caller must
 * size it to the max encoded length of the group.
 */
function xorEncodedInto(xor: Uint8Array, offset: number, payload: ArrayBuffer): void {
  const len = payload.byteLength;
  xor[offset] ^= len & 0xFF;
  xor[offset + 1] ^= (len >> 8) & 0xFF;
  const src = new Uint8Array(payload);
  for (let i = 0; i < src.length; i++) {
    xor[offset + 2 + i] ^= src[i];
  }
}

/** Sender-side FEC: accumulates packets and emits a seq-tagged length-prefixed XOR parity. */
class FECSender {
  private group: Array<{ seq: number; payload: ArrayBuffer }> = [];

  /**
   * Add a data packet to the current group. When the group is full, returns the
   * parity payload: [seq0][seq1][seq2][XOR of (u16 len + payload) each].
   */
  addPacket(seq: number, payload: ArrayBuffer): ArrayBuffer | null {
    this.group.push({ seq, payload });
    if (this.group.length < FEC_GROUP_SIZE) return null;

    let maxEncoded = 0;
    for (const e of this.group) maxEncoded = Math.max(maxEncoded, 2 + e.payload.byteLength);

    const parity = new Uint8Array(FEC_PARITY_HEADER_SIZE + maxEncoded);
    const view = new DataView(parity.buffer);

    for (let i = 0; i < FEC_GROUP_SIZE; i++) {
      view.setUint16(i * 2, this.group[i].seq, true);
    }
    for (const e of this.group) {
      xorEncodedInto(parity, FEC_PARITY_HEADER_SIZE, e.payload);
    }

    this.group = [];
    return parity.buffer as ArrayBuffer;
  }

  reset(): void { this.group = []; }
}

/**
 * Receiver-side FEC: stores recent data packets and pending parities. Recovers a
 * single missing packet per parity once all other packets in the group are known.
 * Parities may arrive before or after any of their data packets — either direction
 * triggers recovery when the "exactly one missing" condition is met.
 */
class FECReceiver {
  /** Max recent data packets kept (FIFO eviction by insertion order). */
  private static readonly MAX_DATA = 256;
  /** Max pending parities (FIFO eviction — old parities whose group never completes). */
  private static readonly MAX_PARITIES = 32;

  private receivedData: Map<number, ArrayBuffer> = new Map();
  private pendingParities: Array<{ seqs: number[]; xor: Uint8Array }> = [];

  /** Record a received data packet. Returns a recovery if this arrival completes a pending parity. */
  addDataPacket(seq: number, payload: ArrayBuffer): FECRecovery | null {
    this.receivedData.set(seq, payload);
    while (this.receivedData.size > FECReceiver.MAX_DATA) {
      const first = this.receivedData.keys().next().value;
      if (first === undefined) break;
      this.receivedData.delete(first);
    }

    for (let i = 0; i < this.pendingParities.length; i++) {
      const p = this.pendingParities[i];
      if (!p.seqs.includes(seq)) continue;
      const recovery = this.tryRecover(p);
      if (recovery) {
        this.pendingParities.splice(i, 1);
        return recovery;
      }
    }
    return null;
  }

  /** Record a parity packet. Returns a recovery if exactly one of its three seqs is missing. */
  addParityPacket(parityPayload: ArrayBuffer): FECRecovery | null {
    if (parityPayload.byteLength < FEC_PARITY_HEADER_SIZE) return null;

    const view = new DataView(parityPayload);
    const seqs: number[] = [];
    for (let i = 0; i < FEC_GROUP_SIZE; i++) {
      seqs.push(view.getUint16(i * 2, true));
    }
    const xor = new Uint8Array(parityPayload.slice(FEC_PARITY_HEADER_SIZE));
    const parity = { seqs, xor };

    const recovery = this.tryRecover(parity);
    if (recovery) return recovery;

    this.pendingParities.push(parity);
    while (this.pendingParities.length > FECReceiver.MAX_PARITIES) {
      this.pendingParities.shift();
    }
    return null;
  }

  private tryRecover(parity: { seqs: number[]; xor: Uint8Array }): FECRecovery | null {
    const missing: number[] = [];
    const present: ArrayBuffer[] = [];
    for (const s of parity.seqs) {
      const p = this.receivedData.get(s);
      if (p === undefined) missing.push(s);
      else present.push(p);
    }
    if (missing.length !== 1) return null;

    const work = new Uint8Array(parity.xor); // copy — don't mutate the stored parity
    for (const p of present) {
      xorEncodedInto(work, 0, p);
    }

    if (work.length < 2) return null;
    const recoveredLen = work[0] | (work[1] << 8);
    if (recoveredLen > work.length - 2) return null; // corrupt length prefix

    const payload = work.slice(2, 2 + recoveredLen).buffer as ArrayBuffer;
    return { missingSeq: missing[0], payload };
  }

  reset(): void {
    this.receivedData.clear();
    this.pendingParities = [];
  }
}

// ─── Congestion Control ──────────────────────────────────────────
//
// Tracks loss rate and RTT trends over a sliding window.
// Exposes QualityTier for callers to adapt snapshot rate.

class CongestionController {
  // Sliding window
  private sentCount = 0;
  private ackCount = 0;
  private windowSent = 0;
  private windowAcked = 0;

  // RTT tracking
  private rttSamples: number[] = [];
  private readonly RTT_WINDOW = 20;
  private rttTrend: number = 0; // positive = rising (bad), negative = falling (good)

  // Bandwidth estimation
  private windowBytesSent = 0;
  private windowBytesAcked = 0;
  private _estimatedBandwidth: number = 50000; // bytes/sec, start at 50KB/s
  private _goodputBps: number = 0; // actual delivered bytes/sec

  // Quality
  private _quality: QualityTier = QualityTier.GOOD;
  private lastEvalTime: number = -1; // -1 = not yet initialized
  private readonly EVAL_INTERVAL = 1000; // evaluate every 1s

  /**
   * Recommended snapshot send interval in ms.
   * Continuously adapts based on bandwidth/loss/RTT — smoother than tier steps.
   * Range: 30ms (33Hz, full rate) → 90ms (11Hz, heavy throttle)
   */
  private _snapshotInterval: number = 30;

  /** Record a packet was sent */
  recordSent(bytes: number = 0): void {
    this.sentCount++;
    this.windowSent++;
    this.windowBytesSent += bytes;
  }

  /**
   * Record peer ACKs for a batch of previously-sent packets.
   * Feed the count of pending packets actually cleared in this receive cycle
   * (returned by ChannelState.processAcks) — NOT the raw received-packet count.
   */
  recordAck(acksProcessed: number, rttSample?: number): void {
    if (acksProcessed > 0) {
      this.ackCount += acksProcessed;
      this.windowAcked += acksProcessed;
    }
    if (rttSample !== undefined && rttSample > 0) {
      this.rttSamples.push(rttSample);
      if (this.rttSamples.length > this.RTT_WINDOW) {
        this.rttSamples.shift();
      }
    }
  }

  /**
   * Record bytes received from peer — for goodput / receive-side throughput
   * estimation. Independent of ACK accounting.
   */
  recordReceivedBytes(bytes: number): void {
    this.windowBytesAcked += bytes;
  }

  /** Evaluate quality tier and bandwidth — call periodically */
  evaluate(now: number): void {
    if (this.lastEvalTime < 0) {
      // First call — initialize timestamp, skip calculation (no valid window yet)
      this.lastEvalTime = now;
      return;
    }
    if (now - this.lastEvalTime < this.EVAL_INTERVAL) return;
    const dt = now - this.lastEvalTime;
    this.lastEvalTime = now;

    // Loss rate over current window
    const lossRate = this.windowSent > 10
      ? 1 - (this.windowAcked / this.windowSent)
      : 0;

    // RTT trend: compare recent half to older half
    if (this.rttSamples.length >= 6) {
      const mid = Math.floor(this.rttSamples.length / 2);
      const oldAvg = this.rttSamples.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const newAvg = this.rttSamples.slice(mid).reduce((a, b) => a + b, 0) / (this.rttSamples.length - mid);
      this.rttTrend = (newAvg - oldAvg) / Math.max(oldAvg, 1);
    }

    // Bandwidth estimation: smoothed bytes/sec from acked data
    const dtSec = dt / 1000;
    if (dtSec > 0) {
      const measuredBps = this.windowBytesAcked / dtSec;
      // Exponential moving average (α=0.3 for responsive but stable estimate)
      this._estimatedBandwidth = 0.7 * this._estimatedBandwidth + 0.3 * measuredBps;
      this._goodputBps = measuredBps;
    }

    // Determine quality tier
    if (lossRate > 0.08 || this.rttTrend > 0.5) {
      this._quality = QualityTier.POOR;
    } else if (lossRate > 0.02 || this.rttTrend > 0.2) {
      this._quality = QualityTier.FAIR;
    } else {
      this._quality = QualityTier.GOOD;
    }

    // Continuous snapshot interval: blend loss, RTT trend, and bandwidth
    // Base: 30ms (33Hz). Scale up based on congestion signals.
    // Score 0-1 where 0=perfect, 1=terrible
    const lossScore = Math.min(lossRate / 0.15, 1);     // 15% loss = max penalty
    const rttScore = Math.min(Math.max(this.rttTrend, 0) / 0.8, 1); // 80% RTT rise = max
    const congestionScore = Math.max(lossScore, rttScore);
    // 30ms at score=0, 90ms at score=1 (cubic for gentle ramp at low congestion)
    this._snapshotInterval = 30 + 60 * (congestionScore * congestionScore);

    // Reset window for next evaluation period
    this.windowSent = 0;
    this.windowAcked = 0;
    this.windowBytesSent = 0;
    this.windowBytesAcked = 0;
  }

  get quality(): QualityTier { return this._quality; }
  get lossRate(): number {
    return this.sentCount > 0 ? 1 - (this.ackCount / this.sentCount) : 0;
  }
  get avgRTT(): number {
    if (this.rttSamples.length === 0) return 80;
    return this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
  }
  /** Estimated bandwidth in bytes/sec (smoothed) */
  get estimatedBandwidth(): number { return this._estimatedBandwidth; }
  /** Actual goodput in bytes/sec (current window) */
  get goodputBps(): number { return this._goodputBps; }
  /** Recommended snapshot interval in ms (30-90, continuously adaptive) */
  get snapshotInterval(): number { return this._snapshotInterval; }

  reset(): void {
    this.sentCount = 0;
    this.ackCount = 0;
    this.windowSent = 0;
    this.windowAcked = 0;
    this.windowBytesSent = 0;
    this.windowBytesAcked = 0;
    this.rttSamples = [];
    this.rttTrend = 0;
    this._quality = QualityTier.GOOD;
    this._estimatedBandwidth = 50000;
    this._goodputBps = 0;
    this._snapshotInterval = 30;
    this.lastEvalTime = -1;
  }
}

// ─── Channel State ───────────────────────────────────────────────

interface PendingPacket {
  seq: number;
  payload: ArrayBuffer;
  sentTime: number;
  retransmits: number;
}

class ChannelState {
  readonly channel: Channel;

  // Outgoing
  private outSeq: number = 0;
  private pending: Map<number, PendingPacket> = new Map();

  // Incoming
  private inHighest: number = 0;
  private inBitfield: number = 0;
  private hasReceivedAny: boolean = false;

  // CRITICAL: ordered delivery
  private deliveryQueue: Map<number, ArrayBuffer> = new Map();
  private nextDeliverSeq: number = 0;

  // SEQUENCED: drop stale
  private latestReceivedSeq: number = 0;

  // RTT
  private srtt: number = 80;
  private rttVar: number = 40;

  // FEC
  readonly fecSender: FECSender;
  readonly fecReceiver: FECReceiver;
  private readonly fecEnabled: boolean;

  constructor(channel: Channel, fecEnabled: boolean = false) {
    this.channel = channel;
    this.fecEnabled = fecEnabled;
    this.fecSender = new FECSender();
    this.fecReceiver = new FECReceiver();
  }

  get hasFEC(): boolean { return this.fecEnabled; }

  getNextSeq(): number {
    const seq = this.outSeq;
    this.outSeq = seqNext(this.outSeq);
    return seq;
  }

  getAckState(): { ackSeq: number; ackBitfield: number } {
    return {
      ackSeq: this.hasReceivedAny ? this.inHighest : 0,
      ackBitfield: this.inBitfield,
    };
  }

  trackOutgoing(seq: number, payload: ArrayBuffer, now: number): void {
    if (this.channel === Channel.CRITICAL || this.channel === Channel.RELIABLE) {
      this.pending.set(seq, { seq, payload, sentTime: now, retransmits: 0 });
    }
  }

  /**
   * Apply a peer's piggyback ACK info against our pending-retransmit map.
   * Returns the RTT sample (if any) and the count of pending packets cleared,
   * which drives the congestion controller's loss-rate denominator.
   */
  processAcks(peerAckSeq: number, peerAckBitfield: number, now: number): { rttSample?: number; acksProcessed: number } {
    const toRemove: number[] = [];
    let rttSample: number | undefined;
    for (const [seq, pkt] of this.pending) {
      const dist = ((peerAckSeq - seq + SEQ_MAX) % SEQ_MAX);
      if (dist === 0) {
        toRemove.push(seq);
        const sample = now - pkt.sentTime;
        this.updateRTT(sample);
        rttSample = sample;
      } else if (dist > 0 && dist <= 32 && (peerAckBitfield & (1 << (dist - 1)))) {
        toRemove.push(seq);
        const sample = now - pkt.sentTime;
        this.updateRTT(sample);
        if (rttSample === undefined) rttSample = sample;
      }
    }
    for (const seq of toRemove) this.pending.delete(seq);
    return { rttSample, acksProcessed: toRemove.length };
  }

  getRetransmits(now: number): PendingPacket[] {
    const timeout = Math.max(this.srtt * 1.5 + this.rttVar * 4, 80);
    const result: PendingPacket[] = [];
    for (const pkt of this.pending.values()) {
      if (now - pkt.sentTime > timeout) {
        result.push(pkt);
        pkt.sentTime = now;
        pkt.retransmits++;
        if (pkt.retransmits > 8) this.pending.delete(pkt.seq);
      }
    }
    return result;
  }

  /**
   * Process an incoming sequence. Returns payloads to deliver (may be empty if
   * stale/dup). When `fromFEC=true`, the payload is an FEC-recovered packet —
   * SEQUENCED staleness is bypassed so the app can reconcile via its own
   * sequence scheme, and latestReceivedSeq is not regressed.
   *
   * FEC ingestion for data packets is now handled at the session level, not here.
   */
  receiveSeq(seq: number, payload: ArrayBuffer, fromFEC: boolean = false): ArrayBuffer[] {
    // Update ACK state
    if (!this.hasReceivedAny) {
      this.hasReceivedAny = true;
      this.inHighest = seq;
      this.inBitfield = 0;
      this.nextDeliverSeq = seq;
      this.latestReceivedSeq = seq;
    } else if (seqNewer(seq, this.inHighest)) {
      const shift = ((seq - this.inHighest + SEQ_MAX) % SEQ_MAX);
      this.inBitfield = shift < 32
        ? ((this.inBitfield << shift) | (1 << (shift - 1))) >>> 0
        : 0;
      this.inHighest = seq;
    } else {
      const dist = ((this.inHighest - seq + SEQ_MAX) % SEQ_MAX);
      if (dist > 0 && dist <= 32) {
        this.inBitfield = (this.inBitfield | (1 << (dist - 1))) >>> 0;
      }
    }

    switch (this.channel) {
      case Channel.CRITICAL:
        return this.deliverOrdered(seq, payload);
      case Channel.RELIABLE:
        return [payload]; // unordered, deliver immediately
      case Channel.SEQUENCED:
        if (!fromFEC) {
          if (!seqNewer(seq, this.latestReceivedSeq) && seq !== this.latestReceivedSeq) {
            return []; // stale
          }
          this.latestReceivedSeq = seq;
        }
        // fromFEC path: deliver regardless of staleness; leave latestReceivedSeq alone
        return [payload];
      case Channel.VOLATILE:
        return [payload];
    }
    return [payload];
  }

  private deliverOrdered(seq: number, payload: ArrayBuffer): ArrayBuffer[] {
    // Skip already-delivered duplicates (seq strictly older than nextDeliverSeq).
    // On first-ever receive nextDeliverSeq was just set to seq, so this is a no-op there.
    if (!seqNewer(seq, this.nextDeliverSeq) && seq !== this.nextDeliverSeq) {
      return [];
    }
    this.deliveryQueue.set(seq, payload);
    const delivered: ArrayBuffer[] = [];
    while (this.deliveryQueue.has(this.nextDeliverSeq)) {
      delivered.push(this.deliveryQueue.get(this.nextDeliverSeq)!);
      this.deliveryQueue.delete(this.nextDeliverSeq);
      this.nextDeliverSeq = seqNext(this.nextDeliverSeq);
    }
    // Don't let delivery queue grow unbounded (gap too large = skip ahead).
    // Sort is anchored on nextDeliverSeq so modular ordering is preserved
    // across the u16 wrap boundary — a naive `a - b` comparator puts seq=0
    // after seq=65535 when they should be adjacent.
    if (this.deliveryQueue.size > 32) {
      const anchor = this.nextDeliverSeq;
      const seqs = [...this.deliveryQueue.keys()].sort(
        (a, b) => ((a - anchor + SEQ_MAX) % SEQ_MAX) - ((b - anchor + SEQ_MAX) % SEQ_MAX)
      );
      for (const s of seqs) {
        delivered.push(this.deliveryQueue.get(s)!);
      }
      this.deliveryQueue.clear();
      this.nextDeliverSeq = seqNext(this.inHighest);
    }
    return delivered;
  }

  private updateRTT(sample: number): void {
    if (sample <= 0) return;
    this.rttVar = 0.75 * this.rttVar + 0.25 * Math.abs(this.srtt - sample);
    this.srtt = 0.875 * this.srtt + 0.125 * sample;
  }

  getRTT(): number { return this.srtt; }
  getPendingCount(): number { return this.pending.size; }
}

// ─── ARCnet Session ──────────────────────────────────────────────

export interface ARCnetStats {
  rtt: number;
  packetsSent: number;
  packetsReceived: number;
  retransmits: number;
  bytesSent: number;
  bytesReceived: number;
  /** Cumulative loss rate (0-1) */
  lossRate: number;
  /** Current connection quality tier */
  quality: QualityTier;
  /** FEC recoveries — packets reconstructed without retransmit */
  fecRecoveries: number;
  /** Estimated bandwidth in bytes/sec (smoothed EMA) */
  estimatedBandwidth: number;
  /** Actual goodput in bytes/sec (current window) */
  goodputBps: number;
  /** Recommended snapshot interval in ms (30-90, continuously adaptive) */
  snapshotInterval: number;
}

/** Optional configuration for an ARCnetSession. */
export interface ARCnetSessionOptions {
  /**
   * Per-channel FEC enable, indexed by Channel enum value.
   * Defaults to [CRITICAL=false, RELIABLE=true, SEQUENCED=true, VOLATILE=false].
   * Enabling FEC on CRITICAL adds instant-recovery on top of retransmit for
   * single-packet losses — useful for low-volume, latency-sensitive events.
   */
  fec?: [boolean, boolean, boolean, boolean];
}

const DEFAULT_FEC: [boolean, boolean, boolean, boolean] = [false, true, true, false];

export class ARCnetSession {
  private channels: ChannelState[];
  private congestion: CongestionController;
  private readonly fecConfig: [boolean, boolean, boolean, boolean];
  private stats: ARCnetStats = {
    rtt: 80, packetsSent: 0, packetsReceived: 0,
    retransmits: 0, bytesSent: 0, bytesReceived: 0,
    lossRate: 0, quality: QualityTier.GOOD, fecRecoveries: 0,
    estimatedBandwidth: 50000, goodputBps: 0, snapshotInterval: 30,
  };

  constructor(options?: ARCnetSessionOptions) {
    this.fecConfig = options?.fec ?? DEFAULT_FEC;
    this.channels = this.buildChannels();
    this.congestion = new CongestionController();
  }

  private buildChannels(): ChannelState[] {
    return [
      new ChannelState(Channel.CRITICAL, this.fecConfig[0]),
      new ChannelState(Channel.RELIABLE, this.fecConfig[1]),
      new ChannelState(Channel.SEQUENCED, this.fecConfig[2]),
      new ChannelState(Channel.VOLATILE, this.fecConfig[3]),
    ];
  }

  /**
   * Wrap a payload in ARCnet framing for a given channel.
   *
   * Returns an array of encoded packets the caller must hand to its transport:
   *   - `[data]`                  for non-FEC channels, or for FEC channels when
   *                               the current group is not yet full.
   *   - `[data, parity]`          on the packet that completes an FEC group
   *                               (every FEC_GROUP_SIZE-th send on an FEC channel).
   *
   * Parity packets carry the seqs of all members of their group in the payload,
   * so their own header `sequence` is set to the last data seq in the group
   * purely for diagnostic continuity; recovery does not depend on it.
   */
  send(channel: Channel, payload: ArrayBuffer): ArrayBuffer[] {
    const ch = this.channels[channel];
    const seq = ch.getNextSeq();
    const { ackSeq, ackBitfield } = ch.getAckState();
    const now = Date.now();

    ch.trackOutgoing(seq, payload, now);
    this.congestion.recordSent(payload.byteLength + ARCNET_HEADER_SIZE);

    const dataPkt = encodePacket({
      channel, flags: PacketFlags.NORMAL,
      sequence: seq, ackSeq, ackBitfield, payload,
    });

    const result: ArrayBuffer[] = [dataPkt];
    this.stats.packetsSent++;
    this.stats.bytesSent += dataPkt.byteLength;

    if (ch.hasFEC) {
      const parityPayload = ch.fecSender.addPacket(seq, payload);
      if (parityPayload) {
        const parityPkt = encodePacket({
          channel, flags: PacketFlags.FEC_PARITY,
          sequence: seq, ackSeq, ackBitfield,
          payload: parityPayload,
        });
        result.push(parityPkt);
        this.stats.packetsSent++;
        this.stats.bytesSent += parityPkt.byteLength;
      }
    }

    return result;
  }

  /**
   * Process received ARCnet packet.
   * Returns delivered payloads (may be 0 if stale, or >1 if ordered queue flushed
   * or an FEC recovery runs piggyback). Returns null if not a valid ARCnet packet
   * (caller should handle as raw).
   */
  receive(buf: ArrayBuffer): Array<{ channel: Channel; payload: ArrayBuffer }> | null {
    const pkt = decodePacket(buf);
    if (!pkt) return null; // not ARCnet — pass through

    this.stats.packetsReceived++;
    this.stats.bytesReceived += buf.byteLength;

    const ch = this.channels[pkt.channel];
    const now = Date.now();

    // Process piggyback ACKs (peer acknowledging our outgoing packets)
    const { rttSample, acksProcessed } = ch.processAcks(pkt.ackSeq, pkt.ackBitfield, now);
    this.congestion.recordAck(acksProcessed, rttSample);
    this.congestion.recordReceivedBytes(buf.byteLength);

    const results: Array<{ channel: Channel; payload: ArrayBuffer }> = [];

    // FEC parity packet — may recover a single missing data packet in its group
    if (pkt.flags === PacketFlags.FEC_PARITY) {
      if (ch.hasFEC) {
        const recovered = ch.fecReceiver.addParityPacket(pkt.payload);
        if (recovered) {
          this.stats.fecRecoveries++;
          const payloads = ch.receiveSeq(recovered.missingSeq, recovered.payload, true);
          for (const p of payloads) results.push({ channel: pkt.channel, payload: p });
        }
      }
      return results;
    }

    // Normal data packet — deliver via the channel state machine
    const payloads = ch.receiveSeq(pkt.sequence, pkt.payload, false);
    for (const p of payloads) results.push({ channel: pkt.channel, payload: p });

    // Track this data packet in the FEC receiver; if it completes a pending
    // parity's group, we get a recovery to deliver alongside.
    if (ch.hasFEC) {
      const recovered = ch.fecReceiver.addDataPacket(pkt.sequence, pkt.payload);
      if (recovered) {
        this.stats.fecRecoveries++;
        const payloads = ch.receiveSeq(recovered.missingSeq, recovered.payload, true);
        for (const p of payloads) results.push({ channel: pkt.channel, payload: p });
      }
    }

    return results;
  }

  /**
   * Tick — call periodically to flush retransmits and evaluate congestion.
   * Returns encoded packets to send.
   */
  tick(now: number): ArrayBuffer[] {
    const result: ArrayBuffer[] = [];

    // Retransmit check
    for (const ch of this.channels) {
      for (const pkt of ch.getRetransmits(now)) {
        const { ackSeq, ackBitfield } = ch.getAckState();
        const encoded = encodePacket({
          channel: ch.channel, flags: PacketFlags.NORMAL,
          sequence: pkt.seq, ackSeq, ackBitfield, payload: pkt.payload,
        });
        result.push(encoded);
        this.stats.retransmits++;
        this.stats.bytesSent += encoded.byteLength;
      }
    }

    // Evaluate congestion
    this.congestion.evaluate(now);

    // Update stats (fecRecoveries is incremented inline in receive())
    this.stats.rtt = this.channels[Channel.RELIABLE].getRTT();
    this.stats.lossRate = this.congestion.lossRate;
    this.stats.quality = this.congestion.quality;
    this.stats.estimatedBandwidth = this.congestion.estimatedBandwidth;
    this.stats.goodputBps = this.congestion.goodputBps;
    this.stats.snapshotInterval = this.congestion.snapshotInterval;

    return result;
  }

  /** Get current connection quality tier */
  getQuality(): QualityTier { return this.congestion.quality; }

  getStats(): ARCnetStats { return { ...this.stats }; }

  reset(): void {
    this.channels = this.buildChannels();
    this.congestion.reset();
    this.stats.fecRecoveries = 0;
  }
}
