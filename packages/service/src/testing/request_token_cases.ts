// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { listLanguageRequestsAsync } from "../language_requests.ts";
import type { Sql } from "../ports.ts";
import { listApiTokensAsync } from "../tokens.ts";
import { check, checkEqual } from "./assert.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const USER: Actor = { type: "user", userId: 2 };

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    { sql: `INSERT INTO settings (id, data) VALUES (1, '{"languageRequestsEnabled":true}')` },
    {
      sql: `INSERT INTO users (id, display_name, role, created_at, deleted_at) VALUES
      (1, 'Ada', 'administrator', 100, NULL), (2, 'Bob', 'none', 100, NULL),
      (3, 'Manager', 'manager', 100, NULL), (4, 'Deleted', 'administrator', 100, 101)`,
    },
    {
      sql: `INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_by, created_at, last_used_at, revoked_at) VALUES
      (7, 'Read key', 'read', 'never-public-hash-1', 'qso_read', 1, 100, 99, NULL),
      (8, 'Revoked key', 'upload', 'never-public-hash-2', 'qso_rev', 2, 101, NULL, 102)`,
    },
    {
      sql: `INSERT INTO language_requests (id, tag, message, status, requested_by, votes, created_at) VALUES
      (10, 'es', 'Spanish please', 'pending', 2, 2, 100), (11, 'it', '', 'pending', NULL, 1, 101),
      (12, 'ru', '', 'pending', 3, 1, 102), (13, 'sv', '', 'approved', 1, 5, 100),
      (14, 'da', '', 'rejected', 1, 5, 100)`,
    },
    {
      sql: "INSERT INTO language_request_votes (request_id, user_id) VALUES (10, 2), (10, 3), (11, 1), (12, 3)",
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

export const REQUEST_TOKEN_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "public language requests show pending rows ordered by votes then ID",
    async run(sql) {
      await seed(sql);
      const result = await listLanguageRequestsAsync(sql, ANONYMOUS);
      checkEqual(
        result.requests.map((row) => [row.id, row.votes, row.voted]),
        [
          [10, 2, false],
          [11, 1, false],
          [12, 1, false],
        ],
      );
      checkEqual(result.requests[0], {
        id: 10,
        tag: "es",
        name: "Spanish",
        message: "Spanish please",
        status: "pending",
        requestedBy: { type: "user", id: 2, name: "Bob", avatarUrl: null },
        votes: 2,
        voted: false,
        createdAt: 100,
        reviewedAt: null,
        reviewedBy: null,
      });
      checkEqual(result.requests[1].requestedBy, null);
    },
  },
  {
    name: "votes are personal and revoked keys cannot read language requests",
    async run(sql) {
      await seed(sql);
      checkEqual(
        (await listLanguageRequestsAsync(sql, USER)).requests.map((row) => row.voted),
        [true, false, false],
      );
      checkEqual(
        (await listLanguageRequestsAsync(sql, ADMIN)).requests.map((row) => row.voted),
        [false, true, false],
      );
      checkEqual(
        (await listLanguageRequestsAsync(sql, { type: "user", userId: 999 })).requests.map(
          (row) => row.voted,
        ),
        [false, false, false],
      );
      await rejected(
        () => listLanguageRequestsAsync(sql, { type: "token", tokenId: 8 }),
        "forbidden",
      );
    },
  },
  {
    name: "votes, counts and attribution remain consistent across a concurrent vote removal",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [
            { sql: "DELETE FROM language_request_votes WHERE request_id = 10 AND user_id = 2" },
            { sql: "UPDATE language_requests SET votes = 1 WHERE id = 10" },
            { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 2" },
          ]);
          return rows;
        },
      };
      const first = (await listLanguageRequestsAsync(changing, USER)).requests[0];
      checkEqual([reads, first.votes, first.voted, first.requestedBy?.name], [1, 2, true, "Bob"]);
      const current = (await listLanguageRequestsAsync(sql, USER)).requests[0];
      checkEqual([current.votes, current.voted, current.requestedBy?.name], [1, false, "Changed"]);
    },
  },
  {
    name: "API-key metadata includes revoked keys and creators but never secret hashes",
    async run(sql) {
      await seed(sql);
      const result = await listApiTokensAsync(sql, ADMIN);
      checkEqual(
        result.tokens.map((row) => row.id),
        [8, 7],
      );
      checkEqual(result.tokens[0], {
        id: 8,
        name: "Revoked key",
        scope: "upload",
        prefix: "qso_rev",
        createdAt: 101,
        createdBy: { type: "user", id: 2, name: "Bob", avatarUrl: null },
        lastUsedAt: null,
        revokedAt: 102,
      });
      checkEqual(result.tokens[1], {
        id: 7,
        name: "Read key",
        scope: "read",
        prefix: "qso_read",
        createdAt: 100,
        createdBy: { type: "user", id: 1, name: "Ada", avatarUrl: null },
        lastUsedAt: 99,
        revokedAt: null,
      });
      check(!JSON.stringify(result).includes("never-public"));
    },
  },
  {
    name: "administrators and system callers list every key, people their own",
    async run(sql) {
      await seed(sql);
      const ids = async (actor: Actor) =>
        (await listApiTokensAsync(sql, actor)).tokens.map((token) => token.id);
      checkEqual(await ids(SYSTEM), [8, 7]);
      checkEqual(await ids(USER), [8]);
      checkEqual(await ids({ type: "user", userId: 3 }), []);
      await rejected(() => listApiTokensAsync(sql, ANONYMOUS), "unauthorized");
      await rejected(() => listApiTokensAsync(sql, { type: "user", userId: 4 }), "forbidden");
      await rejected(() => listApiTokensAsync(sql, { type: "token", tokenId: 7 }), "forbidden");
    },
  },
  {
    name: "API-key permissions and creators share a snapshot across administrator demotion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [
            { sql: "UPDATE users SET role = 'none', display_name = 'Changed' WHERE id = 1" },
          ]);
          return rows;
        },
      };
      const result = await listApiTokensAsync(changing, ADMIN);
      checkEqual([reads, result.tokens[1].createdBy?.name], [1, "Ada"]);
      const afterDemotion = await listApiTokensAsync(sql, ADMIN);
      checkEqual(
        afterDemotion.tokens.map((token) => token.id),
        [7],
      );
    },
  },
  {
    name: "empty request and key lists have no entries",
    async run(sql) {
      checkEqual(await listLanguageRequestsAsync(sql, ANONYMOUS), { requests: [] });
      checkEqual(await listApiTokensAsync(sql, SYSTEM), { tokens: [] });
    },
  },
];
