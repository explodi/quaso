// SPDX-License-Identifier: MIT
/**
 * Passwords (design §5.8, S6.1): PBKDF2-SHA-256 through Web Crypto, with a random 16-byte
 * salt per password and the iteration count stored next to the hash, so it can be raised
 * later (a sign-in rehashes a password stored with fewer iterations). Hashes depend only
 * on the password and per-user salt, so changing the instance signing key cannot lock
 * people out.
 *
 * Stored as one column: `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`.
 *
 * Hashing is asynchronous and slow on purpose, so the service hashes before its
 * synchronous transaction. Web Crypto may refuse large iteration counts (Cloudflare's
 * production runtime has capped PBKDF2 at 100,000 iterations); the same PBKDF2 then runs in
 * plain JavaScript, so a hash made in one place verifies in the other.
 */

import { sha256Hex } from "@quaso/core";

/** The iteration count for new hashes (OWASP's advice for PBKDF2 at the time of writing). */
export const DEFAULT_ITERATIONS = 210_000;

const SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const encoder = new TextEncoder();

export interface PasswordOptions {
  /** For new hashes. Default: `DEFAULT_ITERATIONS`. */
  iterations?: number;
  /** Tests: skip Web Crypto's PBKDF2 and use the JavaScript one. */
  forceFallback?: boolean;
}

/** A new hash of `password`, in the stored format. */
export async function hashPassword(
  password: string,
  options: PasswordOptions = {},
): Promise<string> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations, options);
  return `${SCHEME}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export interface Verification {
  ok: boolean;
  /** The hash uses fewer iterations than new hashes do: store a new one. */
  needsRehash: boolean;
}

/**
 * Checks `password` against a stored hash, in constant time. A missing or malformed hash
 * still costs one derivation (with the default count), so the answer takes about as long
 * for an unknown account as for a wrong password.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
  options: PasswordOptions,
): Promise<Verification> {
  const target = options.iterations ?? DEFAULT_ITERATIONS;
  const parsed = stored === null ? null : parseHash(stored);
  if (parsed === null) {
    await derive(password, new Uint8Array(SALT_BYTES), target, options);
    return { ok: false, needsRehash: false };
  }
  const hash = await derive(password, parsed.salt, parsed.iterations, options);
  const ok = constantTimeEqual(hash, parsed.hash);
  return { ok, needsRehash: ok && parsed.iterations < target };
}

/** The parts of a stored hash, or null when it isn't one. */
export function parseHash(
  stored: string,
): { iterations: number; salt: Uint8Array; hash: Uint8Array } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== SCHEME || !/^\d{1,9}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (iterations < 1) return null;
  try {
    const salt = fromBase64(parts[2]);
    const hash = fromBase64(parts[3]);
    if (salt.length === 0 || hash.length !== HASH_BYTES) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

/** Whether two byte arrays are equal, in time that depends only on their length. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Whether two secrets are equal, in constant time: their SHA-256 hashes are compared, so
 * not even their lengths show.
 */
export function constantTimeEqualText(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(sha256Hex(a)), encoder.encode(sha256Hex(b)));
}

/** PBKDF2-HMAC-SHA-256 of the password, using its independent random salt. */
async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  options: PasswordOptions,
): Promise<Uint8Array> {
  const passwordBytes = encoder.encode(password);
  if (!options.forceFallback) {
    try {
      const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
        "deriveBits",
      ]);
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
        key,
        HASH_BYTES * 8,
      );
      return new Uint8Array(bits);
    } catch {
      // The runtime refuses this iteration count: the same derivation, in JavaScript.
    }
  }
  return pbkdf2Sha256(passwordBytes, salt, iterations, HASH_BYTES);
}

// ---------------------------------------------------------------------------------------
// PBKDF2-HMAC-SHA-256 in plain JavaScript (RFC 8018), for runtimes that refuse the count.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** One SHA-256 compression of the 16 words `block` into `state` (8 words). */
function compress(state: Int32Array, block: Int32Array, w: Int32Array): void {
  for (let i = 0; i < 16; i++) w[i] = block[i];
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15];
    const b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = state[0],
    b = state[1],
    c = state[2],
    d = state[3];
  let e = state[4],
    f = state[5],
    g = state[6],
    h = state[7];
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

/** SHA-256 of bytes, as 8 words (for HMAC keys and the first message of each block). */
function sha256Words(bytes: Uint8Array): Int32Array {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const state = new Int32Array(IV);
  const block = new Int32Array(16);
  const w = new Int32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) block[i] = view.getInt32(offset + i * 4);
    compress(state, block, w);
  }
  return state;
}

function wordsToBytes(words: Int32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setInt32(i * 4, word));
  return bytes;
}

/** PBKDF2-HMAC-SHA-256, with HMAC's inner and outer states computed once. */
export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Uint8Array {
  let key = password;
  if (key.length > 64) key = wordsToBytes(sha256Words(key));
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) {
    ipad[i] ^= key[i];
    opad[i] ^= key[i];
  }
  const w = new Int32Array(64);
  const inner = new Int32Array(IV);
  const outer = new Int32Array(IV);
  const padView = (pad: Uint8Array) => {
    const view = new DataView(pad.buffer);
    return Int32Array.from({ length: 16 }, (_, i) => view.getInt32(i * 4));
  };
  compress(inner, padView(ipad), w);
  compress(outer, padView(opad), w);

  // A 32-byte message after a 64-byte pad: one block, with fixed padding (768 bits).
  const block = new Int32Array(16);
  block[8] = 0x80000000 | 0;
  block[15] = (64 + 32) * 8;
  const state = new Int32Array(8);
  const hmac32 = (message: Int32Array, out: Int32Array) => {
    state.set(inner);
    block.set(message);
    compress(state, block, w);
    out.set(outer);
    block.set(state);
    compress(out, block, w);
  };

  const out = new Uint8Array(Math.ceil(length / 32) * 32);
  const u = new Int32Array(8);
  const t = new Int32Array(8);
  for (let index = 1; index * 32 - 32 < length; index++) {
    // U1 = HMAC(password, salt || INT(index)), hashed the long way: the salt has any length.
    const first = new Uint8Array(64 + salt.length + 4);
    first.set(ipad);
    first.set(salt, 64);
    new DataView(first.buffer).setUint32(64 + salt.length, index);
    const innerHash = sha256Words(first);
    const second = new Uint8Array(96);
    second.set(opad);
    second.set(wordsToBytes(innerHash), 64);
    u.set(sha256Words(second));
    t.set(u);
    for (let i = 1; i < iterations; i++) {
      hmac32(u, u);
      for (let j = 0; j < 8; j++) t[j] ^= u[j];
    }
    out.set(wordsToBytes(t), (index - 1) * 32);
  }
  return out.slice(0, length);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
