// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS } from "../api.ts";
import {
  completePasswordResetAsync,
  resetPasswordAsync,
  signInWithEmailLinkAsync,
  verifyEmailAsync,
} from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { verifyPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const CLOCK = () => 200;
const OPTIONS = { secretKey: "test-secret", iterations: 10 };

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, password_hash, email_verified, created_at) VALUES (1, 'ada@example.com', 'Ada', 'none', 'old-hash', 0, 100), (2, 'verified@example.com', 'Verified', 'contributor', NULL, 1, 100), (3, NULL, 'Provider user', 'none', NULL, 0, 100)",
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'ada-subject', 'octo', 100), (2, 'discord', 'verified-subject', 'verified', 100), (3, 'github', 'provider-subject', 'provider', 100)",
    },
    {
      sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('own', 1, 100, 500, 100), ('foreign', 2, 100, 500, 100), ('expired', 2, 0, 100, 0)",
    },
    {
      sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, created_at, expires_at, used_at) VALUES (?, 1, 'ada@example.com', 'verify', 100, 500, NULL), (?, 1, 'ada@example.com', 'reset', 100, 500, NULL), (?, 1, 'ada@example.com', 'reset', 100, 500, NULL), (?, 1, 'ada@example.com', 'signin', 100, 500, NULL), (?, 2, 'verified@example.com', 'signin', 100, 500, NULL), (?, 2, 'verified@example.com', 'reset', 100, 500, NULL), (?, 3, '', 'reset', 100, 500, NULL), (?, 1, 'ada@example.com', 'verify', 0, 200, NULL), (?, 1, 'ada@example.com', 'verify', 100, 500, 150)",
      params: [
        sha256Hex("verify"),
        sha256Hex("reset"),
        sha256Hex("other-reset"),
        sha256Hex("unverified-signin"),
        sha256Hex("signin"),
        sha256Hex("verified-reset"),
        sha256Hex("provider-reset"),
        sha256Hex("expired"),
        sha256Hex("used"),
      ],
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

async function failed(run: () => Promise<unknown>) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof Error);
}

