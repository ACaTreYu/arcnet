/**
 * Step 8 — RTT distribution stats (p50 / p95 / p99).
 *
 * Adds jitter visibility to ARCnetStats so the caller can distinguish
 * "high but stable latency" (acceptable) from "oscillating latency" (needs
 * mitigation) — a distinction the GOOD/FAIR/POOR tier flattens.
 */

import { describe, it, expect } from 'vitest';
import { Channel, ARCnetSession } from '../src/ARCnet';

describe('Step 8 — ARCnetStats exposes rttP50, rttP95, rttP99', () => {
  it('the fields exist and are numbers', () => {
    const s = new ARCnetSession();
    const stats = s.getStats();
    expect(typeof stats.rttP50).toBe('number');
    expect(typeof stats.rttP95).toBe('number');
    expect(typeof stats.rttP99).toBe('number');
  });

  it('with no RTT samples, percentiles are 0', () => {
    const s = new ARCnetSession();
    s.tick(Date.now());
    const stats = s.getStats();
    expect(stats.rttP50).toBe(0);
    expect(stats.rttP95).toBe(0);
    expect(stats.rttP99).toBe(0);
  });
});

describe('Step 8 — percentiles are monotonically ordered', () => {
  it('p50 ≤ p95 ≤ p99 after a round-trip workload', () => {
    const a = new ARCnetSession();
    const b = new ARCnetSession();

    for (let i = 0; i < 20; i++) {
      for (const buf of a.send(Channel.CRITICAL, new Uint8Array([i]).buffer as ArrayBuffer)) {
        b.receive(buf);
      }
    }
    // B replies once — its header ACKs everything B received from A.
    for (const buf of b.send(Channel.CRITICAL, new Uint8Array([99]).buffer as ArrayBuffer)) {
      a.receive(buf);
    }
    a.tick(Date.now());

    const s = a.getStats();
    expect(s.rttP50).toBeLessThanOrEqual(s.rttP95);
    expect(s.rttP95).toBeLessThanOrEqual(s.rttP99);
    expect(s.rttP50).toBeGreaterThanOrEqual(0);
  });
});
