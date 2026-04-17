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

// ─── Packet Coalescence ─────────────────────────────────────────
//
// Multiple ARCnet packets batched into one DataChannel send.
// Reduces per-packet DTLS/SCTP overhead (~20-40 bytes per send).
// Format: [0xAB magic][u16 len][packet...][u16 len][packet...]...

/** Magic byte for coalesced/batched packet bundles */
export const ARCNET_BATCH_MAGIC = 0xAB;

/** Check if a buffer is a coalesced batch */
export function isBatchedPacket(data: ArrayBuffer | Buffer | Uint8Array): boolean {
  if (data.byteLength < 4) return false; // magic + at least one u16 len + 1 byte
  const first = data instanceof ArrayBuffer ? new Uint8Array(data)[0]
    : (data as any)[0];
  return first === ARCNET_BATCH_MAGIC;
}

/** Split a coalesced batch into individual packet buffers */
export function unbatchPackets(data: ArrayBuffer): ArrayBuffer[] {
  const view = new DataView(data);
  if (view.getUint8(0) !== ARCNET_BATCH_MAGIC) return [data]; // not batched

  const result: ArrayBuffer[] = [];
  let offset = 1; // skip magic
  while (offset + 2 <= data.byteLength) {
    const len = view.getUint16(offset, true);
    offset += 2;
    if (offset + len > data.byteLength) break; // truncated
    result.push(data.slice(offset, offset + len));
    offset += len;
  }
  return result;
}

// ─── FEC (Forward Error Correction) ─────────────────────────────
//
// XOR-based parity: every FEC_GROUP_SIZE data packets, emit 1 parity
// packet whose payload = XOR of the group. If any single packet in
// the group is lost, receiver XORs the parity with the received
// packets to reconstruct the missing one.

/** Number of data packets per FEC group (parity emitted after each group) */
const FEC_GROUP_SIZE = 3;

