// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
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
  assertEquals(
    allowed((action) => can(instance.ctx, SYSTEM, action)),
    [...ACTIONS],
  );
  assertEquals(
    allowed((action) => can(instance.ctx, ANONYMOUS, action)),
    ["read"],
  );
});

test("API keys: read reads and downloads; upload also uploads, translates and sees usage", async () => {
  using instance = await startTestService();
  const read = await createToken(instance.service, "read");
  const upload = await createToken(instance.service, "upload");
  assertEquals(
    allowed((action) => can(instance.ctx, read.actor, action)),
    ["read", "download"],
  );
  assertEquals(
    allowed((action) => can(instance.ctx, upload.actor, action)),
    ["read", "download", "upload", "translate", "usage"],
  );
  await instance.service.revokeApiToken(SYSTEM, { id: upload.id });
  assertEquals(
    allowed((action) => can(instance.ctx, upload.actor, action)),
    [],
  );
  assertEquals(
    allowed((action) => can(instance.ctx, { type: "token", tokenId: 999 }, action)),
    [],
  );
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
    assertEquals(
      allowed((action) => can(instance.ctx, actor, action)),
      [...expected],
      role,
    );
  }
});

test("language limits apply to suggesting, editing and reviewing (ROLE-3)", async () => {
  using instance = await startTestService();
  const contributor = addUser(instance.sql, "contributor", ["pt-BR"]);
  const manager = addUser(instance.sql, "manager", ["de"]);
  assertEquals(can(instance.ctx, contributor, "suggest", "pt-br"), true);
  assertEquals(can(instance.ctx, contributor, "suggest", "de"), false);
  assertEquals(can(instance.ctx, contributor, "read", "de"), true);
  assertEquals(can(instance.ctx, manager, "edit", "de"), true);
  assertEquals(can(instance.ctx, manager, "review", "fr"), false);
  // LLM jobs span languages: createJob and cancelJob check languageLimit instead.
  assertEquals(can(instance.ctx, manager, "translate", "fr"), true, "not limited");
  assertEquals(can(instance.ctx, manager, "edit"), true, "no language given");
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
  assertEquals(
    allowed((action) => can(instance.ctx, key, action)),
    ["read", "translate", "usage"],
  );
});

test("an administrator's upload key does everything its scope allows", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  const key = await keyOf(instance, admin, "upload");
  assertEquals(
    allowed((action) => can(instance.ctx, key, action)),
    ["read", "download", "upload", "translate", "usage"],
  );
});

test("a key loses what its creator loses: a demotion, then the account's deletion", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  const key = await keyOf(instance, admin, "upload");
  instance.sql.run("UPDATE users SET role = 'contributor'");
  assertEquals(
    allowed((action) => can(instance.ctx, key, action)),
    ["read"],
  );
  instance.sql.run("UPDATE users SET deleted_at = 1");
  assertEquals(
    allowed((action) => can(instance.ctx, key, action)),
    [],
  );
});

test("languageLimit: a person's languages, canonical; null when nothing limits them", async () => {
  using instance = await startTestService();
  const { ctx, sql } = instance;
  assertEquals(languageLimit(ctx, addUser(sql, "manager", ["pt-br", "iw"])), ["pt-BR", "he"]);
  assertEquals(languageLimit(ctx, addUser(sql, "manager", [])), []);
  assertEquals(languageLimit(ctx, addUser(sql, "manager", null)), null);
  assertEquals(languageLimit(ctx, addUser(sql, "administrator", ["de"])), null);
  assertEquals(languageLimit(ctx, (await createToken(instance.service, "upload")).actor), null);
  const limited = addUser(sql, "manager", ["de"]);
  assertEquals(languageLimit(ctx, await keyOf(instance, limited, "upload")), ["de"]);
  assertEquals(languageLimit(ctx, SYSTEM), null);
});

test("deleted and unknown people may only read, as visitors do", async () => {
  // Their signed session token outlives them by up to an hour (the server's sessions.ts).
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  instance.sql.run("UPDATE users SET deleted_at = 1");
  assertEquals(
    allowed((action) => can(instance.ctx, admin, action)),
    ["read"],
  );
  assertEquals(
    allowed((action) => can(instance.ctx, { type: "user", userId: 42 }, action)),
    ["read"],
  );
});

test("requirePermission: unauthorized for anonymous visitors, forbidden for others", async () => {
  using instance = await startTestService();
  const reader = await createToken(instance.service, "read");
  const anonymous = assertThrows(
    () => requirePermission(instance.ctx, ANONYMOUS, "upload"),
    ServiceError,
  );
  assertEquals(anonymous.code, "unauthorized");
  const token = assertThrows(
    () => requirePermission(instance.ctx, reader.actor, "upload"),
    ServiceError,
  );
  assertEquals(token.code, "forbidden");
  requirePermission(instance.ctx, reader.actor, "download");
});
