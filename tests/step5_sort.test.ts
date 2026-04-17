/**
 * Step 5 — Wrap-aware delivery-queue overflow sort.
 *
 * Target: D7 — when the CRITICAL delivery queue exceeds 32 entries without the
 * head filling, the flush path sorts keys with a naive `a - b` comparator.
 * Near the u16 wrap boundary (e.g., seqs 65534, 65535, 0, 1, 2), naive numeric
 * sort puts 0 after 65535 when they should be adjacent, producing out-of-order
 * delivery on the very channel that promises ordering.
 */

import { describe, it, expect } from 'vitest';
import { Channel, PacketFlags, encodePacket, ARCnetSession } from '../src/ARCnet';

function makeDataPacket(seq: number, valueByte: number): ArrayBuffer {
  return encodePacket({
    channel: Channel.CRITICAL,
    flags: PacketFlags.NORMAL,
    sequence: seq,
    ackSeq: 0,
    ackBitfield: 0,
    payload: new Uint8Array([valueByte]).buffer as ArrayBuffer,
  });
}

const SEQ_MAX = 0x10000;
function modDist(a: number, b: number): number {
  return (a - b + SEQ_MAX) % SEQ_MAX;
}

describe('Step 5 — CRITICAL queue overflow flush preserves modular seq order across wrap', () => {
  it('33 out-of-order packets spanning the u16 wrap flush in modular order', () => {
    const b = new ARCnetSession();
    const delivered: number[] = [];

    // Anchor: deliver seq=65510 first. Sets nextDeliverSeq = 65511.
    // Leave seq=65511 as a permanent gap (never send it) so the queue can't
    // drain through the happy path.
    const anchor = 65510;
    b.receive(makeDataPacket(anchor, 0));

    // Queue 33 entries at seqs 65512..65535, 0..8 — spans the u16 wrap.
    const queuedSeqs: number[] = [];
    for (let i = 0; i < 33; i++) queuedSeqs.push((anchor + 2 + i) & 0xFFFF);

    // Ensure insertion order is NOT already modular-sorted, so the overflow
    // path's sort actually does work (and exercise D7). Reverse order suffices.
    const insertOrder = [...queuedSeqs].reverse();

    for (let i = 0; i < insertOrder.length; i++) {
      const s = insertOrder[i];
      const r = b.receive(makeDataPacket(s, s & 0xFF));
      if (r) for (const d of r) delivered.push(new Uint8Array(d.payload)[0]);
    }

    // Expected: modular-sorted order anchored on nextDeliverSeq=65511.
    const nextDeliverSeq = 65511;
    const expectedSeqs = [...queuedSeqs].sort((a, b) => modDist(a, nextDeliverSeq) - modDist(b, nextDeliverSeq));
    const expectedValues = expectedSeqs.map(s => s & 0xFF);

    expect(delivered).toEqual(expectedValues);
  });
});
