// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { unlinkIdentityAsync } from "../accounts.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const USER: Actor = { type: "user", userId: 1 };

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, password_hash, email_verified, created_at) VALUES (1, 'ada@example.com', 'Ada', 'none', 'hash', 1, 100)",
    },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'gh-subject', 'octo', 100), (1, 'discord', 'dc-subject', 'ada', 100)",
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

export const IDENTITY_UNLINK_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "unlink removes only the caller's selected identity and returns the remaining account metadata",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (2, 'Other', 'none', 100)",
        },
        {
          sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (2, 'github', 'other-subject', 'other', 100)",
        },
      ]);
      const result = await unlinkIdentityAsync(sql, USER, "github");
      checkEqual(result, {
        id: 1,
        email: "ada@example.com",
        displayName: "Ada",
        avatarUrl: null,
        role: "none",
        languages: null,
        emailVerified: true,
        hasPassword: true,
        identities: [{ provider: "discord", username: "ada" }],
        volunteerRequest: null,
        createdAt: 100,
      });
      const [identities] = await sql.read([
        { sql: "SELECT user_id, provider FROM identities ORDER BY user_id, provider" },
      ]);
      checkEqual(identities, [
        { user_id: 1, provider: "discord" },
        { user_id: 2, provider: "github" },
      ]);
      check(!JSON.stringify(result).includes('"hash"'));
    },
  },
  {
    name: "a password with an email permits removing the last provider; missing providers do not write",
    async run(sql) {
      await seed(sql);
      await unlinkIdentityAsync(sql, USER, "github");
      checkEqual((await unlinkIdentityAsync(sql, USER, "discord")).identities, []);
      await rejected(() => unlinkIdentityAsync(sql, USER, "github"), "not_found");
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "3");
    },
  },
  {
    name: "a passwordless person must keep one provider",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      checkEqual((await unlinkIdentityAsync(sql, USER, "github")).identities, [
        { provider: "discord", username: "ada" },
      ]);
      await rejected(() => unlinkIdentityAsync(sql, USER, "discord"), "bad_request");
      const [identities] = await sql.read([{ sql: "SELECT provider FROM identities" }]);
      checkEqual(identities, [{ provider: "discord" }]);
    },
  },
  {
    name: "a password without an email is not an available sign-in method",
    async run(sql) {
      await seed(sql);
      await unlinkIdentityAsync(sql, USER, "github");
      await sql.commit(2, [{ sql: "UPDATE users SET email = NULL WHERE id = 1" }]);
      await rejected(() => unlinkIdentityAsync(sql, USER, "discord"), "bad_request");
    },
  },
  {
    name: "unlink enforces account access and a signed-in person",
    async run(sql) {
      await seed(sql);
      await rejected(() => unlinkIdentityAsync(sql, ANONYMOUS, "github"), "unauthorized");
      await rejected(
        () => unlinkIdentityAsync(sql, { type: "token", tokenId: 1 }, "github"),
        "forbidden",
      );
      await rejected(
        () => unlinkIdentityAsync(sql, { type: "user", userId: 99 }, "github"),
        "forbidden",
      );
      await rejected(() => unlinkIdentityAsync(sql, SYSTEM, "github"), "bad_request");
      await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
      await rejected(() => unlinkIdentityAsync(sql, USER, "github"), "forbidden");
    },
  },
  {
    name: "simultaneous unlinks cannot remove both sign-in methods of a passwordless person",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await unlinkIdentityAsync(sql, USER, "discord");
          return rows;
        },
      };
      await rejected(() => unlinkIdentityAsync(changing, USER, "github"), "bad_request");
      const [identities] = await sql.read([{ sql: "SELECT provider FROM identities" }]);
      checkEqual([reads, identities], [2, [{ provider: "github" }]]);
    },
  },
  {
    name: "password removal during a conflict prevents unlinking the remaining provider",
    async run(sql) {
      await seed(sql);
      await unlinkIdentityAsync(sql, USER, "discord");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [{ sql: "UPDATE users SET password_hash = NULL WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => unlinkIdentityAsync(changing, USER, "github"), "bad_request");
      checkEqual(reads, 2);
    },
  },
  {
    name: "account deletion during a conflict prevents unlinking",
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
      await rejected(() => unlinkIdentityAsync(changing, USER, "github"), "forbidden");
      const [identities] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM identities" }]);
      checkEqual([reads, identities], [2, [{ n: 2 }]]);
    },
  },
  {
    name: "conflicts refresh account metadata and a competing unlink returns not found",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [
              { sql: "UPDATE users SET display_name = 'New name' WHERE id = 1" },
              {
                sql: "UPDATE identities SET username = 'new-handle' WHERE user_id = 1 AND provider = 'discord'",
              },
            ]);
          return rows;
        },
      };
      const result = await unlinkIdentityAsync(changing, USER, "github");
      checkEqual(
        [reads, result.displayName, result.identities],
        [2, "New name", [{ provider: "discord", username: "new-handle" }]],
      );
      let nextReads = 0;
      const competing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++nextReads === 1) await unlinkIdentityAsync(sql, USER, "discord");
          return rows;
        },
      };
      await rejected(() => unlinkIdentityAsync(competing, USER, "discord"), "not_found");
      checkEqual(nextReads, 2);
    },
  },
  {
    name: "failed unlink commits roll back the identity deletion and revision",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_unlink_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await unlinkIdentityAsync(failing, USER, "github");
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [identities, revision] = await sql.read([
        { sql: "SELECT provider FROM identities ORDER BY provider" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [identities, revision[0].value],
        [[{ provider: "discord" }, { provider: "github" }], "1"],
      );
    },
  },
  {
    name: "validated unlink rejects unknown providers and retains permission-error precedence",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql });
      await rejected(
        () => api.unlinkIdentity(USER, { provider: "unknown" as "github" }),
        "validation_failed",
      );
      await rejected(
        () => api.unlinkIdentity(ANONYMOUS, { provider: "unknown" as "github" }),
        "unauthorized",
      );
      const result = await api.unlinkIdentity(USER, { provider: "github" });
      checkEqual(result.identities, [{ provider: "discord", username: "ada" }]);
    },
  },
];
