/**
 * Step 2 — FEC rewrite: missing-seq tracking + wrap-safe groups + length-prefix.
 *
 * Targets D2 (recovery delivered under wrong seq), D4 (group index breaks at
 * u16 wrap), D5 (variable-length payload recovery produces wrong-length output).
 *
 * Parity payload format (Step 2+):
 *   [seq0:u16 LE][seq1:u16 LE][seq2:u16 LE][xor of length-prefixed payloads]
 */

import { describe, it, expect } from 'vitest';
import {
  Channel,
  PacketFlags,
  ARCnetSession,
  encodePacket,
} from '../src/ARCnet';

// ─── Test helpers: manually construct parity packets for specific seq groups ───

function makeDataPacket(channel: Channel, seq: number, payload: ArrayBuffer): ArrayBuffer {
  return encodePacket({
    channel,
    flags: PacketFlags.NORMAL,
    sequence: seq,
    ackSeq: 0,
    ackBitfield: 0,
    payload,
  });
}

/** Build an FEC parity packet covering exactly the given 3 seqs/payloads. */
function makeParityPacket(
  channel: Channel,
  seqs: [number, number, number],
  payloads: [ArrayBuffer, ArrayBuffer, ArrayBuffer],
): ArrayBuffer {
  const maxEncoded = Math.max(...payloads.map(p => 2 + p.byteLength));
  const parityPayload = new Uint8Array(6 + maxEncoded);
  const view = new DataView(parityPayload.buffer);
  view.setUint16(0, seqs[0], true);
  view.setUint16(2, seqs[1], true);
  view.setUint16(4, seqs[2], true);
  for (let i = 0; i < 3; i++) {
    const len = payloads[i].byteLength;
    parityPayload[6] ^= len & 0xFF;
    parityPayload[7] ^= (len >> 8) & 0xFF;
    const src = new Uint8Array(payloads[i]);
    for (let j = 0; j < src.length; j++) parityPayload[6 + 2 + j] ^= src[j];
  }
  return encodePacket({
    channel,
    flags: PacketFlags.FEC_PARITY,
    sequence: seqs[2],
    ackSeq: 0,
    ackBitfield: 0,
    payload: parityPayload.buffer as ArrayBuffer,
  });
}

function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function drainDelivered(result: any): Uint8Array[] {
  if (!result) return [];
  return result.map((r: any) => new Uint8Array(r.payload));
}

// ─── D2 — recovery delivered under correct (missing) seq ───────────

describe('Step 2 — FEC recovery uses the missing seq, not the parity seq', () => {
  it('recovers middle packet of a 3-packet group on RELIABLE', () => {
    const b = new ARCnetSession();

    const p0 = buf(10);
    const p1 = buf(20);
    const p2 = buf(30);

    // Peer sent seqs 0, 1, 2. Middle (seq=1) is dropped.
    const delivered: Uint8Array[] = [];
    const push = (r: any) => { for (const d of drainDelivered(r)) delivered.push(d); };

    push(b.receive(makeDataPacket(Channel.RELIABLE, 0, p0)));
    // seq=1 dropped
    push(b.receive(makeDataPacket(Channel.RELIABLE, 2, p2)));
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], [p0, p1, p2])));

    // Expect payloads 10, 30, 20 delivered (order: 0, 2, then recovered 1)
    expect(delivered).toHaveLength(3);
    const values = delivered.map(d => d[0]);
    expect(values).toContain(10);
    expect(values).toContain(20);
    expect(values).toContain(30);

    // The recovered payload should match seq=1's original content exactly
    // (not garbage that happens to match seq=2 or zeros from seq=0 padding)
    expect(b.getStats().fecRecoveries).toBe(1);
  });

  it('recovers on CRITICAL and delivers in correct order', () => {
    // Opt in to CRITICAL FEC — default has it off.
    const b = new ARCnetSession({ fec: [true, true, true, false] });
    const payloads: ArrayBuffer[] = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      for (const d of drainDelivered(r)) delivered.push(d[0]);
    };

    push(b.receive(makeDataPacket(Channel.CRITICAL, 0, payloads[0])));
    // seq=1 dropped
    push(b.receive(makeDataPacket(Channel.CRITICAL, 2, payloads[2])));
    // At this point CRITICAL buffers seq=2 waiting for seq=1; delivered = [1]
    expect(delivered).toEqual([1]);

    push(b.receive(makeParityPacket(Channel.CRITICAL, [0, 1, 2], payloads as any)));

    // Now seq=1 recovered fills the gap, and seq=2 flushes behind it
    expect(delivered).toEqual([1, 2, 3]);
    expect(b.getStats().fecRecoveries).toBe(1);
  });

  it('parity arriving before all data packets still recovers when the last one arrives', () => {
    const b = new ARCnetSession();
    const payloads = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      for (const d of drainDelivered(r)) delivered.push(d[0]);
    };

    // Parity first, then data[0], data[2]. Middle (seq=1) never arrives.
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], payloads as any)));
    push(b.receive(makeDataPacket(Channel.RELIABLE, 0, payloads[0])));
    // At this point pending parity has 1 known (seq=0), 2 missing. Can't recover.
    expect(delivered).toEqual([1]);

    push(b.receive(makeDataPacket(Channel.RELIABLE, 2, payloads[2])));
    // Now: data[0], data[2] present, data[1] missing. Parity recovers data[1].
    expect(delivered).toContain(2);
    expect(delivered).toContain(3);
    expect(delivered).toHaveLength(3);
    expect(b.getStats().fecRecoveries).toBe(1);
  });

  it('does not recover when 2+ packets in the group are missing', () => {
    const b = new ARCnetSession();
    const payloads = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      for (const d of drainDelivered(r)) delivered.push(d[0]);
    };

    push(b.receive(makeDataPacket(Channel.RELIABLE, 0, payloads[0])));
    // seq=1, seq=2 both dropped
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], payloads as any)));

    // Only the data packet was delivered; parity can't fix 2 losses
    expect(delivered).toEqual([1]);
    expect(b.getStats().fecRecoveries).toBe(0);
  });
});

