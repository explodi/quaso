// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { DEV_EMAIL, devSignInAsync, ensureDevAccountAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

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

export const DEV_ACCOUNT_WRITES_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "development account writes reject non-system and production calls before database access",
    async run(sql) {
      const unreadable: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      await rejected(() => ensureDevAccountAsync(unreadable, ANONYMOUS, true, 200), "forbidden");
      await rejected(() => devSignInAsync(unreadable, ANONYMOUS, true, 200), "forbidden");
      await rejected(() => ensureDevAccountAsync(unreadable, SYSTEM, false, 200), "forbidden");
      await rejected(() => devSignInAsync(unreadable, SYSTEM, false, 200), "forbidden");
    },
  },
  {
    name: "ensuring the developer creates a verified passwordless administrator once",
    async run(sql) {
      const result = await ensureDevAccountAsync(sql, SYSTEM, true, 200);
      checkEqual(result, {
        id: 1,
        email: DEV_EMAIL,
        displayName: "Developer",
        avatarUrl: null,
        role: "administrator",
        languages: null,
        emailVerified: true,
        hasPassword: false,
        identities: [],
        volunteerRequest: null,
        createdAt: 200,
      });
      checkEqual(await ensureDevAccountAsync(sql, SYSTEM, true, 300), result);
      const [users, revision, sessions] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT id_hash FROM sessions" },
      ]);
      checkEqual(
        [users, revision[0].value, sessions],
        [[{ password_hash: null, last_seen_at: null }], "1", []],
      );
    },
  },
  {
    name: "existing developer promotion preserves profile, password, identities and volunteer metadata",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, email, display_name, avatar_url, role, languages, password_hash, email_verified, created_at, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at) VALUES (1, ?, 'Custom', 'https://example.com/avatar', 'none', '[\"de\"]', 'existing-hash', 0, 100, 'pending', '[\"de\"]', 'Hello', 150)",
          params: [DEV_EMAIL],
        },
        {
          sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'subject', 'octo', 100)",
        },
      ]);
      const result = await ensureDevAccountAsync(sql, SYSTEM, true, 200);
      checkEqual(
        [
          result.displayName,
          result.role,
          result.languages,
          result.emailVerified,
          result.hasPassword,
          result.identities,
          result.volunteerRequest,
        ],
        [
          "Custom",
          "administrator",
          ["de"],
          false,
          true,
          [{ provider: "github", username: "octo" }],
          { status: "pending", languages: ["de"], message: "Hello", createdAt: 150 },
        ],
      );
      const [users] = await sql.read([
        { sql: "SELECT password_hash, avatar_url, created_at FROM users" },
      ]);
      checkEqual(users, [
        {
          password_hash: "existing-hash",
          avatar_url: "https://example.com/avatar",
          created_at: 100,
        },
      ]);
    },
  },
  {
    name: "competing developer creation reuses the committed account instead of creating a duplicate",
    async run(sql) {
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await ensureDevAccountAsync(sql, SYSTEM, true, 100);
          return rows;
        },
      };
      const result = await ensureDevAccountAsync(changing, SYSTEM, true, 200);
      const [users, revision] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM users" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [reads, result.id, result.createdAt, users, revision[0].value],
        [2, 1, 100, [{ n: 1 }], "1"],
      );
    },
  },
  {
    name: "development sign-in creates the developer and session and cleans expired sessions together",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Other', 'none', 100)",
        },
        {
          sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('expired', 1, 0, 100, 0)",
        },
      ]);
      const result = await devSignInAsync(sql, SYSTEM, true, 200, "Browser");
      checkEqual(
        [result.user.id, result.user.role, result.user.hasPassword, result.expiresAt],
        [2, "administrator", false, 200 + SESSION_TTL],
      );
      const [sessions, users, revision] = await sql.read([
        { sql: "SELECT id_hash, user_id, user_agent FROM sessions" },
        { sql: "SELECT last_seen_at FROM users WHERE id = 2" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [sessions, users, revision[0].value],
        [
          [{ id_hash: sha256Hex(result.sessionId), user_id: 2, user_agent: "Browser" }],
          [{ last_seen_at: 200 }],
          "2",
        ],
      );
    },
  },
  {
    name: "sign-in reallocates the account ID with a stable session secret after a conflict",
    async run(sql) {
      let reads = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(0, [
              {
                sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Other', 'none', 100)",
              },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[2].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const result = await devSignInAsync(changing, SYSTEM, true, 200);
      checkEqual(
        [reads, result.user.id, hashes],
        [2, 2, [sha256Hex(result.sessionId), sha256Hex(result.sessionId)]],
      );
    },
  },
  {
    name: "sign-in promotion conflicts refresh the profile and linked identity response",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, email, display_name, role, created_at) VALUES (1, ?, 'Old', 'none', 100)",
          params: [DEV_EMAIL],
        },
      ]);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'New' WHERE id = 1" },
              {
                sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'subject', 'octo', 100)",
              },
            ]);
          return rows;
        },
      };
      const result = await devSignInAsync(changing, SYSTEM, true, 200);
      checkEqual(
        [reads, result.user.displayName, result.user.role, result.user.identities],
        [2, "New", "administrator", [{ provider: "github", username: "octo" }]],
      );
    },
  },
  {
    name: "failed development sign-in rolls back account promotion, session creation and expiry cleanup",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, email, display_name, role, created_at) VALUES (1, ?, 'Developer', 'none', 100)",
          params: [DEV_EMAIL],
        },
        {
          sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('expired', 1, 0, 100, 0)",
        },
      ]);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_developer_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await devSignInAsync(failing, SYSTEM, true, 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [users, sessions, revision] = await sql.read([
        { sql: "SELECT role, last_seen_at FROM users" },
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [users, sessions, revision[0].value],
        [[{ role: "none", last_seen_at: null }], [{ id_hash: "expired" }], "1"],
      );
    },
  },
  {
    name: "validated developer entry points default to production and validate user-agent input",
    async run(sql) {
      const production = asyncWriteMethods({ sql });
      await rejected(() => production.ensureDevAccount(SYSTEM, {}), "forbidden");
      await rejected(() => production.devSignIn(SYSTEM, {}), "forbidden");
      const development = asyncWriteMethods({ sql, dev: true, clock: () => 200 });
      await rejected(
        () => development.devSignIn(SYSTEM, { userAgent: "x".repeat(1001) }),
        "validation_failed",
      );
      const user = await development.ensureDevAccount(SYSTEM, {});
      const session = await development.devSignIn(SYSTEM, { userAgent: "Browser" });
      checkEqual(session.user, user);
      const [users] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM users" }]);
      checkEqual(users, [{ n: 1 }]);
    },
  },
];
