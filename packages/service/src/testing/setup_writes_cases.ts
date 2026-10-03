// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { completeSetupAsync, ensureSetupTokenAsync, SETUP_TOKEN, setupAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { verifyPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { defaultSettings } from "../settings.ts";
import { SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { getSessionAsync } from "../users.ts";
import { validateSetupTokenAsync } from "../accounts.ts";

const FIELDS = {
  token: "setup-secret",
  email: " ADA@example.com ",
  displayName: " Ada ",
  projectName: " Project ",
  sourceLanguage: "fr",
};
const OPTIONS = { model: "test", clock: () => 200 };
const PASSWORDS = { secretKey: "test-secret", iterations: 10 };

async function seed(sql: Sql) {
  await sql.commit(0, [
    { sql: "INSERT INTO meta (key, value) VALUES (?, ?)", params: [SETUP_TOKEN, FIELDS.token] },
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

export const SETUP_WRITES_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "completed setup cannot reopen after the administrator disappears",
    async run(sql) {
      await seed(sql);
      await completeSetupAsync(sql, FIELDS, "hash", OPTIONS);
      const [completed, revision] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'setup_completed_at'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(completed, [{ value: "200" }]);
      await sql.commit(Number(revision[0].value), [
        { sql: "UPDATE users SET role = 'none', deleted_at = 300" },
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'stale-key')" },
      ]);
      checkEqual((await getSessionAsync(sql, ANONYMOUS)).setupRequired, false);
      checkEqual(await validateSetupTokenAsync(sql, "stale-key"), false);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM, "replacement-key"), null);
      await rejected(() => completeSetupAsync(sql, FIELDS, "new-hash", OPTIONS), "forbidden");
    },
  },
  {
    name: "setup tokens require the server and repeated creation skips writes",
    async run(sql) {
      const unreadable: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      await rejected(() => ensureSetupTokenAsync(unreadable, ANONYMOUS), "forbidden");
      const generated = await ensureSetupTokenAsync(sql, SYSTEM);
      check(typeof generated === "string" && generated.length > 20);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM), generated);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM, "operator-token"), "operator-token");
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM, "operator-token"), "operator-token");
      const [revision, token] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
      ]);
      checkEqual([revision[0].value, token[0].value], ["2", "operator-token"]);
    },
  },
  {
    name: "a competing generated setup token wins and setup suppresses stale tokens",
    async run(sql) {
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await ensureSetupTokenAsync(sql, SYSTEM, "winner");
          return rows;
        },
      };
      checkEqual(await ensureSetupTokenAsync(changing, SYSTEM), "winner");
      checkEqual(reads, 2);
      await sql.commit(1, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Admin', 'administrator', 100)",
        },
      ]);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM, "replacement"), null);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM), null);
      const [tokens, revision] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([tokens, revision[0].value], [[], "3"]);
    },
  },
  {
    name: "setup creates an administrator, settings and hashed session atomically",
    async run(sql) {
      await seed(sql);
      const result = await setupAsync(
        sql,
        { ...FIELDS, password: "Long password", userAgent: "Browser" },
        PASSWORDS,
        OPTIONS,
      );
      checkEqual(result.user, {
        id: 1,
        email: "ada@example.com",
        displayName: "Ada",
        avatarUrl: null,
        role: "administrator",
        languages: null,
        emailVerified: false,
        hasPassword: true,
        identities: [],
        volunteerRequest: null,
        createdAt: 200,
      });
      checkEqual(result.expiresAt, 200 + SESSION_TTL);
      const [users, settings, tokens, sessions] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users" },
        { sql: "SELECT data FROM settings WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
        { sql: "SELECT id_hash, user_id, user_agent FROM sessions" },
      ]);
      checkEqual(
        await verifyPassword("Long password", users[0].password_hash as string, PASSWORDS),
        { ok: true, needsRehash: false },
      );
      checkEqual(users[0].last_seen_at, 200);
      checkEqual(JSON.parse(settings[0].data as string), {
        ...defaultSettings("test"),
        name: "Project",
        sourceLanguage: "fr",
      });
      checkEqual(tokens, []);
      checkEqual(sessions, [
        { id_hash: sha256Hex(result.sessionId), user_id: 1, user_agent: "Browser" },
      ]);
      checkEqual(await ensureSetupTokenAsync(sql, SYSTEM), null);
      await rejected(() => completeSetupAsync(sql, FIELDS, "hash", OPTIONS), "forbidden");
    },
  },
  {
    name: "setup refuses unknown tokens and duplicate active addresses",
    async run(sql) {
      await rejected(() => completeSetupAsync(sql, FIELDS, "hash", OPTIONS), "forbidden");
      await seed(sql);
      await rejected(
        () =>
          setupAsync(
            sql,
            { ...FIELDS, token: "wrong", password: "Long password" },
            PASSWORDS,
            OPTIONS,
          ),
        "forbidden",
      );
      await sql.commit(1, [
        {
          sql: "INSERT INTO users (id, email, display_name, role, created_at) VALUES (1, 'ada@example.com', 'Existing', 'none', 100)",
        },
      ]);
      await rejected(() => completeSetupAsync(sql, FIELDS, "hash", OPTIONS), "conflict");
      const [sessions, settings] = await sql.read([
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT data FROM settings" },
      ]);
      checkEqual([sessions, settings], [[], []]);
    },
  },
  {
    name: "a settings conflict refreshes defaults and preserves proposed password and session hashes",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const commits: unknown[] = [];
      const current = {
        ...defaultSettings("test"),
        description: "Concurrent description",
        sourceLanguage: "de",
      };
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              {
                sql: "INSERT INTO settings (id, data) VALUES (1, ?)",
                params: [JSON.stringify(current)],
              },
              {
                sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Other', 'none', 100)",
              },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          commits.push([statements[0].params![3], statements[5].params![0]]);
          return sql.commit(revision, statements);
        },
      };
      const result = await completeSetupAsync(
        changing,
        { ...FIELDS, sourceLanguage: undefined },
        "stable-hash",
        OPTIONS,
      );
      checkEqual(
        [reads, result.user.id, commits],
        [
          2,
          2,
          [
            ["stable-hash", sha256Hex(result.sessionId)],
            ["stable-hash", sha256Hex(result.sessionId)],
          ],
        ],
      );
      const [settings] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
      checkEqual(JSON.parse(settings[0].data as string), { ...current, name: "Project" });
    },
  },
  {
    name: "competing setup completions create only one administrator",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await completeSetupAsync(
              sql,
              { ...FIELDS, email: "other@example.com" },
              "winner-hash",
              OPTIONS,
            );
          return rows;
        },
      };
      await rejected(() => completeSetupAsync(changing, FIELDS, "hash", OPTIONS), "forbidden");
      const [users, sessions] = await sql.read([
        { sql: "SELECT email FROM users WHERE role = 'administrator'" },
        { sql: "SELECT COUNT(*) AS n FROM sessions" },
      ]);
      checkEqual([reads, users, sessions], [2, [{ email: "other@example.com" }], [{ n: 1 }]]);
    },
  },
  {
    name: "token replacement during a conflict invalidates the old setup link",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await ensureSetupTokenAsync(sql, SYSTEM, "new-secret");
          return rows;
        },
      };
      await rejected(() => completeSetupAsync(changing, FIELDS, "hash", OPTIONS), "forbidden");
      const [users, token] = await sql.read([
        { sql: "SELECT id FROM users" },
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
      ]);
      checkEqual([reads, users, token], [2, [], [{ value: "new-secret" }]]);
    },
  },
  {
    name: "a failed setup batch restores token, settings, accounts and expired sessions",
    async run(sql) {
      await seed(sql);
      const original = defaultSettings("test");
      await sql.commit(1, [
        {
          sql: "INSERT INTO settings (id, data) VALUES (1, ?)",
          params: [JSON.stringify(original)],
        },
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Other', 'none', 100)",
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
            { sql: "INSERT INTO missing_setup_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await completeSetupAsync(failing, FIELDS, "hash", OPTIONS);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [users, settings, tokens, sessions, revision] = await sql.read([
        { sql: "SELECT id FROM users" },
        { sql: "SELECT data FROM settings WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [users, JSON.parse(settings[0].data as string), tokens, sessions, revision[0].value],
        [[{ id: 1 }], original, [{ value: FIELDS.token }], [{ id_hash: "expired" }], "2"],
      );
    },
  },
  {
    name: "validated setup checks input and logs only the administrator ID",
    async run(sql) {
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        defaultModel: "test",
        clock: OPTIONS.clock,
        passwordIterations: 10,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(() => api.ensureSetupToken(ANONYMOUS, {}), "forbidden");
      await rejected(() => api.ensureSetupToken(SYSTEM, { token: "" }), "validation_failed");
      checkEqual(await api.ensureSetupToken(SYSTEM, { token: FIELDS.token }), {
        token: FIELDS.token,
      });
      await rejected(
        () =>
          api.completeSetup(ANONYMOUS, { ...FIELDS, email: "invalid", password: "Long password" }),
        "validation_failed",
      );

      const result = await api.completeSetup(ANONYMOUS, {
        ...FIELDS,
        email: "ada@example.com",
        password: "Long password",
      });
      checkEqual(result.user.role, "administrator");
      checkEqual(logs, [["Setup complete: the first administrator is created", { userId: 1 }]]);
    },
  },
];