export const EMAIL_LINK_CONSUMPTION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "verification consumes a token once and updates only email verification",
    async run(sql) {
      await seed(sql);
      checkEqual(await verifyEmailAsync(sql, "verify", CLOCK), { ok: true });
      const [user, token, sessions] = await sql.read([
        { sql: "SELECT email_verified, password_hash FROM users WHERE id = 1" },
        {
          sql: "SELECT used_at FROM email_tokens WHERE token_hash = ?",
          params: [sha256Hex("verify")],
        },
        { sql: "SELECT COUNT(*) AS n FROM sessions" },
      ]);
      checkEqual(
        [user, token, sessions],
        [[{ email_verified: 1, password_hash: "old-hash" }], [{ used_at: 200 }], [{ n: 3 }]],
      );
      await rejected(() => verifyEmailAsync(sql, "verify", CLOCK), "bad_request");
    },
  },
  {
    name: "missing, wrong-purpose, used and boundary-expired links are rejected without writes",
    async run(sql) {
      await seed(sql);
      await rejected(() => verifyEmailAsync(sql, "unknown", CLOCK), "bad_request");
      await rejected(() => verifyEmailAsync(sql, "reset", CLOCK), "bad_request");
      await rejected(() => verifyEmailAsync(sql, "expired", CLOCK), "bad_request");
      await rejected(() => verifyEmailAsync(sql, "used", CLOCK), "bad_request");
      await rejected(
        () => completePasswordResetAsync(sql, "verify", "hash", { clock: CLOCK }),
        "bad_request",
      );
      await rejected(() => signInWithEmailLinkAsync(sql, "reset", CLOCK), "bad_request");
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "1");
    },
  },
  {
    name: "reset recovery clears attacker identities and sessions and invalidates unused access links",
    async run(sql) {
      await seed(sql);
      const result = await resetPasswordAsync(
        sql,
        { token: "reset", password: "New password", userAgent: "Browser" },
        OPTIONS,
        CLOCK,
      );
      checkEqual(
        [
          result.user.id,
          result.user.emailVerified,
          result.user.hasPassword,
          result.user.identities,
          result.expiresAt,
        ],
        [1, true, true, [], 200 + SESSION_TTL],
      );
      const [users, sessions, links, identities] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users WHERE id = 1" },
        { sql: "SELECT id_hash, user_id FROM sessions ORDER BY user_id" },
        {
          sql: "SELECT token_hash, used_at FROM email_tokens WHERE user_id = 1 AND purpose IN ('reset', 'signin')",
        },
        { sql: "SELECT user_id FROM identities ORDER BY user_id" },
      ]);
      checkEqual(await verifyPassword("New password", users[0].password_hash as string, OPTIONS), {
        ok: true,
        needsRehash: false,
      });
      checkEqual(users[0].last_seen_at, 200);
      checkEqual(sessions, [
        { id_hash: sha256Hex(result.sessionId), user_id: 1 },
        { id_hash: "foreign", user_id: 2 },
      ]);
      checkEqual(links, [{ token_hash: sha256Hex("reset"), used_at: 200 }]);
      checkEqual(identities, [{ user_id: 2 }, { user_id: 3 }]);
      await rejected(
        () => completePasswordResetAsync(sql, "reset", "hash", { clock: CLOCK }),
        "bad_request",
      );
    },
  },
  {
    name: "reset preserves linked identities for verified or email-less accounts",
    async run(sql) {
      await seed(sql);
      const verified = await completePasswordResetAsync(sql, "verified-reset", "hash", {
        clock: CLOCK,
      });
      const provider = await completePasswordResetAsync(sql, "provider-reset", "hash", {
        clock: CLOCK,
      });
      checkEqual(
        [
          verified.user.emailVerified,
          verified.user.identities,
          provider.user.email,
          provider.user.emailVerified,
          provider.user.identities,
        ],
        [
          true,
          [{ provider: "discord", username: "verified" }],
          null,
          false,
          [{ provider: "github", username: "provider" }],
        ],
      );
    },
  },
  {
    name: "email sign-in requires verified email and consumes its token atomically with a session",
    async run(sql) {
      await seed(sql);
      await rejected(() => signInWithEmailLinkAsync(sql, "unverified-signin", CLOCK), "forbidden");
      const result = await signInWithEmailLinkAsync(sql, "signin", CLOCK, "Browser");
      checkEqual(
        [result.user.id, result.user.hasPassword, result.user.identities],
        [2, false, [{ provider: "discord", username: "verified" }]],
      );
      const [links, sessions] = await sql.read([
        {
          sql: "SELECT used_at FROM email_tokens WHERE token_hash = ?",
          params: [sha256Hex("signin")],
        },
        {
          sql: "SELECT user_agent FROM sessions WHERE id_hash = ?",
          params: [sha256Hex(result.sessionId)],
        },
      ]);
      checkEqual([links, sessions], [[{ used_at: 200 }], [{ user_agent: "Browser" }]]);
      await rejected(() => signInWithEmailLinkAsync(sql, "signin", CLOCK), "bad_request");
    },
  },
  {
    name: "competing verification consumers cannot both use a token",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await verifyEmailAsync(sql, "verify", CLOCK);
          return rows;
        },
      };
      await rejected(() => verifyEmailAsync(changing, "verify", CLOCK), "bad_request");
      checkEqual(reads, 2);
    },
  },
  {
    name: "reset conflicts refresh profile metadata while retaining proposed password and session hashes",
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
              { sql: "UPDATE users SET display_name = 'New name' WHERE id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push([
            statements.find((row) => row.sql === "UPDATE users SET password_hash = ? WHERE id = ?")!
              .params![0],
            statements.find((row) => row.sql.startsWith("INSERT INTO sessions"))!.params![0],
          ]);
          return sql.commit(revision, statements);
        },
      };
      const result = await completePasswordResetAsync(changing, "reset", "stable-hash", {
        clock: CLOCK,
      });
      checkEqual(
        [reads, result.user.displayName, hashes],
        [
          2,
          "New name",
          [
            ["stable-hash", sha256Hex(result.sessionId)],
            ["stable-hash", sha256Hex(result.sessionId)],
          ],
        ],
      );
    },
  },
  {
    name: "competing password resets cannot both consume a token",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await completePasswordResetAsync(sql, "reset", "winner-hash", { clock: CLOCK });
          return rows;
        },
      };
      await rejected(
        () => completePasswordResetAsync(changing, "reset", "loser-hash", { clock: CLOCK }),
        "bad_request",
      );
      const [users, sessions] = await sql.read([
        { sql: "SELECT password_hash FROM users WHERE id = 1" },
        { sql: "SELECT COUNT(*) AS n FROM sessions WHERE user_id = 1" },
      ]);
      checkEqual([reads, users, sessions], [2, [{ password_hash: "winner-hash" }], [{ n: 1 }]]);
    },
  },
  {
    name: "sign-in conflicts refresh identities and retain the proposed session secret",
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
              { sql: "UPDATE identities SET username = 'new-handle' WHERE user_id = 2" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(statements[2].params![0]);
          return sql.commit(revision, statements);
        },
      };
      const result = await signInWithEmailLinkAsync(changing, "signin", CLOCK);
      checkEqual(
        [reads, result.user.identities, hashes],
        [
          2,
          [{ provider: "discord", username: "new-handle" }],
          [sha256Hex(result.sessionId), sha256Hex(result.sessionId)],
        ],
      );
    },
  },
  {
    name: "a sign-in token that expires during a conflict cannot create a session",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      let calls = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 2" },
            ]);
          return rows;
        },
      };
      await rejected(
        () => signInWithEmailLinkAsync(changing, "signin", () => (++calls === 1 ? 200 : 500)),
        "bad_request",
      );
      const [link] = await sql.read([
        {
          sql: "SELECT used_at FROM email_tokens WHERE token_hash = ?",
          params: [sha256Hex("signin")],
        },
      ]);
      checkEqual([reads, link], [2, [{ used_at: null }]]);
    },
  },
  {
    name: "address changes and deletion during conflicts invalidate links without consuming them",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changedEmail: Sql = {
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
      await rejected(() => verifyEmailAsync(changedEmail, "verify", CLOCK), "bad_request");
      let nextReads = 0;
      const deleted: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++nextReads === 1)
            await sql.commit(2, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(() => signInWithEmailLinkAsync(deleted, "signin", CLOCK), "bad_request");
      checkEqual([reads, nextReads], [2, 2]);
    },
  },
  {
    name: "access-link invalidation during a conflict prevents password reset",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              {
                sql: "DELETE FROM email_tokens WHERE user_id = 1 AND purpose IN ('reset', 'signin')",
              },
            ]);
          return rows;
        },
      };
      await rejected(
        () => completePasswordResetAsync(changing, "reset", "hash", { clock: CLOCK }),
        "bad_request",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "failed consumption rolls back token, account, identities and sessions for all three paths",
    async run(sql) {
      await seed(sql);
      const queries = [
        { sql: "SELECT * FROM users ORDER BY id" },
        { sql: "SELECT * FROM identities ORDER BY id" },
        { sql: "SELECT * FROM email_tokens ORDER BY token_hash" },
        { sql: "SELECT * FROM sessions ORDER BY id_hash" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_email_consumption_table VALUES (1)" },
          ]),
      };
      await failed(() => verifyEmailAsync(failing, "verify", CLOCK));
      checkEqual(await sql.read(queries), before);
      await failed(() =>
        completePasswordResetAsync(failing, "reset", "new-hash", { clock: CLOCK }),
      );
      checkEqual(await sql.read(queries), before);
      await failed(() => signInWithEmailLinkAsync(failing, "signin", CLOCK));
      checkEqual(await sql.read(queries), before);
    },
  },
  {
    name: "validated public consumption checks inputs and logs no link or password secrets",
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
      await rejected(() => api.verifyEmail(ANONYMOUS, { token: "" }), "validation_failed");
      await rejected(
        () => api.signInWithEmailLink(ANONYMOUS, { token: "signin", userAgent: "x".repeat(1001) }),
        "validation_failed",
      );
      await rejected(
        () => api.resetPassword(ANONYMOUS, { token: "reset", password: "short" }),
        "validation_failed",
      );

      checkEqual(await api.verifyEmail(ANONYMOUS, { token: "verify" }), { ok: true });
      const reset = await api.resetPassword(ANONYMOUS, {
        token: "reset",
        password: "New password",
      });
      checkEqual(reset.user.id, 1);
      checkEqual((await api.signInWithEmailLink(ANONYMOUS, { token: "signin" })).user.id, 2);
      checkEqual(logs, [["Password reset", { userId: 1 }]]);
    },
  },
];
