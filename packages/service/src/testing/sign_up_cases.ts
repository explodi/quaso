// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS } from "../api.ts";
import { completeSignUpAsync, signUpAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { verifyPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const FIELDS = { email: " ADA@example.com ", displayName: "  Ada  " };
const OPTIONS = { secretKey: "test-secret", iterations: 10 };
const PASSWORD = "Long password";
const CLOCK = () => 200;

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Admin', 'administrator', 100)",
    },
    { sql: "INSERT INTO languages (tag, created_at) VALUES ('de', 100)" },
    {
      sql: "INSERT INTO invites (id, token_hash, role, languages, created_by, created_at, expires_at, revoked_at) VALUES (1, ?, 'manager', '[\"de\"]', 1, 100, 500, NULL), (2, ?, 'contributor', NULL, 1, 100, 200, NULL), (3, ?, 'contributor', NULL, 1, 100, 500, 150)",
      params: [sha256Hex("invite"), sha256Hex("expired"), sha256Hex("revoked")],
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

export const SIGN_UP_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "signup hashes the password and creates the account and session together",
    async run(sql) {
      await seed(sql);
      const result = await signUpAsync(
        sql,
        { ...FIELDS, password: PASSWORD, userAgent: "Browser" },
        OPTIONS,
        CLOCK,
      );
      checkEqual(result.user, {
        id: 2,
        email: "ada@example.com",
        displayName: "Ada",
        avatarUrl: null,
        role: "none",
        languages: null,
        emailVerified: false,
        hasPassword: true,
        identities: [],
        volunteerRequest: null,
        createdAt: 200,
      });
      checkEqual(result.expiresAt, 200 + SESSION_TTL);
      const [user, sessions, revision] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users WHERE id = 2" },
        { sql: "SELECT id_hash, user_id, user_agent FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(await verifyPassword(PASSWORD, user[0].password_hash as string, OPTIONS), {
        ok: true,
        needsRehash: false,
      });
      checkEqual(
        [user[0].last_seen_at, sessions, revision[0].value],
        [200, [{ id_hash: sha256Hex(result.sessionId), user_id: 2, user_agent: "Browser" }], "2"],
      );
      check(!JSON.stringify(result).includes(user[0].password_hash as string));
    },
  },
  {
    name: "invite consumption grants its role once and refuses unusable tokens",
    async run(sql) {
      await seed(sql);
      const result = await completeSignUpAsync(sql, { ...FIELDS, invite: "invite" }, "hash", {
        clock: CLOCK,
      });
      checkEqual([result.user.role, result.user.languages], ["manager", ["de"]]);
      const [invite] = await sql.read([
        { sql: "SELECT used_at, used_by FROM invites WHERE id = 1" },
      ]);
      checkEqual(invite, [{ used_at: 200, used_by: 2 }]);
      await rejected(
        () =>
          completeSignUpAsync(
            sql,
            { ...FIELDS, email: "other@example.com", invite: "invite" },
            "hash",
            { clock: CLOCK },
          ),
        "bad_request",
      );
      await rejected(
        () =>
          completeSignUpAsync(
            sql,
            { ...FIELDS, email: "other@example.com", invite: "expired" },
            "hash",
            { clock: CLOCK },
          ),
        "bad_request",
      );
      await rejected(
        () =>
          completeSignUpAsync(
            sql,
            { ...FIELDS, email: "other@example.com", invite: "revoked" },
            "hash",
            { clock: CLOCK },
          ),
        "bad_request",
      );
      await rejected(
        () =>
          completeSignUpAsync(
            sql,
            { ...FIELDS, email: "other@example.com", invite: "unknown" },
            "hash",
            { clock: CLOCK },
          ),
        "bad_request",
      );
      const [users] = await sql.read([{ sql: "SELECT id FROM users ORDER BY id" }]);
      checkEqual(users, [{ id: 1 }, { id: 2 }]);
    },
  },
  {
    name: "signup requires setup and permits addresses released by account deletion",
    async run(sql) {
      await rejected(
        () => completeSignUpAsync(sql, FIELDS, "hash", { clock: CLOCK }),
        "setup_required",
      );
      await seed(sql);
      await completeSignUpAsync(sql, FIELDS, "hash", { clock: CLOCK });
      await rejected(
        () =>
          completeSignUpAsync(sql, { ...FIELDS, email: "ADA@EXAMPLE.COM" }, "hash", {
            clock: CLOCK,
          }),
        "conflict",
      );
      await sql.commit(2, [
        { sql: "UPDATE users SET email = NULL, deleted_at = 250 WHERE id = 2" },
      ]);
      checkEqual((await completeSignUpAsync(sql, FIELDS, "hash", { clock: CLOCK })).user.id, 3);
    },
  },
  {
    name: "competing accounts reallocate IDs without regenerating the password hash or session secret",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const commits: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await completeSignUpAsync(
              sql,
              { email: "other@example.com", displayName: "Other" },
              "other-hash",
              { clock: CLOCK },
            );
          return rows;
        },
        async commit(revision, statements) {
          commits.push([statements[0].params![5], statements[2].params![0]]);
          return sql.commit(revision, statements);
        },
      };
      const result = await completeSignUpAsync(changing, FIELDS, "stable-hash", { clock: CLOCK });
      checkEqual(
        [reads, result.user.id, commits],
        [
          2,
          3,
          [
            ["stable-hash", sha256Hex(result.sessionId)],
            ["stable-hash", sha256Hex(result.sessionId)],
          ],
        ],
      );
    },
  },
  {
    name: "a competing signup with the same email prevents a duplicate account",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await completeSignUpAsync(sql, FIELDS, "other-hash", { clock: CLOCK });
          return rows;
        },
      };
      await rejected(
        () => completeSignUpAsync(changing, FIELDS, "hash", { clock: CLOCK }),
        "conflict",
      );
      const [users] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM users WHERE email = 'ada@example.com'" },
      ]);
      checkEqual([reads, users], [2, [{ n: 1 }]]);
    },
  },
  {
    name: "competing invite consumers cannot both receive the role",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await completeSignUpAsync(
              sql,
              { ...FIELDS, email: "other@example.com", invite: "invite" },
              "other-hash",
              { clock: CLOCK },
            );
          return rows;
        },
      };
      await rejected(
        () =>
          completeSignUpAsync(changing, { ...FIELDS, invite: "invite" }, "hash", { clock: CLOCK }),
        "bad_request",
      );
      const [users] = await sql.read([{ sql: "SELECT email FROM users WHERE role = 'manager'" }]);
      checkEqual([reads, users], [2, [{ email: "other@example.com" }]]);
    },
  },
  {
    name: "invite expiry is checked again after a revision conflict",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      let clockCalls = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      const clock = () => (++clockCalls === 1 ? 200 : 500);
      await rejected(
        () => completeSignUpAsync(changing, { ...FIELDS, invite: "invite" }, "hash", { clock }),
        "bad_request",
      );
      const [invite, users] = await sql.read([
        { sql: "SELECT used_at FROM invites WHERE id = 1" },
        { sql: "SELECT id FROM users" },
      ]);
      checkEqual([reads, invite, users], [2, [{ used_at: null }], [{ id: 1 }]]);
    },
  },
  {
    name: "failed signup rolls back the account, consumed invite, session and expired-session cleanup",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('old', 1, 0, 100, 0)",
        },
      ]);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_signup_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await completeSignUpAsync(failing, { ...FIELDS, invite: "invite" }, "hash", {
          clock: CLOCK,
        });
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [users, invite, sessions, revision] = await sql.read([
        { sql: "SELECT id FROM users" },
        { sql: "SELECT used_at, used_by FROM invites WHERE id = 1" },
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [users, invite, sessions, revision[0].value],
        [[{ id: 1 }], [{ used_at: null, used_by: null }], [{ id_hash: "old" }], "2"],
      );
    },
  },
  {
    name: "validated signup checks input and logs no credentials or invite tokens",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: CLOCK,
        passwordIterations: 10,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(
        () => api.signUp(ANONYMOUS, { email: "invalid", password: PASSWORD, displayName: "Ada" }),
        "validation_failed",
      );
      const result = await api.signUp(ANONYMOUS, {
        email: "ada@example.com",
        password: PASSWORD,
        displayName: "Ada",
        invite: "invite",
      });
      checkEqual(result.user.role, "manager");
      checkEqual(logs, [["Signed up", { userId: 2, invite: true }]]);
    },
  },
];
