// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { signInWithIdentityAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { SESSION_TOUCH_INTERVAL, SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const FIELDS = { provider: "github" as const, subject: "new-subject", username: "octo" };
const CLOCK = () => 200;

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, email_verified, created_at, deleted_at) VALUES (1, 'admin@example.com', 'Admin', 'administrator', 1, 100, NULL), (2, 'verified@example.com', 'Verified', 'none', 1, 100, NULL), (3, 'unverified@example.com', 'Unverified', 'none', 0, 100, NULL), (4, NULL, 'Deleted', 'none', 0, 100, 150)",
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (2, 'discord', 'existing-subject', 'existing', 100)",
    },
    {
      sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, 2, 100, 500, 100)",
      params: [sha256Hex("link-session")],
    },
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

export const IDENTITY_SIGN_IN_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "new provider accounts keep unverified email off the user and return a hashed session",
    async run(sql) {
      await seed(sql);
      const result = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        {
          ...FIELDS,
          email: "UNVERIFIED@EXAMPLE.COM",
          displayName: " Ada ",
          avatarUrl: "https://example.com/avatar",
          userAgent: "Browser",
        },
        CLOCK,
      );
      checkEqual(
        [
          result.created,
          result.user.id,
          result.user.email,
          result.user.displayName,
          result.user.hasPassword,
          result.user.identities,
        ],
        [true, 5, null, "Ada", false, [{ provider: "github", username: "octo" }]],
      );
      check(result.sessionId !== null);
      const [users, identities, sessions] = await sql.read([
        { sql: "SELECT avatar_url, email_verified, last_seen_at FROM users WHERE id = 5" },
        { sql: "SELECT email, avatar_url FROM identities WHERE user_id = 5" },
        { sql: "SELECT id_hash, user_agent FROM sessions WHERE user_id = 5" },
      ]);
      checkEqual(users, [
        { avatar_url: "https://example.com/avatar", email_verified: 0, last_seen_at: 200 },
      ]);
      checkEqual(identities, [
        { email: "unverified@example.com", avatar_url: "https://example.com/avatar" },
      ]);
      checkEqual(sessions, [{ id_hash: sha256Hex(result.sessionId), user_agent: "Browser" }]);
      checkEqual(result.expiresAt, 200 + SESSION_TTL);
    },
  },
  {
    name: "verified provider email creates or finds an account but never auto-links an unverified account",
    async run(sql) {
      await seed(sql);
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, email: "unverified@example.com", emailVerified: true },
            CLOCK,
          ),
        "conflict",
      );
      const existing = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        { ...FIELDS, email: " VERIFIED@EXAMPLE.COM ", emailVerified: true },
        CLOCK,
      );
      checkEqual(
        [existing.created, existing.user.id, existing.user.identities],
        [
          false,
          2,
          [
            { provider: "discord", username: "existing" },
            { provider: "github", username: "octo" },
          ],
        ],
      );
      const fresh = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        { ...FIELDS, subject: "fresh", email: " NEW@example.com ", emailVerified: true },
        CLOCK,
      );
      checkEqual(
        [fresh.created, fresh.user.email, fresh.user.emailVerified],
        [true, "new@example.com", true],
      );
    },
  },
  {
    name: "repeat provider sign-in refreshes identity metadata without changing the account's name or email",
    async run(sql) {
      await seed(sql);
      const first = await signInWithIdentityAsync(sql, SYSTEM, FIELDS, CLOCK);
      const next = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        {
          ...FIELDS,
          username: "new-handle",
          email: "new@example.com",
          emailVerified: true,
          displayName: "Ignored",
          avatarUrl: "https://example.com/avatar",
        },
        CLOCK,
      );
      checkEqual(
        [
          next.created,
          next.user.id,
          next.user.displayName,
          next.user.email,
          next.user.avatarUrl,
          next.user.identities,
        ],
        [
          false,
          first.user.id,
          "octo",
          null,
          "https://example.com/avatar",
          [{ provider: "github", username: "new-handle" }],
        ],
      );
    },
  },
  {
    name: "explicit linking verifies a matching email, fills the avatar and returns no new session",
    async run(sql) {
      await seed(sql);
      const result = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        {
          ...FIELDS,
          linkToUserId: 3,
          email: "unverified@example.com",
          emailVerified: true,
          avatarUrl: "https://example.com/avatar",
        },
        CLOCK,
      );
      checkEqual(
        [
          result.created,
          result.sessionId,
          result.expiresAt,
          result.user.id,
          result.user.emailVerified,
          result.user.avatarUrl,
        ],
        [false, null, null, 3, true, "https://example.com/avatar"],
      );
      await rejected(
        () => signInWithIdentityAsync(sql, SYSTEM, { ...FIELDS, linkToUserId: 2 }, CLOCK),
        "conflict",
      );
      const [sessions] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM sessions" }]);
      checkEqual(sessions, [{ n: 1 }]);
    },
  },
  {
    name: "provider entry is system-only, new accounts require setup, and deleted targets are refused",
    async run(sql) {
      const unreadable: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      await rejected(
        () => signInWithIdentityAsync(unreadable, ANONYMOUS, FIELDS, CLOCK),
        "forbidden",
      );
      await rejected(() => signInWithIdentityAsync(sql, SYSTEM, FIELDS, CLOCK), "setup_required");
      await seed(sql);
      await rejected(
        () => signInWithIdentityAsync(sql, SYSTEM, { ...FIELDS, linkToUserId: 4 }, CLOCK),
        "not_found",
      );
      await rejected(
        () => signInWithIdentityAsync(sql, SYSTEM, { ...FIELDS, linkToUserId: 99 }, CLOCK),
        "not_found",
      );
    },
  },
  {
    name: "invites grant new provider accounts once and are ignored for existing accounts",
    async run(sql) {
      await seed(sql);
      const created = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        { ...FIELDS, invite: "invite" },
        CLOCK,
      );
      checkEqual([created.user.role, created.user.languages], ["manager", ["de"]]);
      const existing = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        { ...FIELDS, invite: "unknown" },
        CLOCK,
      );
      checkEqual(existing.created, false);
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, subject: "other", invite: "invite" },
            CLOCK,
          ),
        "bad_request",
      );
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, subject: "other", invite: "expired" },
            CLOCK,
          ),
        "bad_request",
      );
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, subject: "other", invite: "revoked" },
            CLOCK,
          ),
        "bad_request",
      );
    },
  },
  {
    name: "browser linking rechecks session ownership and expiry and touches it atomically when due",
    async run(sql) {
      await seed(sql);
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, linkToUserId: 2, linkSessionId: "missing" },
            CLOCK,
          ),
        "unauthorized",
      );
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, linkToUserId: 3, linkSessionId: "link-session" },
            CLOCK,
          ),
        "unauthorized",
      );
      await rejected(
        () =>
          signInWithIdentityAsync(
            sql,
            SYSTEM,
            { ...FIELDS, linkToUserId: 2, linkSessionId: "link-session" },
            () => 500,
          ),
        "unauthorized",
      );
      await sql.commit(1, [{ sql: "UPDATE sessions SET expires_at = 10000000 WHERE user_id = 2" }]);
      const now = 100 + SESSION_TOUCH_INTERVAL;
      const result = await signInWithIdentityAsync(
        sql,
        SYSTEM,
        { ...FIELDS, linkToUserId: 2, linkSessionId: "link-session" },
        () => now,
      );
      const [sessions, user] = await sql.read([
        { sql: "SELECT expires_at, last_seen_at FROM sessions" },
        { sql: "SELECT last_seen_at FROM users WHERE id = 2" },
      ]);
      checkEqual(
        [result.sessionId, sessions, user],
        [null, [{ expires_at: now + SESSION_TTL, last_seen_at: now }], [{ last_seen_at: now }]],
      );
    },
  },
  {
    name: "competing provider sign-ins reuse the committed identity instead of creating duplicate users",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await signInWithIdentityAsync(sql, SYSTEM, FIELDS, CLOCK);
          return rows;
        },
      };
      const result = await signInWithIdentityAsync(changing, SYSTEM, FIELDS, CLOCK);
      const [users, identities] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM users" },
        { sql: "SELECT COUNT(*) AS n FROM identities WHERE subject = 'new-subject'" },
      ]);
      checkEqual(
        [reads, result.created, result.user.id, users, identities],
        [2, false, 5, [{ n: 5 }], [{ n: 1 }]],
      );
    },
  },
  {
    name: "ID conflicts reallocate the account while retaining the proposed session secret",
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
              {
                sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (5, 'Competing', 'none', 100)",
              },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          hashes.push(
            statements.find((row) => row.sql.startsWith("INSERT INTO sessions"))!.params![0],
          );
          return sql.commit(revision, statements);
        },
      };
      const result = await signInWithIdentityAsync(changing, SYSTEM, FIELDS, CLOCK);
      check(result.sessionId !== null);
      checkEqual(
        [reads, result.user.id, hashes],
        [2, 6, [sha256Hex(result.sessionId), sha256Hex(result.sessionId)]],
      );
    },
  },
  {
    name: "a concurrently unverified email prevents automatic linking",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET email_verified = 0 WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(
        () =>
          signInWithIdentityAsync(
            changing,
            SYSTEM,
            { ...FIELDS, email: "verified@example.com", emailVerified: true },
            CLOCK,
          ),
        "conflict",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "logout during a conflict prevents linking after the browser session has ended",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [{ sql: "DELETE FROM sessions WHERE user_id = 2" }]);
          return rows;
        },
      };
      await rejected(
        () =>
          signInWithIdentityAsync(
            changing,
            SYSTEM,
            { ...FIELDS, linkToUserId: 2, linkSessionId: "link-session" },
            CLOCK,
          ),
        "unauthorized",
      );
      const [identities] = await sql.read([
        { sql: "SELECT subject FROM identities WHERE provider = 'github'" },
      ]);
      checkEqual([reads, identities], [2, []]);
    },
  },
  {
    name: "competing invite consumption prevents a second provider account receiving the grant",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await signInWithIdentityAsync(
              sql,
              SYSTEM,
              { ...FIELDS, subject: "winner", invite: "invite" },
              CLOCK,
            );
          return rows;
        },
      };
      await rejected(
        () => signInWithIdentityAsync(changing, SYSTEM, { ...FIELDS, invite: "invite" }, CLOCK),
        "bad_request",
      );
      const [users] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'manager'" },
      ]);
      checkEqual([reads, users], [2, [{ n: 1 }]]);
    },
  },
  {
    name: "failed provider sign-in rolls back account, identity, invite and session changes",
    async run(sql) {
      await seed(sql);
      const queries = [
        { sql: "SELECT * FROM users ORDER BY id" },
        { sql: "SELECT * FROM identities ORDER BY id" },
        { sql: "SELECT * FROM invites ORDER BY id" },
        { sql: "SELECT * FROM sessions ORDER BY id_hash" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_identity_signin_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await signInWithIdentityAsync(failing, SYSTEM, { ...FIELDS, invite: "invite" }, CLOCK);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(await sql.read(queries), before);
    },
  },
  {
    name: "validated provider entry checks metadata and exposes system-only sign-in and linking",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: CLOCK });
      await rejected(
        () => api.signInWithIdentity(SYSTEM, { ...FIELDS, subject: "" }),
        "validation_failed",
      );
      await rejected(() => api.signInWithIdentity(ANONYMOUS, FIELDS), "forbidden");
      const result = await api.signInWithIdentity(SYSTEM, {
        ...FIELDS,
        linkToUserId: 2,
        linkSessionId: "link-session",
      });
      checkEqual(
        [result.user.id, result.sessionId, result.user.identities],
        [
          2,
          null,
          [
            { provider: "discord", username: "existing" },
            { provider: "github", username: "octo" },
          ],
        ],
      );
    },
  },
];
