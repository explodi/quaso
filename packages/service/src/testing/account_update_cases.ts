// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { completeAccountUpdateAsync, updateAccountAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { hashPassword, verifyPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const USER: Actor = { type: "user", userId: 1 };
const PASSWORD = "Long password";
const OPTIONS = { secretKey: "test-secret", iterations: 10 };

async function seed(sql: Sql) {
  const hash = await hashPassword(PASSWORD, OPTIONS);
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, password_hash, email_verified, created_at) VALUES (1, 'ada@example.com', 'Ada', 'none', ?, 1, 100), (2, 'other@example.com', 'Other', 'none', NULL, 1, 100)",
      params: [hash],
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'subject', 'octo', 100)",
    },
    {
      sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, 1, 100, 500, 100), (?, 1, 100, 500, 100), (?, 2, 100, 500, 100)",
      params: [sha256Hex("current"), sha256Hex("other"), sha256Hex("foreign")],
    },
    {
      sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, expires_at, created_at, used_at) VALUES ('verify', 1, 'ada@example.com', 'verify', 500, 100, NULL), ('reset', 1, 'ada@example.com', 'reset', 500, 100, NULL), ('signin', 1, 'ada@example.com', 'signin', 500, 100, NULL), ('used', 1, 'ada@example.com', 'reset', 500, 100, 150), ('foreign', 2, 'other@example.com', 'reset', 500, 100, NULL)",
    },
  ]);
  return hash;
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

