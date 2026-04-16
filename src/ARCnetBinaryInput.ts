/**
 * ARCnet Binary Input Encoding
 *
 * Replaces JSON input/fire messages with compact binary packets.
 * Input: 100 bytes JSON → 20 bytes binary (80% reduction)
 * Fire:  110 bytes JSON → 16 bytes binary (85% reduction)
 *
 * Packet identification: first byte is a magic tag that distinguishes
 * binary input (0xA1) and fire (0xA2) packets from JSON messages and
 * existing binary state snapshots (which start with 0x01 msgType).
 */

/** Matches the host game's WeaponType union. Kept inline so this package is standalone. */
export type WeaponType = 'laser' | 'missile' | 'bouncy' | 'grenade' | 'shrapnel';

// ─── Magic bytes (must not collide with JSON '{' = 0x7B or state snapshot 0x01) ───
export const BINARY_INPUT_TAG = 0xA1;
export const BINARY_FIRE_TAG = 0xA2;
/** Critical game event (JSON payload wrapped for ARCnet CRITICAL channel delivery) */
export const CRITICAL_JSON_TAG = 0xA3;

// ─── Weapon type → u8 mapping ───
const WEAPON_TO_ID: Record<WeaponType, number> = {
  laser: 0,
  missile: 1,
  bouncy: 2,
  grenade: 3,
  shrapnel: 4,
};
const ID_TO_WEAPON: WeaponType[] = ['laser', 'missile', 'bouncy', 'grenade', 'shrapnel'];

// ─── Key bitfield ───
// bit 0 = up, bit 1 = down, bit 2 = left, bit 3 = right
function packKeys(keys: { up: boolean; down: boolean; left: boolean; right: boolean }): number {
  return (keys.up ? 1 : 0) | (keys.down ? 2 : 0) | (keys.left ? 4 : 0) | (keys.right ? 8 : 0);
}

