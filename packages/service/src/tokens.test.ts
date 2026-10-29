// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { sha256Hex } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, createToken, startTestService, uploadJson } from "./test_helpers.ts";

test("a new key is shown once and stored as its SHA-256 hash", async () => {
  using instance = await startTestService();
  const created = await instance.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
  expect(created.secret).toMatch(/^qso_[A-Za-z0-9_-]{43}$/);
  expect(created.prefix).toStrictEqual(created.secret.slice(0, 8));
  expect(created.scope).toBe("upload");
  expect(created.createdBy).toBe(null);
  expect([created.lastUsedAt, created.revokedAt]).toStrictEqual([null, null]);
  const [row] = instance.sql.query("SELECT secret_hash, prefix FROM api_tokens");
  expect(row.secret_hash).toStrictEqual(sha256Hex(created.secret));
  const stored = JSON.stringify(instance.sql.query("SELECT * FROM api_tokens"));
  expect(stored.includes(created.secret), "the secret itself is nowhere").toBe(false);
  const other = await instance.service.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
  expect(other.secret).not.toStrictEqual(created.secret);
});

test("authenticateToken finds a key by its secret, and only for the system", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "read", "Reader");
  expect(await instance.service.authenticateToken(SYSTEM, { secret: token.secret })).toStrictEqual({
    tokenId: token.id,
    scope: "read",
    name: "Reader",
  });
  expect(await instance.service.authenticateToken(SYSTEM, { secret: "qso_nope" })).toStrictEqual(
    null,
  );
  expect(await instance.service.authenticateToken(SYSTEM, { secret: "nope" })).toBe(null);
  const error = await instance.service
    .authenticateToken(token.actor, { secret: token.secret })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("forbidden");
});

test("last use is recorded at most once a minute", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "read");
  const lastUsed = () =>
    instance.sql.query<{ last_used_at: number | null }>("SELECT last_used_at FROM api_tokens")[0]
      .last_used_at;
  const start = instance.clock.now;
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  expect(lastUsed()).toStrictEqual(start);
  instance.clock.advance(30_000);
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  expect(lastUsed(), "not written again within the minute").toStrictEqual(start);
  instance.clock.advance(30_000);
  await instance.service.authenticateToken(SYSTEM, { secret: token.secret });
  expect(lastUsed()).toStrictEqual(start + 60_000);
});

test("a revoked key no longer authenticates, nor may do anything", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } }, { languages: ["de"] });
  const token = await createToken(instance.service, "upload");
  await instance.service.exportFiles(token.actor, {});
  expect(await instance.service.revokeApiToken(SYSTEM, { id: token.id })).toStrictEqual({
    ok: true,
  });
  expect(await instance.service.authenticateToken(SYSTEM, { secret: token.secret })).toStrictEqual(
    null,
  );
  const error = await instance.service
    .exportFiles(token.actor, {})
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("forbidden");
  const [{ revoked_at }] = instance.sql.query("SELECT revoked_at FROM api_tokens");
  expect(revoked_at).toStrictEqual(instance.clock.now);
  instance.clock.advance(1000);
  await instance.service.revokeApiToken(SYSTEM, { id: token.id });
  expect(instance.sql.query("SELECT revoked_at FROM api_tokens")[0].revoked_at).toStrictEqual(
    revoked_at,
  );
  const missing = await instance.service
    .revokeApiToken(SYSTEM, { id: 999 })
    .catch((error: unknown) => error);
  assert(missing instanceof ServiceError);
  expect(missing.code).toBe("not_found");
});

test("keys are listed newest first, revoked ones included, with who made them", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator", null, "Ada");
  const first = await instance.service.createApiToken(admin, { name: "First", scope: "read" });
  await instance.service.createApiToken(SYSTEM, { name: "Second", scope: "upload" });
  await instance.service.revokeApiToken(admin, { id: first.id });
  const { tokens } = await instance.service.listApiTokens(admin, {});
  expect(tokens.map((token) => [token.name, token.scope, token.revokedAt !== null])).toStrictEqual([
    ["Second", "upload", false],
    ["First", "read", true],
  ]);
  expect(tokens[1].createdBy).toStrictEqual({ type: "user", id: 1, name: "Ada", avatarUrl: null });
  expect("secret" in tokens[0]).toBe(false);
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
  expect(await ids(manager)).toStrictEqual(["Laptop"]);
  expect(await ids(admin)).toStrictEqual(["Desktop", "Laptop"]);
  const notYours = await instance.service
    .revokeApiToken(other, { id: own.id })
    .catch((error: unknown) => error);
  assert(notYours instanceof ServiceError);
  expect(notYours.code).toBe("not_found");
  await instance.service.revokeApiToken(manager, { id: own.id });
  const [row] = instance.sql.query<{ revoked_at: number | null }>(
    "SELECT revoked_at FROM api_tokens WHERE id = ?",
    own.id,
  );
  expect(row.revoked_at).not.toBe(null);
});

test("keys can't manage keys, and visitors must sign in", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "upload");
  const fromKey = await instance.service
    .listApiTokens(token.actor, {})
    .catch((error: unknown) => error);
  assert(fromKey instanceof ServiceError);
  expect(fromKey.code).toBe("forbidden");
  const anonymous = await instance.service
    .createApiToken(ANONYMOUS, { name: "x", scope: "read" })
    .catch((error: unknown) => error);
  assert(anonymous instanceof ServiceError);
  expect(anonymous.code).toBe("unauthorized");
});