/** XOR two ArrayBuffers of potentially different lengths (zero-pads shorter) */
function xorBuffers(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const maxLen = Math.max(a.byteLength, b.byteLength);
  const result = new Uint8Array(maxLen);
  const aBytes = new Uint8Array(a);
  const bBytes = new Uint8Array(b);
  for (let i = 0; i < maxLen; i++) {
    result[i] = (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return result.buffer as ArrayBuffer;
}

interface FECGroupEntry {
  seq: number;
  payload: ArrayBuffer;
}

/** Sender-side FEC: accumulates packets and produces parity */
class FECSender {
  private group: FECGroupEntry[] = [];

  /** Add a data packet to the current group. Returns parity payload if group is complete. */
  addPacket(seq: number, payload: ArrayBuffer): ArrayBuffer | null {
    this.group.push({ seq, payload });
    if (this.group.length >= FEC_GROUP_SIZE) {
      // XOR all payloads in the group
      let parity = this.group[0].payload;
      for (let i = 1; i < this.group.length; i++) {
        parity = xorBuffers(parity, this.group[i].payload);
      }
      this.group = [];
      return parity;
    }
    return null;
  }

  reset(): void { this.group = []; }
}

/** Receiver-side FEC: tracks received packets per group, reconstructs on loss */
class FECReceiver {
  // Group tracking: group index → received packets + parity
  private groups: Map<number, {
    received: Map<number, ArrayBuffer>; // seq → payload
    parity: ArrayBuffer | null;
    startSeq: number;
  }> = new Map();

  /** Get the group index for a sequence number */
  private groupIndex(seq: number): number {
    return Math.floor(seq / FEC_GROUP_SIZE);
  }

  /** Record a received data packet. Returns reconstructed payload if FEC recovery happened. */
  addDataPacket(seq: number, payload: ArrayBuffer): ArrayBuffer | null {
    const gi = this.groupIndex(seq);
    let group = this.groups.get(gi);
    if (!group) {
      group = { received: new Map(), parity: null, startSeq: gi * FEC_GROUP_SIZE };
      this.groups.set(gi, group);
    }
    group.received.set(seq, payload);
    return this.tryRecover(gi);
  }

  /** Record a received parity packet. Returns reconstructed payload if FEC recovery happened. */
  addParityPacket(seq: number, parityPayload: ArrayBuffer): ArrayBuffer | null {
    const gi = this.groupIndex(seq);
    let group = this.groups.get(gi);
    if (!group) {
      group = { received: new Map(), parity: null, startSeq: gi * FEC_GROUP_SIZE };
      this.groups.set(gi, group);
    }
    group.parity = parityPayload;
    return this.tryRecover(gi);
  }

  /** Try to recover a missing packet. Returns recovered payload or null. */
  private tryRecover(gi: number): ArrayBuffer | null {
    const group = this.groups.get(gi);
    if (!group || !group.parity) return null;

    // Count how many data packets we're missing
    const expectedSeqs: number[] = [];
    for (let i = 0; i < FEC_GROUP_SIZE; i++) {
      expectedSeqs.push((group.startSeq + i) % SEQ_MAX);
    }

    const missing: number[] = [];
    for (const seq of expectedSeqs) {
      if (!group.received.has(seq)) missing.push(seq);
    }

    if (missing.length === 1) {
      // Can recover! XOR parity with all received packets
      let recovered = group.parity;
      for (const [, payload] of group.received) {
        recovered = xorBuffers(recovered, payload);
      }
      // Clean up group
      this.groups.delete(gi);
      return recovered;
    }

    if (missing.length === 0) {
      // All received, no recovery needed — clean up
      this.groups.delete(gi);
    }

    return null;
  }

  /** Prune old groups to prevent unbounded growth */
  prune(currentSeq: number): void {
    const currentGroup = this.groupIndex(currentSeq);
    const maxGroups = Math.floor(SEQ_MAX / FEC_GROUP_SIZE); // 21845 for u16
    for (const gi of this.groups.keys()) {
      // Modular distance handles u16 sequence wrap-around
      const age = ((currentGroup - gi + maxGroups) % maxGroups);
      if (age > 8) {
        this.groups.delete(gi);
      }
    }
  }

  reset(): void { this.groups.clear(); }
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

  /** Record an ACK was received */
  recordAck(rttSample?: number, bytes: number = 0): void {
    this.ackCount++;
    this.windowAcked++;
    this.windowBytesAcked += bytes;
    if (rttSample !== undefined && rttSample > 0) {
      this.rttSamples.push(rttSample);
      if (this.rttSamples.length > this.RTT_WINDOW) {
        this.rttSamples.shift();
      }
    }
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

  processAcks(peerAckSeq: number, peerAckBitfield: number, now: number): { rttSample?: number } {
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
    return { rttSample };
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
   * Process incoming sequence. Returns payloads to deliver (may be empty if stale/dup).
   */
  receiveSeq(seq: number, payload: ArrayBuffer): ArrayBuffer[] {
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

    // FEC: track received data packet for potential recovery
    if (this.fecEnabled) {
      this.fecReceiver.addDataPacket(seq, payload);
    }

    switch (this.channel) {
      case Channel.CRITICAL:
        return this.deliverOrdered(seq, payload);
      case Channel.RELIABLE:
        return [payload]; // unordered, deliver immediately
      case Channel.SEQUENCED:
        if (this.hasReceivedAny && !seqNewer(seq, this.latestReceivedSeq) && seq !== this.latestReceivedSeq) {
          return []; // stale
        }
        this.latestReceivedSeq = seq;
        return [payload];
      case Channel.VOLATILE:
        return [payload];
    }
    return [payload];
  }

  /** Process an FEC parity packet. Returns recovered payload or null. */
  receiveFECParity(seq: number, parityPayload: ArrayBuffer): ArrayBuffer | null {
    if (!this.fecEnabled) return null;
    return this.fecReceiver.addParityPacket(seq, parityPayload);
  }

  private deliverOrdered(seq: number, payload: ArrayBuffer): ArrayBuffer[] {
    this.deliveryQueue.set(seq, payload);
    const delivered: ArrayBuffer[] = [];
    while (this.deliveryQueue.has(this.nextDeliverSeq)) {
      delivered.push(this.deliveryQueue.get(this.nextDeliverSeq)!);
      this.deliveryQueue.delete(this.nextDeliverSeq);
      this.nextDeliverSeq = seqNext(this.nextDeliverSeq);
    }
    // Don't let delivery queue grow unbounded (gap too large = skip ahead)
    if (this.deliveryQueue.size > 32) {
      const seqs = [...this.deliveryQueue.keys()].sort((a, b) => a - b);
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

  pruneReceiverFEC(): void {
    if (this.fecEnabled) this.fecReceiver.prune(this.inHighest);
  }
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

export class ARCnetSession {
  private channels: ChannelState[];
  private congestion: CongestionController;
  private _fecRecoveries: number = 0;
  private stats: ARCnetStats = {
    rtt: 80, packetsSent: 0, packetsReceived: 0,
    retransmits: 0, bytesSent: 0, bytesReceived: 0,
    lossRate: 0, quality: QualityTier.GOOD, fecRecoveries: 0,
    estimatedBandwidth: 50000, goodputBps: 0, snapshotInterval: 30,
  };

  constructor() {
    this.channels = [
      new ChannelState(Channel.CRITICAL, false),    // ordered — FEC not useful (retransmit handles it)
      new ChannelState(Channel.RELIABLE, true),      // FEC on — fire events, instant recovery
      new ChannelState(Channel.SEQUENCED, true),     // FEC on — snapshots/input, smooth out hitches
      new ChannelState(Channel.VOLATILE, false),     // fire & forget — no FEC needed
    ];
    this.congestion = new CongestionController();
  }

  /**
   * Wrap payload in ARCnet framing for a given channel.
   * Returns array of encoded packets to send (1 data + optional 1 FEC parity).
   */
  sendWithFEC(channel: Channel, payload: ArrayBuffer): ArrayBuffer[] {
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

    // FEC: accumulate and emit parity when group is full
    if (ch.hasFEC) {
      const parityPayload = ch.fecSender.addPacket(seq, payload);
      if (parityPayload) {
        const parityPkt = encodePacket({
          channel, flags: PacketFlags.FEC_PARITY,
          sequence: seq, // parity tagged with last seq in group
          ackSeq, ackBitfield,
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
   * Wrap payload in ARCnet framing for a given channel.
   * Returns single encoded ArrayBuffer ready to send.
   * (Convenience method — does NOT emit FEC. Use sendWithFEC for FEC support.)
   */
  send(channel: Channel, payload: ArrayBuffer): ArrayBuffer {
    const packets = this.sendWithFEC(channel, payload);
    // Return only the data packet — FEC parity packets need separate sending
    return packets[0];
  }

  /**
   * Get any additional packets from the last send (FEC parity).
   * Call after send() to get parity packets that also need sending.
   */

  /**
   * Process received ARCnet packet.
   * Returns delivered payloads (may be 0 if stale, or >1 if ordered queue flushed).
   * Returns null if not a valid ARCnet packet (caller should handle as raw).
   */
  receive(buf: ArrayBuffer): Array<{ channel: Channel; payload: ArrayBuffer }> | null {
    const pkt = decodePacket(buf);
    if (!pkt) return null; // not ARCnet — pass through

    this.stats.packetsReceived++;
    this.stats.bytesReceived += buf.byteLength;

    const ch = this.channels[pkt.channel];
    const now = Date.now();

    // Process piggyback ACKs (peer acknowledging our outgoing packets)
    const { rttSample } = ch.processAcks(pkt.ackSeq, pkt.ackBitfield, now);
    this.congestion.recordAck(rttSample, buf.byteLength);

    // Handle FEC parity packets
    if (pkt.flags === PacketFlags.FEC_PARITY) {
      const recovered = ch.receiveFECParity(pkt.sequence, pkt.payload);
      if (recovered) {
        this._fecRecoveries++;
        // Deliver the recovered payload through the channel state machine
        const payloads = ch.receiveSeq(pkt.sequence, recovered);
        return payloads.map(p => ({ channel: pkt.channel, payload: p }));
      }
      return []; // parity received but no recovery needed yet
    }

    // Deliver payload through channel state machine
    const payloads = ch.receiveSeq(pkt.sequence, pkt.payload);
    return payloads.map(p => ({ channel: pkt.channel, payload: p }));
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
      // Prune old FEC receiver groups
      ch.pruneReceiverFEC();
    }

    // Evaluate congestion
    this.congestion.evaluate(now);

    // Update stats
    this.stats.rtt = this.channels[Channel.RELIABLE].getRTT();
    this.stats.lossRate = this.congestion.lossRate;
    this.stats.quality = this.congestion.quality;
    this.stats.fecRecoveries = this._fecRecoveries;
    this.stats.estimatedBandwidth = this.congestion.estimatedBandwidth;
    this.stats.goodputBps = this.congestion.goodputBps;
    this.stats.snapshotInterval = this.congestion.snapshotInterval;

    return result;
  }

  /** Get current connection quality tier */
  getQuality(): QualityTier { return this.congestion.quality; }

  getStats(): ARCnetStats { return { ...this.stats }; }

  reset(): void {
    this.channels = [
      new ChannelState(Channel.CRITICAL, false),
      new ChannelState(Channel.RELIABLE, true),
      new ChannelState(Channel.SEQUENCED, true),
      new ChannelState(Channel.VOLATILE, false),
    ];
    this.congestion.reset();
    this._fecRecoveries = 0;
  }
}
