// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@quaso/runtime/assert";
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
  assertEquals(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assertEquals(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assertEquals(
    sha256Hex(
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    ),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
  assertEquals(
    sha256Hex("a".repeat(1_000_000)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
});

test("sha256Hex returns 64 lowercase hex characters", () => {
  for (const input of ["", "x", "Play", "a".repeat(1000)]) {
    assertMatch(sha256Hex(input), /^[0-9a-f]{64}$/);
  }
});

test("sha256Hex agrees with Web Crypto for every length from 0 to 300 bytes", async () => {
  for (let length = 0; length <= 300; length++) {
    const bytes = pseudoRandomBytes(length, length + 1);
    assertEquals(sha256Hex(bytes), await reference(bytes), `length ${length}`);
  }
});

test("sha256Hex agrees with Web Crypto around the padding boundaries", async () => {
  // 55 bytes is the longest message whose padding fits in one block; 56 to 63 need two.
  for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 65_537]) {
    for (const seed of [1, 2, 3]) {
      const bytes = pseudoRandomBytes(length, seed * 7919 + length);
      assertEquals(sha256Hex(bytes), await reference(bytes), `length ${length}, seed ${seed}`);
    }
    const same = new Uint8Array(length).fill(0xff);
    assertEquals(sha256Hex(same), await reference(same), `length ${length} of 0xff`);
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
    assertEquals(sha256Hex(view), await reference(view), `bytes ${start} to ${end}`);
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
    assertEquals(sha256Hex(text), sha256Hex(bytes), text);
    assertEquals(sha256Hex(text), await reference(bytes), text);
  }
});

test("sha256Hex hashes lone surrogates as U+FFFD, like TextEncoder in every runtime", () => {
  assertEquals(sha256Hex("a\ud800b"), sha256Hex("a�b"));
  assertEquals(sha256Hex("\udc00"), sha256Hex("�"));
  assertNotEquals(sha256Hex("😀"), sha256Hex("��"));
});

test("sha256Hex does not modify its input", () => {
  const bytes = pseudoRandomBytes(100, 9);
  const copy = bytes.slice();
  sha256Hex(bytes);
  assertEquals(bytes, copy);
});

test("sha256Hex hashes 10 MB in well under a second", async () => {
  const bytes = pseudoRandomBytes(10 * 1024 * 1024, 5);
  const start = performance.now();
  const hash = sha256Hex(bytes);
  const elapsed = performance.now() - start;
  assertEquals(hash, await reference(bytes));
  assert(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test("canonicalValue writes strings as JSON and forms in CLDR order", () => {
  assertEquals(canonicalValue("Play"), '"Play"');
  assertEquals(canonicalValue('Say "hi"\n'), '"Say \\"hi\\"\\n"');
  assertEquals(
    canonicalValue({ other: "{{count}} coins", one: "One coin", few: "{{count}} monety" }),
    '{"one":"One coin","few":"{{count}} monety","other":"{{count}} coins"}',
  );
  assertEquals(canonicalValue({ other: "x", zero: undefined }), '{"other":"x"}');
});

test("hashValue ignores the order forms were set in", () => {
  const a = hashValue({ one: "One coin", other: "{{count}} coins" });
  const b = hashValue({ other: "{{count}} coins", one: "One coin" });
  assertEquals(a, b);
  assertEquals(a, sha256Hex('{"one":"One coin","other":"{{count}} coins"}'));
  assertNotEquals(hashValue("Play"), hashValue({ other: "Play" }));
  assertEquals(hashValue("Play"), sha256Hex('"Play"'));
});
