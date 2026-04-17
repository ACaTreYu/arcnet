/**
 * Step 4 — Loss rate driven by real peer ACKs, not by raw receive count.
 *
 * Target: D6 — the old lossRate formula treated every received packet as an
 * "ACK" regardless of whether it actually acknowledged outstanding outbound
 * packets, which broke under asymmetric traffic.
 */

import { describe, it, expect } from 'vitest';
import { Channel, ARCnetSession } from '../src/ARCnet';

function drainSend(sender: ARCnetSession, receiver: ARCnetSession, channel: Channel, value: number) {
  const p = new Uint8Array([value]).buffer as ArrayBuffer;
  for (const buf of sender.send(channel, p)) {
    receiver.receive(buf);
  }
}

describe('Step 4 — lossRate with symmetric bidirectional traffic is ~0', () => {
  it('30 CRITICAL packets fully ACKed yields lossRate near 0', () => {
    const a = new ARCnetSession();
    const b = new ARCnetSession();

    for (let i = 0; i < 30; i++) drainSend(a, b, Channel.CRITICAL, i);
    // B responds with one packet — its header carries ACK for everything received.
    drainSend(b, a, Channel.CRITICAL, 99);

    a.tick(10_000); // force congestion evaluate
    expect(a.getStats().lossRate).toBeGreaterThanOrEqual(0);
    expect(a.getStats().lossRate).toBeLessThan(0.05);
  });
});

describe('Step 4 — asymmetric traffic does not inflate lossRate (D6)', () => {
  it('A sends 10, B sends 100 — A.lossRate stays in [0, 1) and near 0', () => {
    const a = new ARCnetSession();
    const b = new ARCnetSession();

    // A sends a small burst
    for (let i = 0; i < 10; i++) drainSend(a, b, Channel.CRITICAL, i);
    // B floods (asymmetric — like a 60Hz snapshot stream vs 5Hz input)
    for (let i = 0; i < 100; i++) drainSend(b, a, Channel.CRITICAL, 100 + i);

    a.tick(10_000);
    const stats = a.getStats();

    // Pre-fix: ackCount was incremented per received packet (100), sentCount=10,
    // lossRate = 1 - 100/10 = -9.0 — a nonsensical value that would fail the
    // non-negativity assertion below.
    expect(stats.lossRate).toBeGreaterThanOrEqual(0);
    expect(stats.lossRate).toBeLessThanOrEqual(1);
    // With the fix, all of A's pending should have been cleared by B's responses.
    expect(stats.lossRate).toBeLessThan(0.05);
  });
});

describe('Step 4 — real loss shows up in lossRate', () => {
  it('peer never replies — all of A\'s sent packets remain unacked → lossRate=1', () => {
    const a = new ARCnetSession();
    const b = new ARCnetSession();

    // A sends, B receives, but B never sends back
    for (let i = 0; i < 20; i++) drainSend(a, b, Channel.CRITICAL, i);

    a.tick(10_000);
    // Cumulative lossRate = 1 − (acks/sent) = 1 − 0/20 = 1 (legitimate: A has no evidence of delivery)
    expect(a.getStats().lossRate).toBeCloseTo(1.0, 2);
  });
});
