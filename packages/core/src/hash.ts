// SPDX-License-Identifier: MIT
/**
 * Synchronous SHA-256, so that the service can hash inside a synchronous transaction, and
 * canonical hashes of values (design §5.3: a translation remembers the hash of the English
 * it was made for).
 */
import { PLURAL_CATEGORIES, type PluralForms, type TextValue } from "./types.ts";

/**
 * SHA-256 of a string (as UTF-8) or of bytes, as 64 lowercase hex characters.
 * A pure implementation of FIPS 180-4, because Web Crypto is asynchronous.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const state = Int32Array.from(INITIAL_STATE);
  const schedule = new Int32Array(64);
  const whole = bytes.length - (bytes.length % BLOCK_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < whole; offset += BLOCK_SIZE) {
    compress(state, schedule, view, offset);
  }
  const tail = new DataView(finalBlocks(bytes, whole).buffer);
  for (let offset = 0; offset < tail.byteLength; offset += BLOCK_SIZE) {
    compress(state, schedule, tail, offset);
  }
  return Array.from(state, (word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * A value as canonical JSON: a string as `JSON.stringify` writes it; forms as an object
 * with their categories in CLDR order.
 */
export function canonicalValue(value: TextValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  const ordered: PluralForms = {};
  for (const category of PLURAL_CATEGORIES) {
    if (value[category] !== undefined) ordered[category] = value[category];
  }
  return JSON.stringify(ordered);
}

/** The hash of a value, from its canonical JSON. */
export function hashValue(value: TextValue): string {
  return sha256Hex(canonicalValue(value));
}

const encoder = new TextEncoder();

/** Bytes per block. */
const BLOCK_SIZE = 64;

/** The initial hash value (FIPS 180-4 §5.3.3). */
// prettier-ignore
const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** The round constants (FIPS 180-4 §4.2.2). */
// prettier-ignore
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * The padded end of the message (FIPS 180-4 §5.1.1): the bytes after the last whole block,
 * a 1 bit, zeros, and the length in bits as a 64-bit big-endian number. One block, or two
 * when the length doesn't fit after the remaining bytes.
 */
function finalBlocks(bytes: Uint8Array, start: number): Uint8Array {
  const rest = bytes.length - start;
  const size = rest < BLOCK_SIZE - 8 ? BLOCK_SIZE : 2 * BLOCK_SIZE;
  const blocks = new Uint8Array(size);
  blocks.set(bytes.subarray(start));
  blocks[rest] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(blocks.buffer);
  view.setUint32(size - 8, Math.floor(bits / 0x100000000));
  view.setUint32(size - 4, bits >>> 0);
  return blocks;
}

/**
 * Processes one 64-byte block at `offset` into `state` (FIPS 180-4 §6.2.2). `schedule` is
 * scratch space for the 64 message schedule words. All arithmetic is on 32-bit integers.
 */
function compress(state: Int32Array, schedule: Int32Array, view: DataView, offset: number): void {
  const w = schedule;
  for (let t = 0; t < 16; t++) w[t] = view.getInt32(offset + t * 4);
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let t = 0; t < 64; t++) {
    const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const choose = (e & f) ^ (~e & g);
    const t1 = (h + sigma1 + choose + K[t] + w[t]) | 0;
    const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (sigma0 + majority) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}
