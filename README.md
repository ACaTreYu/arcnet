# ARCnet

**Custom reliability protocol for real-time multiplayer combat.**

A tiny, transport-agnostic protocol layer that gives you sequencing, selective-ACK retransmit, forward-error correction, and adaptive congestion control — on top of anything that moves bytes (WebRTC DataChannels, WebSockets, raw UDP).

Built for and battle-tested in the [Arcbound game](https://arcboundinteractive.com/arcbound.html) where 60 Hz input and state snapshots need to survive lossy mobile networks.

## What it does

| Problem | ARCnet's answer |
|---|---|
| Out-of-order packets | 16-bit per-channel sequence |
| Lost packets | Selective-ACK bitfield + per-channel retransmit |
| Bursty loss | XOR-based forward error correction (one recovery packet per N data packets) |
| Congestion | Loss/RTT monitoring → `GOOD`/`FAIR`/`POOR` quality tier callers can throttle on |
| Channel contention | Separate sequence spaces per channel (critical, reliable, sequenced, volatile) |
| Small-packet overhead | Optional per-tick **batching** — multiple packets fused under `ARCNET_BATCH_MAGIC` (0xAB) and split on the receive side via `unbatchPackets()` |

## Packet format

10-byte header:

```
Byte 0     : [MAGIC: 0xAC]
Byte 1     : [channel:2b (bits 7-6)][kind:2b (bits 5-4)][version:4b (bits 3-0)]
Bytes 2-3  : [sequence:u16 LE]       — per-channel outgoing sequence
Bytes 4-5  : [ackSeq:u16 LE]         — highest received seq from peer
Bytes 6-9  : [ackBitfield:u32 LE]    — bit N = "I received (ackSeq − N − 1)"
```

The version nibble in byte 1 lets decoders reject unknown wire formats cleanly (current wire version: `1`).

### FEC packet payload

When `kind = FEC_PARITY`, the packet payload carries:

```
Bytes 0-5  : [seq0:u16 LE][seq1:u16 LE][seq2:u16 LE]   — seqs covered by this parity
Bytes 6+   : XOR of (u16 LE length + payload) for each of the three data packets,
             zero-padded to the max encoded length in the group
```

Seq tags make recovery wrap-safe and let the receiver deliver the recovered packet under its true sequence number. Length-prefixing preserves original payload sizes when the group contains variable-length packets.

## Files

- `src/ARCnet.ts` — the core protocol (sequencing, ACKs, retransmit, FEC, batching, congestion control)
- `src/ARCnetBinaryInput.ts` — compact binary encoding for game input packets (80–85% size reduction vs JSON). Included as a demonstration of a packed application-level codec riding on top of ARCnet.

The core protocol is the package's main entry (`import { ARCnetSession } from 'arcnet'`). The binary codec is not re-exported from the root — import it directly from its subpath when you need it:

```ts
import { encodeBinaryInput, decodeBinaryInput } from 'arcnet/dist/ARCnetBinaryInput';
```

## Usage

ARCnet is transport-agnostic. You wire it to whatever channel you have:

```ts
import { ARCnetSession, Channel, QualityTier } from 'arcnet';

const session = new ARCnetSession();

// Incoming bytes from the transport:
webrtcChannel.onmessage = (e) => {
  const delivered = session.receive(e.data);
  if (delivered) {
    for (const { channel, payload } of delivered) {
      handleMessage(channel, payload);
    }
  }
};

// Send on a channel — returns an array of buffers (data + optional FEC parity):
for (const buf of session.send(Channel.SEQUENCED, payload)) {
  webrtcChannel.send(buf);
}

// Tick periodically to flush retransmits and evaluate congestion:
setInterval(() => {
  for (const buf of session.tick(Date.now())) webrtcChannel.send(buf);
}, 50);

// Check congestion:
if (session.getQuality() === QualityTier.POOR) throttleSnapshots();

// Or use the continuously adaptive snapshot interval:
const intervalMs = session.getStats().snapshotInterval; // 30–90 ms

// RTT percentiles for jitter / tail-latency signals (populated after a few samples):
const { rttP50, rttP95, rttP99 } = session.getStats();
```

Optional config — enable FEC per channel. Defaults: `[CRITICAL=false, RELIABLE=true, SEQUENCED=true, VOLATILE=false]`.

```ts
const session = new ARCnetSession({ fec: [true, true, true, false] });
```

(Public API described in `src/ARCnet.ts` — see the exports.)

## Build and test

```bash
npm install
npm run build       # emits dist/ via tsc (CommonJS — works for both ESM `import` and CJS `require()` consumers)
npm test            # vitest run — round-trip, FEC, wrap, congestion, percentiles
npm run typecheck   # tsc --noEmit
```

## Status

- **v3** — FEC (seq-tagged, length-prefixed), adaptive snapshot interval, wrap-safe header v1, RTT percentile stats (p50/p95/p99), packet batching + `unbatchPackets`, CommonJS build for Node consumers (Apr 2026)
- v2 — UDP protocol, snapshot interpolation
- v1 — basic framing + ACKs

## License

MIT
