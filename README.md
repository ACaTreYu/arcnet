# ARCnet

**Custom reliability protocol for real-time arena combat.**

A tiny, transport-agnostic protocol layer that gives you sequencing, selective-ACK retransmit, forward-error correction, and adaptive congestion control — on top of anything that moves bytes (WebRTC DataChannels, WebSockets, raw UDP).

Built for and battle-tested in the [Arcbound game](https://arcboundinteractive.com/arcbound.html) where 60 Hz input and state snapshots need to survive lossy mobile networks.

## What it does

| Problem | ARCnet's answer |
|---|---|
| Out-of-order packets | 16-bit per-channel sequence |
| Lost packets | Selective-ACK bitfield + per-channel retransmit |
| Bursty loss | XOR-based forward error correction (one recovery packet per N data packets) |
| Congestion | Loss/RTT monitoring → `GOOD`/`FAIR`/`POOR` quality tier callers can throttle on |
| Channel contention | Separate sequence spaces per channel (input, state, chat, etc.) |

## Packet format

9-byte header:

```
Byte 0:    [MAGIC: 0xAC]
Byte 1:    [channel:2b][flags:6b]
Bytes 2-3: [sequence:u16]       — per-channel outgoing sequence
Bytes 4-5: [ackSeq:u16]         — highest received seq from peer
Bytes 6-9: [ackBitfield:u32]    — bit N = "I received (ackSeq - N)"
```

FEC packets set a flag bit; their payload is the XOR of the previous N data packets in the group. The receiver can reconstruct any single lost packet from that group without a round trip.

## Files

- `src/ARCnet.ts` — the core protocol (sequencing, ACKs, retransmit, FEC, congestion control)
- `src/ARCnetBinaryInput.ts` — compact binary encoding for game input packets (80–85% size reduction vs JSON). Included as a demonstration of a packed application-level codec riding on top of ARCnet.

## Usage

ARCnet is transport-agnostic. You wire it to whatever channel you have:

```ts
import { ARCnetPeer } from 'arcnet';

const peer = new ARCnetPeer({
  send: (bytes) => webrtcChannel.send(bytes),
  onReceive: (channel, bytes) => handleMessage(channel, bytes),
});

// Incoming bytes from the transport:
webrtcChannel.onmessage = (e) => peer.ingest(new Uint8Array(e.data));

// Send on a channel:
peer.send(Channel.INPUT, payload);

// Check congestion:
if (peer.quality === 'POOR') throttleSnapshots();
```

(Public API described in `src/ARCnet.ts` — see the exports.)

## Build

```bash
npm install
npm run build     # emits dist/ via tsc
```

## Status

- **v3** — FEC, congestion tiers, field-level deltas (Apr 2026)
- v2 — UDP protocol, snapshot interpolation
- v1 — basic framing + ACKs

## License

MIT
