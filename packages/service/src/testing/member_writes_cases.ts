// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { updateMemberAsync, removeMemberAsync } from "../team.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator', password_hash = 'private-hash' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager' WHERE id = 2" },
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (3, 'Other admin', 'administrator', 100)",
    },
    { sql: "UPDATE suggestions SET author_type = 'user', author_id = 2" },
    {
      sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) VALUES (2, 'de', 'translation_saved', 'user', 2, 100)",
    },
    {
      sql: "INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at, used_at, used_by, revoked_at) VALUES (1, 'hash1', 'contributor', 3, 100, 1000, NULL, NULL, NULL), (2, 'hash2', 'contributor', 3, 100, 1000, 150, 2, NULL), (3, 'hash3', 'contributor', 3, 100, 1000, NULL, NULL, 150)",
    },
  ]);
}

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const MEMBER_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "member grants canonicalize with snapshot contribution counts and unchanged writes skip commits",
    async run(sql) {
      await seed(sql);
      const member = await updateMemberAsync(
        sql,
        ADMIN,
        2,
        { role: "contributor", languages: ["DE", "de", "FR"] },
        200,
      );
      checkEqual(member, {
        id: 2,
        displayName: "Reviewer",
        email: null,
        avatarUrl: null,
        role: "contributor",
        languages: ["de", "fr"],
        createdAt: 100,
        contributions: 2,
        volunteerRequest: null,
      });
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await updateMemberAsync(noWrites, ADMIN, 2, {}, 300), member);
      checkEqual(
        (await updateMemberAsync(sql, ADMIN, 2, { languages: null }, 300)).languages,
        null,
      );
    },
  },
  {
    name: "role grants answer pending volunteers and removal preserves their account",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        {
          sql: "UPDATE users SET role = 'none', volunteer_status = 'pending', volunteer_languages = '[\"de\"]', volunteer_message = 'Help', volunteer_requested_at = 50 WHERE id = 2",
        },
      ]);
      const approved = await updateMemberAsync(
        sql,
        ADMIN,
        2,
        { role: "contributor", languages: ["de"] },
        200,
      );
      checkEqual(approved.volunteerRequest, {
        status: "approved",
        languages: ["de"],
        message: "Help",
        createdAt: 50,
      });
      checkEqual(await removeMemberAsync(sql, ADMIN, 2, 300), { ok: true });
      const [user] = await sql.read([
        {
          sql: "SELECT display_name, role, languages, volunteer_status, deleted_at FROM users WHERE id = 2",
        },
      ]);
      checkEqual(user, [
        {
          display_name: "Reviewer",
          role: "none",
          languages: null,
          volunteer_status: null,
          deleted_at: null,
        },
      ]);
    },
  },
  {
    name: "administrator demotion atomically revokes only unused unrevoked invites",
    async run(sql) {
      await seed(sql);
      checkEqual(
        (await updateMemberAsync(sql, ADMIN, 3, { role: "manager" }, 200)).role,
        "manager",
      );
      const [invites] = await sql.read([{ sql: "SELECT id, revoked_at FROM invites ORDER BY id" }]);
      checkEqual(invites, [
        { id: 1, revoked_at: 200 },
        { id: 2, revoked_at: null },
        { id: 3, revoked_at: 150 },
      ]);
      await rejected(
        () => updateMemberAsync(sql, ADMIN, 1, { role: "manager" }, 300),
        "bad_request",
      );
      await rejected(() => removeMemberAsync(sql, ADMIN, 1, 300), "bad_request");
      await sql.commit(4, [
        { sql: "UPDATE users SET role = 'administrator', deleted_at = 300 WHERE id = 3" },
      ]);
      await rejected(() => removeMemberAsync(sql, SYSTEM, 1, 400), "bad_request");
    },
  },
  {
    name: "competing administrator removals cannot remove the last one",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await removeMemberAsync(sql, SYSTEM, 3, 150);
          return rows;
        },
      };
      await rejected(() => removeMemberAsync(changing, SYSTEM, 1, 200), "bad_request");
      const [user] = await sql.read([{ sql: "SELECT role FROM users WHERE id = 1" }]);
      checkEqual([reads, user], [2, [{ role: "administrator" }]]);
    },
  },
  {
    name: "concurrent language patches preserve a newly changed role",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateMemberAsync(
              sql,
              SYSTEM,
              2,
              { role: "contributor", languages: ["fr"] },
              150,
            );
          return rows;
        },
      };
      const member = await updateMemberAsync(changing, ADMIN, 2, { languages: ["de"] }, 200);
      checkEqual(
        [reads, member.role, member.languages, member.contributions],
        [2, "contributor", ["de"], 2],
      );
    },
  },
  {
    name: "a removed project language prevents a stale member grant",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await sql.commit(3, [{ sql: "DELETE FROM languages WHERE tag = 'de'" }]);
          return rows;
        },
      };
      await rejected(
        () => updateMemberAsync(changing, ADMIN, 2, { languages: ["de"] }, 200),
        "bad_request",
      );
      const [user] = await sql.read([{ sql: "SELECT languages FROM users WHERE id = 2" }]);
      checkEqual([reads, user], [2, [{ languages: null }]]);
    },
  },
  {
    name: "caller demotion prevents a stale member update",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await updateMemberAsync(sql, SYSTEM, 1, { role: "manager" }, 150);
          return rows;
        },
      };
      await rejected(
        () => updateMemberAsync(changing, ADMIN, 2, { role: "contributor" }, 200),
        "forbidden",
      );
      const [user] = await sql.read([{ sql: "SELECT role FROM users WHERE id = 2" }]);
      checkEqual([reads, user], [2, [{ role: "manager" }]]);
    },
  },
  {
    name: "failed demotion rolls back both the role and invite revocations",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_member_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await removeMemberAsync(failing, ADMIN, 3, 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [user, invite, revision] = await sql.read([
        { sql: "SELECT role FROM users WHERE id = 3" },
        { sql: "SELECT revoked_at FROM invites WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [user, invite, revision[0].value],
        [[{ role: "administrator" }], [{ revoked_at: null }], "3"],
      );
    },
  },
  {
    name: "access and missing or deleted members retain errors",
    async run(sql) {
      await seed(sql);
      await rejected(() => updateMemberAsync(sql, ANONYMOUS, 2, {}, 200), "unauthorized");
      await rejected(() => updateMemberAsync(sql, MANAGER, 2, {}, 200), "forbidden");
      await rejected(
        () => removeMemberAsync(sql, { type: "token", tokenId: 7 }, 2, 200),
        "forbidden",
      );
      await rejected(() => updateMemberAsync(sql, ADMIN, 999, {}, 200), "not_found");
      await sql.commit(3, [{ sql: "UPDATE users SET deleted_at = 100 WHERE id = 2" }]);
      await rejected(() => removeMemberAsync(sql, ADMIN, 2, 200), "not_found");
    },
  },
  {
    name: "validated member entry points log committed changes and skip no-op logs",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: () => 200,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(() => api.updateMember(MANAGER, { id: 0 }), "forbidden");
      await rejected(() => api.updateMember(ADMIN, { id: 0 }), "validation_failed");
      checkEqual(
        (await api.updateMember(ADMIN, { id: 2, role: "contributor", languages: ["de"] })).role,
        "contributor",
      );
      await api.updateMember(ADMIN, { id: 2 });
      checkEqual(await api.removeMember(ADMIN, { id: 2 }), { ok: true });
      checkEqual(logs, [
        ["Member changed", { userId: 2, role: "contributor", languages: ["de"], by: 1 }],
        ["Member changed", { userId: 2, role: "none", languages: null, by: 1 }],
      ]);
    },
  },
];
