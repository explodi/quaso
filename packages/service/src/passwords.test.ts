// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@quaso/runtime/assert";
import {
  constantTimeEqual,
  constantTimeEqualText,
  DEFAULT_ITERATIONS,
  hashPassword,
  parseHash,
  pbkdf2Sha256,
  verifyPassword,
} from "./passwords.ts";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function webCrypto(
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  length: number,
) {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

test("passwords: the JavaScript PBKDF2 gives the published test vectors and Web Crypto's results", async () => {
  // PBKDF2-HMAC-SHA-256 test vectors (RFC 7914 §11 and the RFC 6070 inputs for SHA-256).
  assertEquals(
    hex(pbkdf2Sha256(encoder.encode("passwd"), encoder.encode("salt"), 1, 64)),
    "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc" +
      "49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
  );
  assertEquals(
    hex(pbkdf2Sha256(encoder.encode("password"), encoder.encode("salt"), 4096, 32)),
    "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
  );
  const cases: [string, string, number, number][] = [
    ["password", "salt", 2, 32],
    ["passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 100, 40],
    ["x".repeat(100), "a long key is hashed first", 3, 64],
    ["", "", 1, 32],
  ];
  for (const [password, salt, iterations, length] of cases) {
    assertEquals(
      hex(pbkdf2Sha256(encoder.encode(password), encoder.encode(salt), iterations, length)),
      hex(await webCrypto(encoder.encode(password), encoder.encode(salt), iterations, length)),
      password,
    );
  }
});

test("passwords: a hash stores the scheme, the iterations and a random salt", async () => {
  const options = { iterations: 1000 };
  const first = await hashPassword("correct horse battery", options);
  const second = await hashPassword("correct horse battery", options);
  assertMatch(first, /^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  assertNotEquals(first, second, "a salt per password");
  assertEquals(parseHash(first)?.iterations, 1000);
  assertEquals((await verifyPassword("correct horse battery", first, options)).ok, true);
  assertEquals((await verifyPassword("correct horse batter", first, options)).ok, false);
  assertEquals(DEFAULT_ITERATIONS, 210_000);
  assertMatch(await hashPassword("x".repeat(10), {}), /^pbkdf2-sha256\$210000\$/);
});

test("passwords: stored hashes match standard PBKDF2 without an instance secret", async () => {
  const stored = await hashPassword("correct horse battery", { iterations: 500 });
  const parsed = parseHash(stored)!;
  const expected = await webCrypto(
    encoder.encode("correct horse battery"),
    new Uint8Array(parsed.salt),
    500,
    32,
  );
  assertEquals(hex(parsed.hash), hex(expected));
});

test("passwords: the JavaScript fallback verifies what Web Crypto hashed, and back", async () => {
  const options = { iterations: 2000 };
  const hash = await hashPassword("correct horse battery", options);
  assert(
    (await verifyPassword("correct horse battery", hash, { ...options, forceFallback: true })).ok,
  );
  const fallback = await hashPassword("staple", { ...options, forceFallback: true });
  assert((await verifyPassword("staple", fallback, options)).ok);
});

test("passwords: fewer iterations than today's ask for a rehash; bad hashes never verify", async () => {
  const old = await hashPassword("correct horse battery", { iterations: 100 });
  assertEquals(await verifyPassword("correct horse battery", old, { iterations: 200 }), {
    ok: true,
    needsRehash: true,
  });
  assertEquals(await verifyPassword("wrong password", old, { iterations: 200 }), {
    ok: false,
    needsRehash: false,
  });
  for (const bad of [
    null,
    "",
    "plain",
    "pbkdf2-sha256$x$a$b",
    "md5$1$AAAA$AAAA",
    "pbkdf2-sha256$0$AA==$AA==",
  ]) {
    assertEquals(
      await verifyPassword("anything", bad, { iterations: 10 }),
      { ok: false, needsRehash: false },
      String(bad),
    );
  }
});

test("passwords: constant-time comparisons", () => {
  assert(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  assert(!constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
  assert(!constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
  assert(constantTimeEqualText("setup-token", "setup-token"));
  assert(!constantTimeEqualText("setup-token", "setup-tokeN"));
  assert(!constantTimeEqualText("setup-token", "setup"));
});
