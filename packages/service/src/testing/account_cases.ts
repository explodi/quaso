// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { getAccountAsync, getSessionAsync } from "../users.ts";
import { check, checkEqual } from "./assert.ts";

const USER: Actor = { type: "user", userId: 2 };
const KEY: Actor = { type: "token", tokenId: 7 };

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    {
      sql: `INSERT INTO users (id, email, display_name, role, languages, password_hash, email_verified, created_at, deleted_at) VALUES
      (1, 'admin@example.com', 'Admin', 'administrator', NULL, NULL, 1, 100, NULL),
      (2, 'ada@example.com', 'Ada', 'contributor', '["de"]', 'private-password-hash', 1, 100, NULL),
      (3, 'deleted@example.com', 'Deleted', 'administrator', NULL, NULL, 0, 100, 101)`,
    },
    {
      sql: `INSERT INTO users (id, display_name, role, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at, created_at)
      VALUES (4, 'Pending', 'none', 'pending', '["de","fr"]', 'Please', 50, 100)`,
    },
    {
      sql: `INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES
      (2, 'github', 'private-github-subject', 'ada-github', 100), (2, 'discord', 'private-discord-subject', 'ada-discord', 100)`,
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'Read', 'read', 'private-key-hash', 'qso_', 100)",
    },
  ]);
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const ACCOUNT_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "account details decode private profile and ordered identity summaries without secrets",
    async run(sql) {
      await seed(sql);
      const account = await getAccountAsync(sql, USER);
      checkEqual(account, {
        id: 2,
        email: "ada@example.com",
        displayName: "Ada",
        avatarUrl: null,
        role: "contributor",
        languages: ["de"],
        emailVerified: true,
        hasPassword: true,
        identities: [
          { provider: "discord", username: "ada-discord" },
          { provider: "github", username: "ada-github" },
        ],
        volunteerRequest: null,
        createdAt: 100,
      });
      check(!JSON.stringify(account).includes("private-"));
      const pending = await getAccountAsync(sql, { type: "user", userId: 4 });
      checkEqual(
        [pending.hasPassword, pending.emailVerified, pending.identities],
        [false, false, []],
      );
      checkEqual(pending.volunteerRequest, {
        status: "pending",
        languages: ["de", "fr"],
        message: "Please",
        createdAt: 50,
      });
    },
  },
  {
    name: "account details reject visitors, keys, system and deleted or missing users",
    async run(sql) {
      await seed(sql);
      await rejected(() => getAccountAsync(sql, ANONYMOUS), "unauthorized");
      await rejected(() => getAccountAsync(sql, KEY), "forbidden");
      await rejected(() => getAccountAsync(sql, SYSTEM), "bad_request");
      await rejected(() => getAccountAsync(sql, { type: "user", userId: 3 }), "forbidden");
      await rejected(() => getAccountAsync(sql, { type: "user", userId: 999 }), "forbidden");
    },
  },
  {
    name: "session views return only the current user and setup state",
    async run(sql) {
      await seed(sql);
      const empty = { user: null, setupRequired: false };
      checkEqual(await getSessionAsync(sql, ANONYMOUS), empty);
      checkEqual(await getSessionAsync(sql, KEY), empty);
      checkEqual(await getSessionAsync(sql, SYSTEM), empty);
      checkEqual(await getSessionAsync(sql, { type: "user", userId: 3 }), empty);
      checkEqual(await getSessionAsync(sql, { type: "user", userId: 999 }), empty);
      checkEqual(await getSessionAsync(sql, USER), {
        user: await getAccountAsync(sql, USER),
        setupRequired: false,
      });
    },
  },
  {
    name: "setup is required without an active administrator",
    async run(sql) {
      checkEqual(await getSessionAsync(sql, ANONYMOUS), { user: null, setupRequired: true });
      await seed(sql);
      await sql.commit(1, [{ sql: "UPDATE users SET role = 'none' WHERE id = 1" }]);
      checkEqual((await getSessionAsync(sql, USER)).setupRequired, true);
    },
  },
  {
    name: "profile and setup state remain consistent across concurrent changes",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [
            { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 2" },
            { sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" },
          ]);
          return rows;
        },
      };
      const first = await getSessionAsync(changing, USER);
      checkEqual([reads, first.user?.displayName, first.setupRequired], [1, "Ada", false]);
      const current = await getSessionAsync(sql, USER);
      checkEqual([current.user?.displayName, current.setupRequired], ["Changed", true]);
    },
  },
  {
    name: "account access and data share a snapshot across account deletion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 2" }]);
          return rows;
        },
      };
      const account = await getAccountAsync(changing, USER);
      checkEqual([reads, account.displayName], [1, "Ada"]);
      await rejected(() => getAccountAsync(sql, USER), "forbidden");
      checkEqual((await getSessionAsync(sql, USER)).user, null);
    },
  },
];
