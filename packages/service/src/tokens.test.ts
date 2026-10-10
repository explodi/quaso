// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, createToken, startTestService, uploadJson } from "./test_helpers.ts";

test("a new key is shown once and stored as its SHA-256 hash", async () => {
  using instance = await startTestService();
  const created = await instance.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
  assertMatch(created.secret, /^qso_[A-Za-z0-9_-]{43}$/);
  assertEquals(created.prefix, created.secret.slice(0, 8));
  assertEquals(created.scope, "upload");
  assertEquals(created.createdBy, null);
  assertEquals([created.lastUsedAt, created.revokedAt], [null, null]);
  const [row] = instance.sql.query("SELECT secret_hash, prefix FROM api_tokens");
  assertEquals(row.secret_hash, sha256Hex(created.secret));
  const stored = JSON.stringify(instance.sql.query("SELECT * FROM api_tokens"));
  assertEquals(stored.includes(created.secret), false, "the secret itself is nowhere");
  const other = await instance.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
  assertNotEquals(other.secret, created.secret);
});

test("authenticateToken finds a key by its secret, and only for the system", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "read", "Reader");
  assertEquals(await instance.service.authenticateToken(SYSTEM, { secret: token.secret }), {
    tokenId: token.id,
    scope: "read",
    name: "Reader",
  });
  assertEquals(await instance.service.authenticateToken(SYSTEM, { secret: "qso_nope" }), null);
  assertEquals(await instance.service.authenticateToken(SYSTEM, { secret: "nope" }), null);
  const error = await assertRejects(
    () => instance.service.authenticateToken(token.actor, { secret: token.secret }),
    ServiceError,
  );
  assertEquals(error.code, "forbidden");
});

test("last use is recorded at most once a minute", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "read");
  const lastUsed = () =>
    instance.sql.query<{ last_used_at: number | null }>("SELECT last_used_at FROM api_tokens")[0]
      .last_used_at;
  const start = instance.clock.now;
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  assertEquals(lastUsed(), start);
  instance.clock.advance(30_000);
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  assertEquals(lastUsed(), start, "not written again within the minute");
  instance.clock.advance(30_000);
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  assertEquals(lastUsed(), start + 60_000);
});

test("a revoked key no longer authenticates, nor may do anything", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } }, { languages: ["de"] });
  const token = await createToken(instance.service, "upload");
  await instance.service.exportFiles(token.actor, {});
  assertEquals(await instance.service.revokeApiToken(SYSTEM, { id: token.id }), { ok: true });
  assertEquals(await instance.service.authenticateToken(SYSTEM, { secret: token.secret }), null);
  const error = await assertRejects(
    () => instance.service.exportFiles(token.actor, {}),
    ServiceError,
  );
  assertEquals(error.code, "forbidden");
  const [{ revoked_at }] = instance.sql.query("SELECT revoked_at FROM api_tokens");
  assertEquals(revoked_at, instance.clock.now);
  instance.clock.advance(1000);
  await instance.service.revokeApiToken(SYSTEM, { id: token.id });
  assertEquals(instance.sql.query("SELECT revoked_at FROM api_tokens")[0].revoked_at, revoked_at);
  const missing = await assertRejects(
    () => instance.service.revokeApiToken(SYSTEM, { id: 999 }),
    ServiceError,
  );
  assertEquals(missing.code, "not_found");
});

test("keys are listed newest first, revoked ones included, with who made them", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator", null, "Ada");
  const first = await instance.service.createApiToken(admin, { name: "First", scope: "read" });
  await instance.service.createApiToken(SYSTEM, { name: "Second", scope: "upload" });
  await instance.service.revokeApiToken(admin, { id: first.id });
  const { tokens } = await instance.service.listApiTokens(admin, {});
  assertEquals(
    tokens.map((token) => [token.name, token.scope, token.revokedAt !== null]),
    [
      ["Second", "upload", false],
      ["First", "read", true],
    ],
  );
  assertEquals(tokens[1].createdBy, { type: "user", id: 1, name: "Ada", avatarUrl: null });
  assertEquals("secret" in tokens[0], false);
});

test("people see and revoke their own keys; administrators everyone's", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  const manager = addUser(instance.sql, "manager");
  const other = addUser(instance.sql, "contributor");
  const own = await instance.service.createApiToken(manager, { name: "Laptop", scope: "upload" });
  await instance.service.createApiToken(other, { name: "Desktop", scope: "read" });
  const ids = async (actor: Actor) =>
    (await instance.service.listApiTokens(actor, {})).tokens.map((token) => token.name);
  assertEquals(await ids(manager), ["Laptop"]);
  assertEquals(await ids(admin), ["Desktop", "Laptop"]);
  const notYours = await assertRejects(
    () => instance.service.revokeApiToken(other, { id: own.id }),
    ServiceError,
  );
  assertEquals(notYours.code, "not_found");
  await instance.service.revokeApiToken(manager, { id: own.id });
  const [row] = instance.sql.query<{ revoked_at: number | null }>(
    "SELECT revoked_at FROM api_tokens WHERE id = ?",
    own.id,
  );
  assertNotEquals(row.revoked_at, null);
});

test("keys can't manage keys, and visitors must sign in", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "upload");
  const fromKey = await assertRejects(
    () => instance.service.listApiTokens(token.actor, {}),
    ServiceError,
  );
  assertEquals(fromKey.code, "forbidden");
  const anonymous = await assertRejects(
    () => instance.service.createApiToken(ANONYMOUS, { name: "x", scope: "read" }),
    ServiceError,
  );
  assertEquals(anonymous.code, "unauthorized");
});
