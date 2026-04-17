/**
 * Step 3 — send() actually emits FEC.
 *
 * The old send() returned a single ArrayBuffer and silently discarded parity
 * packets that sendWithFEC would have emitted. After this step, send() returns
 * ArrayBuffer[] — always 1 element for non-FEC channels, 1 or 2 for FEC channels
 * (2 when a group just completed and a parity packet was generated).
 */

import { describe, it, expect } from 'vitest';
import {
  Channel,
  PacketFlags,
  ARCnetSession,
  decodePacket,
} from '../src/ARCnet';

function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

describe('Step 3 — send() returns ArrayBuffer[]', () => {
  it('returns [data] on non-FEC channel (VOLATILE)', () => {
    const a = new ARCnetSession();
    const result = a.send(Channel.VOLATILE, buf(1));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('returns [data] for packets 1 and 2 on an FEC channel (group not full)', () => {
    const a = new ARCnetSession();
    expect(a.send(Channel.RELIABLE, buf(1))).toHaveLength(1);
    expect(a.send(Channel.RELIABLE, buf(2))).toHaveLength(1);
  });

  it('returns [data, parity] on the 3rd packet of an FEC group', () => {
    const a = new ARCnetSession();
    a.send(Channel.RELIABLE, buf(1));
    a.send(Channel.RELIABLE, buf(2));
    const result = a.send(Channel.RELIABLE, buf(3));
    expect(result).toHaveLength(2);

    const data = decodePacket(result[0]);
    const parity = decodePacket(result[1]);
    expect(data!.flags).toBe(PacketFlags.NORMAL);
    expect(parity!.flags).toBe(PacketFlags.FEC_PARITY);
  });

  it('over 6 sends on an FEC channel: emits 6 data + 2 parity = 8 total packets', () => {
    const a = new ARCnetSession();
    let total = 0;
    for (let i = 0; i < 6; i++) {
      total += a.send(Channel.RELIABLE, buf(i)).length;
    }
    expect(total).toBe(8);
  });
});

describe('Step 3 — send() parity enables end-to-end FEC recovery', () => {
  it('delivering data+parity from send() recovers a dropped middle packet', () => {
    const a = new ARCnetSession();
    const b = new ARCnetSession();

    const pkt0 = a.send(Channel.RELIABLE, buf(10));
    const pkt1 = a.send(Channel.RELIABLE, buf(20));
    const pkt2 = a.send(Channel.RELIABLE, buf(30));
    // pkt0, pkt1 are [data]; pkt2 is [data, parity]

    const delivered: number[] = [];
    const recvAll = (bufs: ArrayBuffer[]) => {
      for (const buffer of bufs) {
        const r = b.receive(buffer);
        if (r) for (const d of r) delivered.push(new Uint8Array(d.payload)[0]);
      }
    };

    recvAll(pkt0);
    // drop pkt1 (the middle data packet — seq=1)
    recvAll(pkt2); // data seq=2 delivered; parity triggers recovery of seq=1

    expect(delivered).toHaveLength(3);
    expect(delivered).toContain(10);
    expect(delivered).toContain(20);
    expect(delivered).toContain(30);
    expect(b.getStats().fecRecoveries).toBe(1);
  });
});