function unpackKeys(byte: number): { up: boolean; down: boolean; left: boolean; right: boolean } {
  return {
    up: (byte & 1) !== 0,
    down: (byte & 2) !== 0,
    left: (byte & 4) !== 0,
    right: (byte & 8) !== 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// INPUT PACKET (20 bytes with position, 12 without)
//
// [tag:u8][seq:u32][keys:u8][cursorX:i16][cursorY:i16][hasPos:u8]
// if hasPos: [x:f32][y:f32]
//
// Total: 11 bytes base + optional 8 bytes position = 11 or 19 bytes
// vs JSON: ~100 bytes
// ═══════════════════════════════════════════════════════════════════

export interface BinaryInputData {
  sequenceNumber: number;
  keys: { up: boolean; down: boolean; left: boolean; right: boolean };
  cursorX: number;
  cursorY: number;
  x?: number;
  y?: number;
}

export function encodeBinaryInput(input: BinaryInputData): ArrayBuffer {
  const hasPos = input.x !== undefined && input.y !== undefined;
  const size = hasPos ? 19 : 11;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let o = 0;

  view.setUint8(o, BINARY_INPUT_TAG); o += 1;           // tag
  view.setUint32(o, input.sequenceNumber, true); o += 4; // seq (LE)
  view.setUint8(o, packKeys(input.keys)); o += 1;        // keys bitfield
  view.setInt16(o, Math.round(input.cursorX), true); o += 2; // cursorX
  view.setInt16(o, Math.round(input.cursorY), true); o += 2; // cursorY
  view.setUint8(o, hasPos ? 1 : 0); o += 1;              // hasPos flag

  if (hasPos) {
    view.setFloat32(o, input.x!, true); o += 4;           // x
    view.setFloat32(o, input.y!, true); o += 4;           // y
  }

  return buf;
}

export function decodeBinaryInput(buffer: ArrayBuffer): BinaryInputData {
  const view = new DataView(buffer);
  let o = 0;

  const tag = view.getUint8(o); o += 1;
  if (tag !== BINARY_INPUT_TAG) throw new Error(`Invalid binary input tag: 0x${tag.toString(16)}`);

  const sequenceNumber = view.getUint32(o, true); o += 4;
  const keys = unpackKeys(view.getUint8(o)); o += 1;
  const cursorX = view.getInt16(o, true); o += 2;
  const cursorY = view.getInt16(o, true); o += 2;
  const hasPos = view.getUint8(o) !== 0; o += 1;

  const result: BinaryInputData = { sequenceNumber, keys, cursorX, cursorY };

  if (hasPos && buffer.byteLength >= 19) {
    result.x = view.getFloat32(o, true); o += 4;
    result.y = view.getFloat32(o, true); o += 4;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// FIRE PACKET (16 bytes with position, 8 without)
//
// [tag:u8][weaponType:u8][aimDir:f32][hasExtra:u8][padding:u8]
// if hasExtra: [targetDist:f32][x:f32][y:f32]
//
// Total: 8 bytes base + optional 12 bytes = 8 or 20 bytes
// vs JSON: ~110 bytes
// ═══════════════════════════════════════════════════════════════════

export interface BinaryFireData {
  weaponType: WeaponType;
  aimDirection: number;
  targetDistance?: number;
  x?: number;
  y?: number;
}

export function encodeBinaryFire(fire: BinaryFireData): ArrayBuffer {
  const hasExtra = fire.targetDistance !== undefined || (fire.x !== undefined && fire.y !== undefined);
  const size = hasExtra ? 20 : 8;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let o = 0;

  view.setUint8(o, BINARY_FIRE_TAG); o += 1;             // tag
  view.setUint8(o, WEAPON_TO_ID[fire.weaponType] ?? 0); o += 1; // weapon
  view.setFloat32(o, fire.aimDirection, true); o += 4;     // aim radians
  view.setUint8(o, hasExtra ? 1 : 0); o += 1;             // hasExtra
  o += 1; // padding for alignment

  if (hasExtra) {
    view.setFloat32(o, fire.targetDistance ?? 0, true); o += 4; // targetDist
    view.setFloat32(o, fire.x ?? 0, true); o += 4;              // x
    view.setFloat32(o, fire.y ?? 0, true); o += 4;              // y
  }

  return buf;
}

export function decodeBinaryFire(buffer: ArrayBuffer): BinaryFireData {
  const view = new DataView(buffer);
  let o = 0;

  const tag = view.getUint8(o); o += 1;
  if (tag !== BINARY_FIRE_TAG) throw new Error(`Invalid binary fire tag: 0x${tag.toString(16)}`);

  const weaponId = view.getUint8(o); o += 1;
  const aimDirection = view.getFloat32(o, true); o += 4;
  const hasExtra = view.getUint8(o) !== 0; o += 1;
  o += 1; // padding

  const result: BinaryFireData = {
    weaponType: ID_TO_WEAPON[weaponId] ?? 'laser',
    aimDirection,
  };

  if (hasExtra && buffer.byteLength >= 20) {
    const targetDist = view.getFloat32(o, true); o += 4;
    result.x = view.getFloat32(o, true); o += 4;
    result.y = view.getFloat32(o, true); o += 4;
    if (targetDist !== 0) result.targetDistance = targetDist;
  }

  return result;
}

// ─── Detection helpers ───

/** Check if a raw message buffer is a binary input packet */
export function isBinaryInput(data: ArrayBuffer | Buffer): boolean {
  if (data.byteLength < 11) return false;
  const firstByte = data instanceof ArrayBuffer
    ? new Uint8Array(data)[0]
    : data[0];
  return firstByte === BINARY_INPUT_TAG;
}

/** Check if a raw message buffer is a binary fire packet */
export function isBinaryFire(data: ArrayBuffer | Buffer): boolean {
  if (data.byteLength < 8) return false;
  const firstByte = data instanceof ArrayBuffer
    ? new Uint8Array(data)[0]
    : data[0];
  return firstByte === BINARY_FIRE_TAG;
}
