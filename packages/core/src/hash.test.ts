// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { canonicalValue, hashValue, sha256Hex } from "./hash.ts";

/** SHA-256 through Web Crypto, the reference. */
async function reference(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic pseudo-random bytes (a linear congruential generator). */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

test("sha256Hex matches the NIST test vectors", () => {
  expect(sha256Hex("")).toStrictEqual(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(sha256Hex("abc")).toStrictEqual(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toStrictEqual(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  expect(
    sha256Hex(
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    ),
  ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  expect(sha256Hex("a".repeat(1_000_000))).toStrictEqual(
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
});

test("sha256Hex returns 64 lowercase hex characters", () => {
  for (const input of ["", "x", "Play", "a".repeat(1000)]) {
    expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("sha256Hex agrees with Web Crypto for every length from 0 to 300 bytes", async () => {
  for (let length = 0; length <= 300; length++) {
    const bytes = pseudoRandomBytes(length, length + 1);
    expect(sha256Hex(bytes), `length ${length}`).toStrictEqual(await reference(bytes));
  }
});

test("sha256Hex agrees with Web Crypto around the padding boundaries", async () => {
  // 55 bytes is the longest message whose padding fits in one block; 56 to 63 need two.
  for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 65_537]) {
    for (const seed of [1, 2, 3]) {
      const bytes = pseudoRandomBytes(length, seed * 7919 + length);
      expect(sha256Hex(bytes), `length ${length}, seed ${seed}`).toStrictEqual(
        await reference(bytes),
      );
    }
    const same = new Uint8Array(length).fill(0xff);
    expect(sha256Hex(same), `length ${length} of 0xff`).toStrictEqual(await reference(same));
  }
});

test("sha256Hex reads only the bytes of a view, not its whole buffer", async () => {
  const buffer = pseudoRandomBytes(500, 42);
  for (const [start, end] of [
    [1, 1],
    [3, 58],
    [7, 71],
    [13, 200],
    [64, 128],
    [499, 500],
  ]) {
    const view = buffer.subarray(start, end);
    expect(sha256Hex(view), `bytes ${start} to ${end}`).toStrictEqual(await reference(view));
  }
});

test("sha256Hex hashes strings as UTF-8", async () => {
  const encoder = new TextEncoder();
  const texts = [
    "Zażółć gęślą jaźń",
    "Größenänderung",
    "日本語のテキスト",
    "مرحبا بالعالم",
    "👩‍👩‍👧‍👦 family",
    "é combining",
    "\u0000\u001f control",
    "\u{10FFFF}",
    "x".repeat(63) + "é",
  ];
  for (const text of texts) {
    const bytes = encoder.encode(text);
    expect(sha256Hex(text), text).toStrictEqual(sha256Hex(bytes));
    expect(sha256Hex(text), text).toStrictEqual(await reference(bytes));
  }
});

test("sha256Hex hashes lone surrogates as U+FFFD, like TextEncoder in every runtime", () => {
  expect(sha256Hex("a\ud800b")).toStrictEqual(sha256Hex("a�b"));
  expect(sha256Hex("\udc00")).toStrictEqual(sha256Hex("�"));
  expect(sha256Hex("😀")).not.toStrictEqual(sha256Hex("��"));
});

test("sha256Hex does not modify its input", () => {
  const bytes = pseudoRandomBytes(100, 9);
  const copy = bytes.slice();
  sha256Hex(bytes);
  expect(bytes).toStrictEqual(copy);
});

test("sha256Hex hashes 10 MB in well under a second", async () => {
  const bytes = pseudoRandomBytes(10 * 1024 * 1024, 5);
  const start = performance.now();
  const hash = sha256Hex(bytes);
  const elapsed = performance.now() - start;
  expect(hash).toStrictEqual(await reference(bytes));
  assert(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test("canonicalValue writes strings as JSON and forms in CLDR order", () => {
  expect(canonicalValue("Play")).toBe('"Play"');
  expect(canonicalValue('Say "hi"\n')).toBe('"Say \\"hi\\"\\n"');
  expect(
    canonicalValue({ other: "{{count}} coins", one: "One coin", few: "{{count}} monety" }),
  ).toBe('{"one":"One coin","few":"{{count}} monety","other":"{{count}} coins"}');
  expect(canonicalValue({ other: "x", zero: undefined })).toBe('{"other":"x"}');
});

test("hashValue ignores the order forms were set in", () => {
  const a = hashValue({ one: "One coin", other: "{{count}} coins" });
  const b = hashValue({ other: "{{count}} coins", one: "One coin" });
  expect(a).toStrictEqual(b);
  expect(a).toStrictEqual(sha256Hex('{"one":"One coin","other":"{{count}} coins"}'));
  expect(hashValue("Play")).not.toStrictEqual(hashValue({ other: "Play" }));
  expect(hashValue("Play")).toStrictEqual(sha256Hex('"Play"'));
});
