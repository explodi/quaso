// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { ANONYMOUS } from "../api.ts";
import { completeSignInAsync, signInAsync, WRONG_CREDENTIALS } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import { hashPassword, parseHash, verifyPassword } from "../passwords.ts";
import type { Sql } from "../ports.ts";
import { SESSION_TTL } from "../sessions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const PASSWORD = "Long password";
const OPTIONS = { secretKey: "test-secret", iterations: 10 };
const REQUEST = { email: " ADA@example.com ", password: PASSWORD, userAgent: "Browser" };

async function seed(sql: Sql, iterations = 10) {
  const hash = await hashPassword(PASSWORD, { ...OPTIONS, iterations });
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, password_hash, created_at) VALUES (1, 'ada@example.com', 'Ada', 'contributor', ?, 100)",
      params: [hash],
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'subject', 'ada', 100)",
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
  return failure;
}

export const SIGN_IN_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "password sign-in is independent of the instance key and needs no key configuration",
    async run(sql) {
      await seed(sql);
      const first = asyncWriteMethods({ sql, secretKey: "original-key", passwordIterations: 10 });
      checkEqual(
        (await first.signIn(ANONYMOUS, { ...REQUEST, email: "ada@example.com" })).user.id,
        1,
      );
      const rotated = asyncWriteMethods({
        sql,
        secretKey: "different-key",
        passwordIterations: 10,
      });
      checkEqual(
        (await rotated.signIn(ANONYMOUS, { ...REQUEST, email: "ada@example.com" })).user.id,
        1,
      );
      const independent = asyncWriteMethods({ sql, passwordIterations: 10 });
      checkEqual(
        (await independent.signIn(ANONYMOUS, { ...REQUEST, email: "ada@example.com" })).user.id,
        1,
      );
    },
  },
  {
    name: "sign-in normalizes email and returns the complete account with a hashed session",
    async run(sql) {
      const hash = await seed(sql);
      const signedIn = await signInAsync(sql, REQUEST, OPTIONS, () => 200);
      checkEqual(signedIn.user, {
        id: 1,
        email: "ada@example.com",
        displayName: "Ada",
        avatarUrl: null,
        role: "contributor",
        languages: null,
        emailVerified: false,
        hasPassword: true,
        identities: [{ provider: "github", username: "ada" }],
        volunteerRequest: null,
        createdAt: 100,
      });
      checkEqual(signedIn.expiresAt, 200 + SESSION_TTL);
      const [user, sessions] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users WHERE id = 1" },
        { sql: "SELECT id_hash, user_agent FROM sessions" },
      ]);
      checkEqual(
        [user, sessions],
        [
          [{ password_hash: hash, last_seen_at: 200 }],
          [{ id_hash: sha256Hex(signedIn.sessionId), user_agent: "Browser" }],
        ],
      );
      check(!JSON.stringify(signedIn).includes(hash));
    },
  },
  {
    name: "older password hashes rehash and create the session atomically",
    async run(sql) {
      const old = await seed(sql, 5);
      await signInAsync(sql, REQUEST, OPTIONS, () => 200);
      const [user, sessions, revision] = await sql.read([
        { sql: "SELECT password_hash FROM users WHERE id = 1" },
        { sql: "SELECT COUNT(*) AS n FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      const hash = user[0].password_hash as string;
      check(hash !== old);
      checkEqual(parseHash(hash)?.iterations, 10);
      checkEqual(await verifyPassword(PASSWORD, hash, OPTIONS), { ok: true, needsRehash: false });
      checkEqual([sessions, revision[0].value], [[{ n: 1 }], "2"]);
    },
  },
  {
    name: "wrong, unknown, passwordless and deleted credentials share the same error and private logs",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const logger = {
        info: (message: string, data?: unknown) => logs.push([message, data]),
        debug() {},
        warn() {},
        error() {},
      };
      checkEqual(
        (
          await rejected(
            () => signInAsync(sql, { ...REQUEST, password: "Wrong" }, OPTIONS, () => 200, logger),
            "unauthorized",
          )
        ).message,
        WRONG_CREDENTIALS,
      );
      checkEqual(
        (
          await rejected(
            () =>
              signInAsync(
                sql,
                { ...REQUEST, email: "nobody@example.com" },
                OPTIONS,
                () => 200,
                logger,
              ),
            "unauthorized",
          )
        ).message,
        WRONG_CREDENTIALS,
      );
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      checkEqual(
        (
          await rejected(
            () => signInAsync(sql, REQUEST, OPTIONS, () => 200, logger),
            "unauthorized",
          )
        ).message,
        WRONG_CREDENTIALS,
      );
      await sql.commit(2, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
      checkEqual(
        (
          await rejected(
            () => signInAsync(sql, REQUEST, OPTIONS, () => 200, logger),
            "unauthorized",
          )
        ).message,
        WRONG_CREDENTIALS,
      );
      checkEqual(logs, [
        ["Sign-in refused", undefined],
        ["Sign-in refused", undefined],
        ["Sign-in refused", undefined],
        ["Sign-in refused", undefined],
      ]);
    },
  },
  {
    name: "a credential change after password lookup prevents a session",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET password_hash = 'changed' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(() => signInAsync(changing, REQUEST, OPTIONS, () => 200), "unauthorized");
      const [sessions] = await sql.read([{ sql: "SELECT id_hash FROM sessions" }]);
      checkEqual([reads, sessions], [2, []]);
    },
  },
  {
    name: "guard conflicts recheck the credential before applying a rehash or session",
    async run(sql) {
      const checked = await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET password_hash = 'changed' WHERE id = 1" },
            ]);
          return rows;
        },
      };
      await rejected(
        () => completeSignInAsync(changing, 1, checked, "rehash", 200),
        "unauthorized",
      );
      const [user, sessions] = await sql.read([
        { sql: "SELECT password_hash FROM users WHERE id = 1" },
        { sql: "SELECT id_hash FROM sessions" },
      ]);
      checkEqual([reads, user, sessions], [2, [{ password_hash: "changed" }], []]);
    },
  },
  {
    name: "account deletion during commit prevents sign-in on retry",
    async run(sql) {
      const checked = await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 150 WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => completeSignInAsync(changing, 1, checked, null, 200), "unauthorized");
      const [sessions] = await sql.read([{ sql: "SELECT id_hash FROM sessions" }]);
      checkEqual([reads, sessions], [2, []]);
    },
  },
  {
    name: "profile conflicts refresh account metadata without changing the proposed hashes",
    async run(sql) {
      const checked = await seed(sql);
      const rehash = await hashPassword(PASSWORD, OPTIONS);
      let reads = 0;
      const commits: unknown[] = [];
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'New name', role = 'manager' WHERE id = 1" },
              { sql: "UPDATE identities SET username = 'new-github' WHERE user_id = 1" },
            ]);
          return rows;
        },
        async commit(revision, statements) {
          commits.push([statements[0].params![0], statements[2].params![0]]);
          return sql.commit(revision, statements);
        },
      };
      const result = await completeSignInAsync(changing, 1, checked, rehash, 200);
      checkEqual(
        [reads, result.user.displayName, result.user.role, result.user.identities],
        [2, "New name", "manager", [{ provider: "github", username: "new-github" }]],
      );
      checkEqual(commits, [
        [rehash, sha256Hex(result.sessionId)],
        [rehash, sha256Hex(result.sessionId)],
      ]);
    },
  },
  {
    name: "failed completion rolls back rehash, expiry cleanup, session and user last-use",
    async run(sql) {
      const checked = await seed(sql);
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
            { sql: "INSERT INTO missing_signin_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await completeSignInAsync(failing, 1, checked, "rehash", 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [user, sessions, revision] = await sql.read([
        { sql: "SELECT password_hash, last_seen_at FROM users WHERE id = 1" },
        { sql: "SELECT id_hash FROM sessions" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [user, sessions, revision[0].value],
        [[{ password_hash: checked, last_seen_at: null }], [{ id_hash: "old" }], "2"],
      );
    },
  },
  {
    name: "validated sign-in entry points validate before hashing",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({
        sql,
        clock: () => 200,
        passwordIterations: 10,
      });
      await rejected(
        () => api.signIn(ANONYMOUS, { email: "invalid", password: PASSWORD }),
        "validation_failed",
      );
      checkEqual(
        (await api.signIn(ANONYMOUS, { ...REQUEST, email: "ADA@example.com" })).user.id,
        1,
      );
    },
  },
];