// ─── D4 — wrap safety ────────────────────────────────────────────

describe('Step 2 — FEC works across u16 sequence wrap', () => {
  it('recovers a packet whose seq is 0 when group spans 65534, 65535, 0', () => {
    const b = new ARCnetSession();
    const payloads = [buf(111), buf(222), buf(33)];

    const delivered: number[] = [];
    const push = (r: any) => {
      for (const d of drainDelivered(r)) delivered.push(d[0]);
    };

    push(b.receive(makeDataPacket(Channel.RELIABLE, 65534, payloads[0])));
    push(b.receive(makeDataPacket(Channel.RELIABLE, 65535, payloads[1])));
    // seq=0 dropped
    push(b.receive(makeParityPacket(Channel.RELIABLE, [65534, 65535, 0], payloads as any)));

    // Should deliver 111, 222, and recovered 33
    expect(delivered).toHaveLength(3);
    expect(delivered).toContain(111);
    expect(delivered).toContain(222);
    expect(delivered).toContain(33);
    expect(b.getStats().fecRecoveries).toBe(1);
  });

  it('recovers when missing seq is 65535 mid-wrap', () => {
    const b = new ARCnetSession();
    const payloads = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      for (const d of drainDelivered(r)) delivered.push(d[0]);
    };

    push(b.receive(makeDataPacket(Channel.RELIABLE, 65534, payloads[0])));
    // seq=65535 dropped
    push(b.receive(makeDataPacket(Channel.RELIABLE, 0, payloads[2])));
    push(b.receive(makeParityPacket(Channel.RELIABLE, [65534, 65535, 0], payloads as any)));

    expect(delivered).toHaveLength(3);
    expect(b.getStats().fecRecoveries).toBe(1);
  });
});

// ─── D5 — mixed-length recovery ──────────────────────────────────

