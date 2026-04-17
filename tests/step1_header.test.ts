/**
 * Step 1 — header layout + version nibble.
 *
 * These tests target D1 (header overlap bug) and verify the new 10-byte
 * header with a 4-bit wire version nibble in byte 1 low bits.
 *
 * New byte-1 layout: [channel:2][kind:2][version:4]
 */

import { describe, it, expect } from 'vitest';
import {
  ARCNET_HEADER_SIZE,
  ARCNET_WIRE_VERSION,
  Channel,
  PacketFlags,
  encodePacket,
  decodePacket,
} from '../src/ARCnet';

describe('Step 1 — header size', () => {
  it('header is 10 bytes', () => {
    expect(ARCNET_HEADER_SIZE).toBe(10);
  });
});

describe('Step 1 — random round-trip (catches D1)', () => {
  it('round-trips 1000 random packets with full u16 ackSeq + full u32 ackBitfield', () => {
    for (let i = 0; i < 1000; i++) {
      const channelVals = [Channel.CRITICAL, Channel.RELIABLE, Channel.SEQUENCED, Channel.VOLATILE];
      const flagVals = [PacketFlags.NORMAL, PacketFlags.FEC_PARITY, PacketFlags.CONTINUE];
      const payloadLen = Math.floor(Math.random() * 64);
      const payload = new Uint8Array(payloadLen);
      for (let j = 0; j < payloadLen; j++) payload[j] = Math.floor(Math.random() * 256);

      const pkt = {
        channel: channelVals[Math.floor(Math.random() * 4)],
        flags: flagVals[Math.floor(Math.random() * 3)],
        sequence: Math.floor(Math.random() * 0x10000),
        ackSeq: Math.floor(Math.random() * 0x10000),
        ackBitfield: (Math.floor(Math.random() * 0x100000000)) >>> 0,
        payload: payload.buffer as ArrayBuffer,
      };
      const decoded = decodePacket(encodePacket(pkt));
      expect(decoded).not.toBeNull();
      expect(decoded!.channel).toBe(pkt.channel);
      expect(decoded!.flags).toBe(pkt.flags);
      expect(decoded!.sequence).toBe(pkt.sequence);
      expect(decoded!.ackSeq).toBe(pkt.ackSeq);
      expect(decoded!.ackBitfield).toBe(pkt.ackBitfield);
      expect(new Uint8Array(decoded!.payload)).toEqual(payload);
    }
  });

  it('specific D1-exposing case: ackSeq=0x1234, ackBitfield=0xDEADBEEF', () => {
    const decoded = decodePacket(encodePacket({
      channel: Channel.CRITICAL,
      flags: PacketFlags.NORMAL,
      sequence: 999,
      ackSeq: 0x1234,
      ackBitfield: 0xDEADBEEF,
      payload: new ArrayBuffer(0),
    }));
    expect(decoded!.ackSeq).toBe(0x1234);
    expect(decoded!.ackBitfield).toBe(0xDEADBEEF);
  });

  it('sweeps ackSeq high byte while ackBitfield is non-zero', () => {
    // Before Step 1, this fails: the low byte of ackBitfield (0xCD) overwrites
    // the high byte of ackSeq on the wire, so ackSeq decodes as 0xCDnn.
    for (let hi = 0; hi <= 0xFF; hi++) {
      const ackSeq = (hi << 8) | 0x42;
      const decoded = decodePacket(encodePacket({
        channel: Channel.RELIABLE,
        flags: PacketFlags.NORMAL,
        sequence: 0,
        ackSeq,
        ackBitfield: 0xABCDEF01,
        payload: new ArrayBuffer(0),
      }));
      expect(decoded!.ackSeq).toBe(ackSeq);
    }
  });
});

describe('Step 1 — version nibble', () => {
  it('encodes the current wire version into byte 1 low nibble', () => {
    const encoded = encodePacket({
      channel: Channel.RELIABLE,
      flags: PacketFlags.NORMAL,
      sequence: 0,
      ackSeq: 0,
      ackBitfield: 0,
      payload: new ArrayBuffer(0),
    });
    const byte1 = new Uint8Array(encoded)[1];
    expect(byte1 & 0xF).toBe(ARCNET_WIRE_VERSION);
  });

  it('rejects packets with a different version (forward-compat safety)', () => {
    const encoded = encodePacket({
      channel: Channel.RELIABLE,
      flags: PacketFlags.NORMAL,
      sequence: 0,
      ackSeq: 0,
      ackBitfield: 0,
      payload: new ArrayBuffer(0),
    });
    const bytes = new Uint8Array(encoded.slice(0));
    // Corrupt version to something other than ARCNET_WIRE_VERSION
    const corrupted = (ARCNET_WIRE_VERSION + 1) & 0xF;
    bytes[1] = (bytes[1] & 0xF0) | corrupted;
    expect(decodePacket(bytes.buffer as ArrayBuffer)).toBeNull();
  });

  it('channel and flags survive version being packed into byte 1', () => {
    for (const channel of [Channel.CRITICAL, Channel.RELIABLE, Channel.SEQUENCED, Channel.VOLATILE]) {
      for (const flags of [PacketFlags.NORMAL, PacketFlags.FEC_PARITY, PacketFlags.CONTINUE]) {
        const decoded = decodePacket(encodePacket({
          channel, flags,
          sequence: 0, ackSeq: 0, ackBitfield: 0,
          payload: new ArrayBuffer(0),
        }));
        expect(decoded!.channel).toBe(channel);
        expect(decoded!.flags).toBe(flags);
      }
    }
  });
});
