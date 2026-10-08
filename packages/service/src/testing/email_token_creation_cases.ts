// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { createEmailTokenAsync, createResetLinkAsync, EMAIL_TOKEN_TTL } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const ADMIN: Actor = { type: "user", userId: 2 };
const CLOCK = () => 200;

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, email_verified, created_at, deleted_at) VALUES (1, 'ada@example.com', 'Ada', 'none', 0, 100, NULL), (2, 'admin@example.com', 'Admin', 'administrator', 1, 100, NULL), (3, NULL, 'Provider user', 'none', 0, 100, NULL), (4, 'deleted@example.com', 'Deleted', 'none', 0, 100, 150)",
    },
    {
      sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, created_at, expires_at, used_at) VALUES ('expired', 1, 'ada@example.com', 'verify', 0, 200, NULL), ('expired-used', 1, 'ada@example.com', 'reset', 0, 100, 50), ('valid', 1, 'ada@example.com', 'reset', 100, 500, NULL)",
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

export const EMAIL_TOKEN_CREATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "email token creation stores hashes, normalizes email and uses each purpose's expiry",
    async run(sql) {
      await seed(sql);
      const verify = await createEmailTokenAsync(sql, SYSTEM, " ADA@EXAMPLE.COM ", "verify", CLOCK);
      const reset = await createEmailTokenAsync(sql, SYSTEM, "ada@example.com", "reset", CLOCK);
      const signin = await createEmailTokenAsync(sql, SYSTEM, "ada@example.com", "signin", CLOCK);
      check(verify !== null && reset !== null && signin !== null);
      checkEqual(
        [verify.userId, verify.email, verify.expiresAt, reset.expiresAt, signin.expiresAt],
        [
          1,
          "ada@example.com",
          200 + EMAIL_TOKEN_TTL.verify,
          200 + EMAIL_TOKEN_TTL.reset,
          200 + EMAIL_TOKEN_TTL.signin,
        ],
      );
      const [tokens] = await sql.read([
        {
          sql: "SELECT token_hash, purpose, created_at, used_at FROM email_tokens WHERE token_hash <> 'valid' ORDER BY purpose",
        },
      ]);
      checkEqual(tokens, [
        { token_hash: sha256Hex(reset.token), purpose: "reset", created_at: 200, used_at: null },
        { token_hash: sha256Hex(signin.token), purpose: "signin", created_at: 200, used_at: null },
        { token_hash: sha256Hex(verify.token), purpose: "verify", created_at: 200, used_at: null },
      ]);
      check(verify.token !== reset.token && reset.token !== signin.token);
    },
  },
  {
    name: "unknown and deleted addresses return null without cleanup or commits; creation is system-only",
    async run(sql) {
      await seed(sql);
      const unreadable: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      await rejected(
        () => createEmailTokenAsync(unreadable, ANONYMOUS, "ada@example.com", "verify", CLOCK),
        "forbidden",
      );
      await rejected(
        () => createEmailTokenAsync(unreadable, ADMIN, "ada@example.com", "verify", CLOCK),
        "forbidden",
      );
      checkEqual(
        await createEmailTokenAsync(sql, SYSTEM, "unknown@example.com", "reset", CLOCK),
        null,
      );
      checkEqual(
        await createEmailTokenAsync(sql, SYSTEM, "deleted@example.com", "reset", CLOCK),
        null,
      );
      const [tokens, revision] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM email_tokens" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([tokens, revision[0].value], [[{ n: 3 }], "1"]);
    },
  },
  {
    name: "email token conflicts retain the secret and refresh the creation clock",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      let calls = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[1].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const result = await createEmailTokenAsync(
        changing,
        SYSTEM,
        "ada@example.com",
        "reset",
        () => (++calls === 1 ? 200 : 300),
      );
      check(result !== null);
      checkEqual(
        [reads, result.expiresAt, hashes],
        [2, 300 + EMAIL_TOKEN_TTL.reset, [sha256Hex(result.token), sha256Hex(result.token)]],
      );
    },
  },
  {
    name: "a concurrent address change prevents sending a token to the old address",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET email = 'new@example.com' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      checkEqual(
        await createEmailTokenAsync(changing, SYSTEM, "ada@example.com", "verify", CLOCK),
        null,
      );
      const [tokens] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM email_tokens" }]);
      checkEqual([reads, tokens], [2, [{ n: 3 }]]);
    },
  },
  {
    name: "administrator reset links support accounts without email and trim trailing URL slashes",
    async run(sql) {
      await seed(sql);
      const result = await createResetLinkAsync(sql, ADMIN, 3, "https://example.com///", CLOCK);
      const token = new URL(result.url).searchParams.get("token");
      check(token !== null);
      checkEqual(
        [new URL(result.url).pathname, result.expiresAt],
        ["/reset-password", 200 + 7 * 24 * 60 * 60 * 1000],
      );
      const [tokens] = await sql.read([
        { sql: "SELECT email, user_id, purpose, token_hash FROM email_tokens WHERE user_id = 3" },
      ]);
      checkEqual(tokens, [
        { email: "", user_id: 3, purpose: "reset", token_hash: sha256Hex(token) },
      ]);
      await rejected(
        () => createResetLinkAsync(sql, ADMIN, 4, "https://example.com", CLOCK),
        "not_found",
      );
      await rejected(
        () => createResetLinkAsync(sql, ADMIN, 99, "https://example.com", CLOCK),
        "not_found",
      );
    },
  },
  {
    name: "reset link conflicts refresh the target address with the same token",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const hashes: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET email = 'new@example.com' WHERE id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[1].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const result = await createResetLinkAsync(changing, ADMIN, 1, "https://example.com", CLOCK);
      const token = new URL(result.url).searchParams.get("token");
      check(token !== null);
      checkEqual([reads, hashes], [2, [sha256Hex(token), sha256Hex(token)]]);
      const [rows] = await sql.read([
        { sql: "SELECT email FROM email_tokens WHERE token_hash = ?", params: [sha256Hex(token)] },
      ]);
      checkEqual(rows, [{ email: "new@example.com" }]);
    },
  },
  {
    name: "administrator demotion during a conflict prevents reset-link creation",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(
        () => createResetLinkAsync(changing, ADMIN, 1, "https://example.com", CLOCK),
        "forbidden",
      );
      const [tokens] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM email_tokens" }]);
      checkEqual([reads, tokens], [2, [{ n: 3 }]]);
    },
  },
  {
    name: "target deletion during a conflict prevents reset-link creation",
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
        () => createResetLinkAsync(changing, ADMIN, 1, "https://example.com", CLOCK),
        "not_found",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "failed token creation rolls back expiry cleanup and insertion for both paths",
    async run(sql) {
      await seed(sql);
      const queries = [
        { sql: "SELECT * FROM email_tokens ORDER BY token_hash" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_email_creation_table VALUES (1)" },
          ]),
      };
      let emailFailure: unknown;
      try {
        await createEmailTokenAsync(failing, SYSTEM, "ada@example.com", "verify", CLOCK);
      } catch (error) {
        emailFailure = error;
      }
      check(emailFailure instanceof Error);
      checkEqual(await sql.read(queries), before);
      let resetFailure: unknown;
      try {
        await createResetLinkAsync(failing, ADMIN, 1, "https://example.com", CLOCK);
      } catch (error) {
        resetFailure = error;
      }
      check(resetFailure instanceof Error);
      checkEqual(await sql.read(queries), before);
    },
  },
  {
    name: "validated creation enforces input/access and reset-link logs contain only the target user ID",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: CLOCK,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(
        () => api.createEmailToken(SYSTEM, { email: "invalid", purpose: "reset" }),
        "validation_failed",
      );
      await rejected(
        () => api.createEmailToken(ADMIN, { email: "ada@example.com", purpose: "reset" }),
        "forbidden",
      );
      await rejected(
        () => api.createResetLink(ANONYMOUS, { userId: 1, baseUrl: "" }),
        "unauthorized",
      );
      await rejected(
        () => api.createResetLink(ADMIN, { userId: 1, baseUrl: "" }),
        "validation_failed",
      );
      checkEqual(
        await api.createEmailToken(SYSTEM, { email: "unknown@example.com", purpose: "signin" }),
        null,
      );
      const created = await api.createEmailToken(SYSTEM, {
        email: "ada@example.com",
        purpose: "verify",
      });
      check(created !== null);
      await api.createResetLink(ADMIN, { userId: 1, baseUrl: "https://example.com" });
      checkEqual(logs, [["Reset link created", { userId: 1 }]]);
    },
  },
];