describe('Step 2 — FEC recovers variable-length payloads with correct length', () => {
  it('recovers a short missing packet when other packets in group are larger', () => {
    const b = new ARCnetSession();
    const small = buf(42);                                  // 1 byte
    const medium = new Uint8Array(20).fill(7).buffer as ArrayBuffer;  // 20 bytes
    const large = new Uint8Array(50).fill(9).buffer as ArrayBuffer;   // 50 bytes
    const payloads = [small, medium, large];

    const delivered: ArrayBuffer[] = [];
    const push = (r: any) => { if (r) for (const d of r) delivered.push(d.payload); };

    // Drop the small one (seq=0), keep medium (seq=1) and large (seq=2)
    push(b.receive(makeDataPacket(Channel.RELIABLE, 1, medium)));
    push(b.receive(makeDataPacket(Channel.RELIABLE, 2, large)));
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], payloads as any)));

    // Find the recovered one (1-byte payload matching `small`)
    const recovered = delivered.find(p => p.byteLength === 1);
    expect(recovered).toBeDefined();
    expect(new Uint8Array(recovered!)[0]).toBe(42);
    // Assert it's EXACTLY 1 byte, not padded to 50
    expect(recovered!.byteLength).toBe(1);
  });

  it('recovers a long missing packet when others are shorter', () => {
    const b = new ARCnetSession();
    const short1 = buf(1);
    const short2 = buf(2);
    const long = new Uint8Array(100);
    for (let i = 0; i < 100; i++) long[i] = i;
    const longBuf = long.buffer as ArrayBuffer;
    const payloads = [short1, short2, longBuf];

    const delivered: ArrayBuffer[] = [];
    const push = (r: any) => { if (r) for (const d of r) delivered.push(d.payload); };

    push(b.receive(makeDataPacket(Channel.RELIABLE, 0, short1)));
    push(b.receive(makeDataPacket(Channel.RELIABLE, 1, short2)));
    // Drop the long one (seq=2)
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], payloads as any)));

    const recovered = delivered.find(p => p.byteLength === 100);
    expect(recovered).toBeDefined();
    expect(new Uint8Array(recovered!)).toEqual(long);
  });

  it('recovers an empty payload when one member of group is empty', () => {
    const b = new ARCnetSession();
    const empty = new ArrayBuffer(0);
    const one = buf(11);
    const two = buf(22);
    const payloads = [empty, one, two];

    const delivered: ArrayBuffer[] = [];
    const push = (r: any) => { if (r) for (const d of r) delivered.push(d.payload); };

    // Drop the empty one (seq=0)
    push(b.receive(makeDataPacket(Channel.RELIABLE, 1, one)));
    push(b.receive(makeDataPacket(Channel.RELIABLE, 2, two)));
    push(b.receive(makeParityPacket(Channel.RELIABLE, [0, 1, 2], payloads as any)));

    // Three deliveries: one, two, recovered empty
    expect(delivered).toHaveLength(3);
    const recovered = delivered.find(p => p.byteLength === 0);
    expect(recovered).toBeDefined();
  });
});

// ─── SEQUENCED channel FEC delivery semantics ───────────────────

describe('Step 2 — FEC recovery on SEQUENCED delivers despite "newer already arrived"', () => {
  it('recovered older snapshot is still delivered for app-level reconciliation', () => {
    const b = new ARCnetSession();
    const payloads = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      if (r) for (const d of r) delivered.push(new Uint8Array(d.payload)[0]);
    };

    push(b.receive(makeDataPacket(Channel.SEQUENCED, 0, payloads[0])));
    // seq=1 dropped
    push(b.receive(makeDataPacket(Channel.SEQUENCED, 2, payloads[2])));
    // At this point SEQUENCED has latestReceivedSeq=2. The recovered seq=1 is "older".
    // With the fix: it still gets delivered (app handles reconciliation via app-level seq).
    push(b.receive(makeParityPacket(Channel.SEQUENCED, [0, 1, 2], payloads as any)));

    expect(delivered).toHaveLength(3);
    expect(delivered).toContain(2); // the recovered one
    expect(b.getStats().fecRecoveries).toBe(1);
  });
});

// ─── Dedup: CRITICAL channel, real packet arrives after FEC recovery ─────

describe('Step 2 — late real packet after FEC recovery is not re-delivered on CRITICAL', () => {
  it('does not re-deliver the seq that was already FEC-recovered', () => {
    const b = new ARCnetSession({ fec: [true, true, true, false] });
    const payloads = [buf(1), buf(2), buf(3)];

    const delivered: number[] = [];
    const push = (r: any) => {
      if (r) for (const d of r) delivered.push(new Uint8Array(d.payload)[0]);
    };

    push(b.receive(makeDataPacket(Channel.CRITICAL, 0, payloads[0])));
    push(b.receive(makeDataPacket(Channel.CRITICAL, 2, payloads[2])));
    push(b.receive(makeParityPacket(Channel.CRITICAL, [0, 1, 2], payloads as any)));

    // 1, 2, 3 delivered in order
    expect(delivered).toEqual([1, 2, 3]);

    // Now the real seq=1 arrives late
    push(b.receive(makeDataPacket(Channel.CRITICAL, 1, payloads[1])));

    // Should NOT re-deliver seq=1
    expect(delivered).toEqual([1, 2, 3]);
  });
});