export const ACCOUNT_UPDATE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "profile changes require no password configuration and repeated changes skip commits",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql });
      const result = await api.updateAccount(USER, { displayName: " Ada L. " });
      checkEqual(
        [result.displayName, result.emailVerified, result.identities],
        ["Ada L.", true, [{ provider: "github", username: "octo" }]],
      );
      checkEqual(await api.updateAccount(USER, { displayName: "Ada L." }), result);
      checkEqual(await api.updateAccount(USER, {}), result);
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "2");
    },
  },
  {
    name: "email changes normalize the address, clear verification and invalidate unused links only",
    async run(sql) {
      await seed(sql);
      const result = await updateAccountAsync(
        sql,
        USER,
        { email: " NEW@example.com ", currentPassword: PASSWORD },
        OPTIONS,
      );
      checkEqual([result.email, result.emailVerified], ["new@example.com", false]);
      const [tokens, sessions] = await sql.read([
        { sql: "SELECT token_hash FROM email_tokens ORDER BY token_hash" },
        { sql: "SELECT COUNT(*) AS n FROM sessions" },
      ]);
      checkEqual(
        [tokens, sessions],
        [[{ token_hash: "foreign" }, { token_hash: "used" }], [{ n: 3 }]],
      );
    },
  },
  {
    name: "unchanged email retains verification and links without a commit",
    async run(sql) {
      await seed(sql);
      const result = await updateAccountAsync(
        sql,
        USER,
        { email: "ADA@EXAMPLE.COM", currentPassword: PASSWORD },
        OPTIONS,
      );
      const [tokens, revision] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM email_tokens" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([result.emailVerified, tokens, revision[0].value], [true, [{ n: 5 }], "1"]);
    },
  },
  {
    name: "password changes keep the requested own session and invalidate access links",
    async run(sql) {
      await seed(sql);
      const result = await updateAccountAsync(
        sql,
        USER,
        { password: "Better password", currentPassword: PASSWORD, sessionId: "current" },
        OPTIONS,
      );
      const [users, sessions, tokens] = await sql.read([
        { sql: "SELECT password_hash FROM users WHERE id = 1" },
        { sql: "SELECT id_hash FROM sessions ORDER BY user_id" },
        { sql: "SELECT token_hash FROM email_tokens ORDER BY token_hash" },
      ]);
      checkEqual(
        await verifyPassword("Better password", users[0].password_hash as string, OPTIONS),
        { ok: true, needsRehash: false },
      );
      checkEqual(sessions, [{ id_hash: sha256Hex("current") }, { id_hash: sha256Hex("foreign") }]);
      checkEqual(tokens, [
        { token_hash: "foreign" },
        { token_hash: "used" },
        { token_hash: "verify" },
      ]);
      check(result.hasPassword);
      check(!JSON.stringify(result).includes(users[0].password_hash as string));
      await updateAccountAsync(
        sql,
        USER,
        { password: "Another password", currentPassword: "Better password", sessionId: "foreign" },
        OPTIONS,
      );
      const [remaining] = await sql.read([{ sql: "SELECT user_id FROM sessions" }]);
      checkEqual(remaining, [{ user_id: 2 }]);
    },
  },
  {
    name: "a passwordless account sets email and password without a current password",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        { sql: "UPDATE users SET email = NULL, password_hash = NULL WHERE id = 1" },
      ]);
      const result = await updateAccountAsync(
        sql,
        USER,
        { displayName: "New name", email: "new@example.com", password: "New password" },
        OPTIONS,
      );
      checkEqual(
        [result.displayName, result.email, result.emailVerified, result.hasPassword],
        ["New name", "new@example.com", false, true],
      );
      const [sessions, tokens] = await sql.read([
        { sql: "SELECT user_id FROM sessions" },
        { sql: "SELECT token_hash FROM email_tokens ORDER BY token_hash" },
      ]);
      checkEqual(
        [sessions, tokens],
        [[{ user_id: 2 }], [{ token_hash: "foreign" }, { token_hash: "used" }]],
      );
    },
  },
  {
    name: "sensitive changes require configuration and the current password and reject duplicate addresses",
    async run(sql) {
      await seed(sql);
      await rejected(() => updateAccountAsync(sql, USER, { email: "new@example.com" }), "internal");
      await rejected(
        () => updateAccountAsync(sql, USER, { email: "new@example.com" }, OPTIONS),
        "bad_request",
      );
      await rejected(
        () =>
          updateAccountAsync(
            sql,
            USER,
            { email: "new@example.com", currentPassword: "wrong" },
            OPTIONS,
          ),
        "forbidden",
      );
      await rejected(
        () =>
          updateAccountAsync(
            sql,
            USER,
            { email: "OTHER@EXAMPLE.COM", currentPassword: PASSWORD },
            OPTIONS,
          ),
        "conflict",
      );
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "1");
    },
  },
  {
    name: "guard conflicts merge current profile and identity metadata with stable password hashes",
    async run(sql) {
      const hash = await seed(sql);
      let reads = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              {
                sql: "UPDATE users SET display_name = 'Concurrent', avatar_url = 'https://example.com/avatar' WHERE id = 1",
              },
              { sql: "UPDATE identities SET username = 'new-handle' WHERE user_id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[0].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const result = await completeAccountUpdateAsync(
        changing,
        USER,
        { passwordHash: "stable-hash", keepSessionId: "current" },
        hash,
      );
      checkEqual(
        [reads, hashes, result.displayName, result.avatarUrl, result.identities],
        [
          2,
          ["stable-hash", "stable-hash"],
          "Concurrent",
          "https://example.com/avatar",
          [{ provider: "github", username: "new-handle" }],
        ],
      );
    },
  },
  {
    name: "credential changes after initial lookup cannot authorize a stale sensitive update",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET password_hash = 'changed-hash' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(
        () =>
          updateAccountAsync(
            changing,
            USER,
            { email: "new@example.com", currentPassword: PASSWORD },
            OPTIONS,
          ),
        "forbidden",
      );
      const [users] = await sql.read([
        { sql: "SELECT email, password_hash FROM users WHERE id = 1" },
      ]);
      checkEqual(
        [reads, users],
        [2, [{ email: "ada@example.com", password_hash: "changed-hash" }]],
      );
    },
  },
  {
    name: "a password added during a conflict invalidates a passwordless sensitive update",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [
              { sql: "UPDATE users SET password_hash = 'new-hash' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(
        () => completeAccountUpdateAsync(changing, USER, { email: "new@example.com" }, null),
        "forbidden",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "a competing email claimant prevents the update after a conflict",
    async run(sql) {
      const hash = await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET email = 'new@example.com' WHERE id = 2" },
            ]);
          return rows;
        },
      };
      await rejected(
        () => completeAccountUpdateAsync(changing, USER, { email: "new@example.com" }, hash),
        "conflict",
      );
      const [users] = await sql.read([{ sql: "SELECT email FROM users WHERE id = 1" }]);
      checkEqual([reads, users], [2, [{ email: "ada@example.com" }]]);
    },
  },
  {
    name: "concurrent account deletion prevents a profile update",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () => completeAccountUpdateAsync(changing, USER, { displayName: "Changed" }),
        "forbidden",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "failed updates roll back profile, email, password, sessions and links together",
    async run(sql) {
      const hash = await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_account_update_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await completeAccountUpdateAsync(
          failing,
          USER,
          {
            displayName: "Changed",
            email: "new@example.com",
            passwordHash: "new-hash",
            keepSessionId: "current",
          },
          hash,
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [users, sessions, tokens, revision] = await sql.read([
        {
          sql: "SELECT display_name, email, email_verified, password_hash FROM users WHERE id = 1",
        },
        { sql: "SELECT COUNT(*) AS n FROM sessions" },
        { sql: "SELECT COUNT(*) AS n FROM email_tokens" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [users, sessions, tokens, revision[0].value],
        [
          [
            {
              display_name: "Ada",
              email: "ada@example.com",
              email_verified: 1,
              password_hash: hash,
            },
          ],
          [{ n: 3 }],
          [{ n: 5 }],
          "1",
        ],
      );
    },
  },
  {
    name: "validated updates enforce account access and permission precedence for invalid inputs",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, secretKey: OPTIONS.secretKey, passwordIterations: 10 });
      await rejected(
        () => api.updateAccount(ANONYMOUS, { displayName: "Changed" }),
        "unauthorized",
      );
      await rejected(
        () => api.updateAccount({ type: "token", tokenId: 1 }, { displayName: "Changed" }),
        "forbidden",
      );
      await rejected(() => api.updateAccount(SYSTEM, { displayName: "Changed" }), "bad_request");
      await rejected(() => api.updateAccount(USER, { email: "invalid" }), "validation_failed");
      await rejected(() => api.updateAccount(ANONYMOUS, { email: "invalid" }), "unauthorized");
      const result = await api.updateAccount(USER, {
        email: "new@example.com",
        currentPassword: PASSWORD,
        password: "New password",
        sessionId: "current",
      });
      checkEqual([result.email, result.hasPassword], ["new@example.com", true]);
    },
  },
];
