// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { TokenScope } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { type Action, ACTIONS, can, languageLimit, requirePermission } from "./permissions.ts";
import { addUser, createToken, startTestService } from "./test_helpers.ts";

/** The actions an actor may do, in `ACTIONS` order. */
function allowed(check: (action: Action) => boolean): Action[] {
  return ACTIONS.filter(check);
}

test("the system may do everything, anonymous visitors only read", async () => {
  using instance = await startTestService();
  expect(allowed((action) => can(instance.ctx, SYSTEM, action))).toStrictEqual([...ACTIONS]);
  expect(allowed((action) => can(instance.ctx, ANONYMOUS, action))).toStrictEqual(["read"]);
});

test("API keys: read reads and downloads; upload also uploads, converts, translates and sees usage", async () => {
  using instance = await startTestService();
  const read = await createToken(instance.service, "read");
  const upload = await createToken(instance.service, "upload");
  expect(allowed((action) => can(instance.ctx, read.actor, action))).toStrictEqual([
    "read",
    "download",
  ]);
  expect(allowed((action) => can(instance.ctx, upload.actor, action))).toStrictEqual([
    "read",
    "download",
    "upload",
    "convert",
    "translate",
    "usage",
  ]);
  await instance.service.revokeApiToken(SYSTEM, { id: upload.id });
  expect(allowed((action) => can(instance.ctx, upload.actor, action))).toStrictEqual([]);
  expect(
    allowed((action) => can(instance.ctx, { type: "token", tokenId: 999 }, action)),
  ).toStrictEqual([]);
});

test("people by role (design §5.8)", async () => {
  using instance = await startTestService();
  const roles = {
    none: ["read", "volunteer", "account", "requestLanguage"],
    contributor: ["read", "suggest", "account", "comment", "requestLanguage"],
    manager: [
      "read",
      "translate",
      "review",
      "edit",
      "suggest",
      "account",
      "usage",
      "context",
      "glossary",
      "comment",
      "requestLanguage",
      "issues",
    ],
    administrator: ACTIONS.filter((action) => action !== "volunteer"),
  } as const;
  for (const [role, expected] of Object.entries(roles)) {
    const actor = addUser(instance.sql, role as keyof typeof roles);
    expect(
      allowed((action) => can(instance.ctx, actor, action)),
      role,
    ).toStrictEqual([...expected]);
  }
});

test("language limits apply to suggesting, editing and reviewing (ROLE-3)", async () => {
  using instance = await startTestService();
  const contributor = addUser(instance.sql, "contributor", ["pt-BR"]);
  const manager = addUser(instance.sql, "manager", ["de"]);
  expect(can(instance.ctx, contributor, "suggest", "pt-br")).toBe(true);
  expect(can(instance.ctx, contributor, "suggest", "de")).toBe(false);
  expect(can(instance.ctx, contributor, "read", "de")).toBe(true);
  expect(can(instance.ctx, manager, "edit", "de")).toBe(true);
  expect(can(instance.ctx, manager, "review", "fr")).toBe(false);
  // LLM jobs span languages: createJob and cancelJob check languageLimit instead.
  expect(can(instance.ctx, manager, "translate", "fr"), "not limited").toBe(true);
  expect(can(instance.ctx, manager, "edit"), "no language given").toBe(true);
});

/** A key created by `person`, with `scope`. */
async function keyOf(
  instance: Awaited<ReturnType<typeof startTestService>>,
  person: Actor,
  scope: TokenScope,
) {
  const created = await instance.service.createApiToken(person, { name: "Laptop", scope });
  return { type: "token", tokenId: created.id } as const;
}

test("a manager's upload key translates and sees usage, but can't upload or download", async () => {
  using instance = await startTestService();
  const manager = addUser(instance.sql, "manager");
  const key = await keyOf(instance, manager, "upload");
  expect(allowed((action) => can(instance.ctx, key, action))).toStrictEqual([
    "read",
    "translate",
    "usage",
  ]);
});

test("an administrator's upload key does everything its scope allows", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  const key = await keyOf(instance, admin, "upload");
  expect(allowed((action) => can(instance.ctx, key, action))).toStrictEqual([
    "read",
    "download",
    "upload",
    "convert",
    "translate",
    "usage",
  ]);
});

test("a key loses what its creator loses: a demotion, then the account's deletion", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  const key = await keyOf(instance, admin, "upload");
  instance.sql.run("UPDATE users SET role = 'contributor'");
  expect(allowed((action) => can(instance.ctx, key, action))).toStrictEqual(["read"]);
  instance.sql.run("UPDATE users SET deleted_at = 1");
  expect(allowed((action) => can(instance.ctx, key, action))).toStrictEqual([]);
});

test("languageLimit: a person's languages, canonical; null when nothing limits them", async () => {
  using instance = await startTestService();
  const { ctx, sql } = instance;
  expect(languageLimit(ctx, addUser(sql, "manager", ["pt-br", "iw"]))).toStrictEqual([
    "pt-BR",
    "he",
  ]);
  expect(languageLimit(ctx, addUser(sql, "manager", []))).toStrictEqual([]);
  expect(languageLimit(ctx, addUser(sql, "manager", null))).toBe(null);
  expect(languageLimit(ctx, addUser(sql, "administrator", ["de"]))).toBe(null);
  expect(languageLimit(ctx, (await createToken(instance.service, "upload")).actor)).toStrictEqual(
    null,
  );
  const limited = addUser(sql, "manager", ["de"]);
  expect(languageLimit(ctx, await keyOf(instance, limited, "upload"))).toStrictEqual(["de"]);
  expect(languageLimit(ctx, SYSTEM)).toBe(null);
});

test("deleted and unknown people may only read, as visitors do", async () => {
  // Their signed session token outlives them by up to an hour (the server's sessions.ts).
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  instance.sql.run("UPDATE users SET deleted_at = 1");
  expect(allowed((action) => can(instance.ctx, admin, action))).toStrictEqual(["read"]);
  expect(
    allowed((action) => can(instance.ctx, { type: "user", userId: 42 }, action)),
  ).toStrictEqual(["read"]);
});

test("requirePermission: unauthorized for anonymous visitors, forbidden for others", async () => {
  using instance = await startTestService();
  const reader = await createToken(instance.service, "read");
  const anonymous = await Promise.try(() =>
    requirePermission(instance.ctx, ANONYMOUS, "upload"),
  ).catch((error: unknown) => error);
  assert(anonymous instanceof ServiceError);
  expect(anonymous.code).toBe("unauthorized");
  const token = await Promise.try(() =>
    requirePermission(instance.ctx, reader.actor, "upload"),
  ).catch((error: unknown) => error);
  assert(token instanceof ServiceError);
  expect(token.code).toBe("forbidden");
  requirePermission(instance.ctx, reader.actor, "download");
});
