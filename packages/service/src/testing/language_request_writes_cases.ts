// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import {
  listLanguageRequestsAsync,
  requestLanguageAsync,
  reviewLanguageRequestAsync,
} from "../language_requests.ts";
import type { Sql } from "../ports.ts";
import { addProjectLanguageAsync, updateProjectLanguageAsync } from "../settings_writes.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MEMBER: Actor = { type: "user", userId: 2 };
const OPTIONS = { model: "test", now: 200 };
const REQUEST = { tag: "IT", message: "  Please add Italian  " };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    {
      sql: `INSERT INTO settings (id, data) VALUES (1, '{"languageRequestsEnabled":true}') ON CONFLICT(id) DO UPDATE SET data = json_set(data, '$.languageRequestsEnabled', json('true'))`,
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

async function seedRemovedLanguage(sql: Sql) {
  await seed(sql);
  await sql.commit(3, [
    { sql: "DELETE FROM languages WHERE tag = 'de'" },
    {
      sql: "INSERT INTO glossary_terms (term, term_normalized, language, kind, translation, created_at, updated_at) VALUES ('Play', 'play', 'de', 'translate', 'Falsch', 100, 100)",
    },
  ]);
  await requestLanguageAsync(sql, MEMBER, { tag: "de" }, OPTIONS);
}

export const LANGUAGE_REQUEST_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "requests default off and disabling preserves existing votes",
    async run(sql) {
      await rejected(() => requestLanguageAsync(sql, SYSTEM, REQUEST, OPTIONS), "forbidden");
      await seed(sql);
      await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      await sql.commit(4, [
        {
          sql: "UPDATE settings SET data = json_set(data, '$.languageRequestsEnabled', json('false')) WHERE id = 1",
        },
      ]);
      checkEqual(await listLanguageRequestsAsync(sql, ANONYMOUS), { requests: [] });
      await rejected(() => requestLanguageAsync(sql, ADMIN, REQUEST, OPTIONS), "forbidden");
      await sql.commit(5, [
        {
          sql: "UPDATE settings SET data = json_set(data, '$.languageRequestsEnabled', json('true')) WHERE id = 1",
        },
      ]);
      const board = await listLanguageRequestsAsync(sql, MEMBER);
      checkEqual(
        [board.requests.length, board.requests[0].votes, board.requests[0].voted],
        [1, 1, true],
      );
    },
  },
  {
    name: "a concurrent disable prevents a stale vote from committing",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          reads++;
          if (reads === 1)
            await sql.commit(3, [
              {
                sql: "UPDATE settings SET data = json_set(data, '$.languageRequestsEnabled', json('false')) WHERE id = 1",
              },
            ]);
          return rows;
        },
      };
      await rejected(() => requestLanguageAsync(changing, MEMBER, REQUEST, OPTIONS), "forbidden");
      const [votes] = await sql.read([{ sql: "SELECT * FROM language_request_votes" }]);
      checkEqual([reads, votes], [2, []]);
    },
  },
  {
    name: "approval QA retries use the latest translation value",
    async run(sql) {
      await seedRemovedLanguage(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(5, [
              {
                sql: "UPDATE translations SET value = '\"Falsch\"' WHERE string_id = 2 AND language = 'de'",
              },
            ]);
          return rows;
        },
      };
      await reviewLanguageRequestAsync(changing, ADMIN, 1, { action: "approve" }, OPTIONS);
      const [qa] = await sql.read([
        { sql: "SELECT qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'" },
      ]);
      checkEqual([reads, qa], [2, [{ qa_warnings: 0 }]]);
    },
  },
  {
    name: "requests canonicalize and deduplicate while each member votes once",
    async run(sql) {
      await seed(sql);
      const created = await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      checkEqual(created, {
        id: 1,
        tag: "it",
        name: "Italian",
        message: "Please add Italian",
        status: "pending",
        requestedBy: { type: "user", id: 2, name: "Reviewer", avatarUrl: null },
        votes: 1,
        voted: true,
        createdAt: 200,
        reviewedAt: null,
        reviewedBy: null,
      });
      const voted = await requestLanguageAsync(
        sql,
        ADMIN,
        { tag: "it", message: "Ignored" },
        { ...OPTIONS, now: 300 },
      );
      checkEqual(voted, { ...created, votes: 2 });
      const noWrites: Sql = {
        ...sql,
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await requestLanguageAsync(noWrites, ADMIN, REQUEST, OPTIONS), voted);
      const [votes, revision] = await sql.read([
        { sql: "SELECT request_id, user_id FROM language_request_votes ORDER BY user_id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [votes, revision[0].value],
        [
          [
            { request_id: 1, user_id: 1 },
            { request_id: 1, user_id: 2 },
          ],
          "5",
        ],
      );
    },
  },
  {
    name: "system requests do not vote and remain unattributed when members join",
    async run(sql) {
      await seed(sql);
      const created = await requestLanguageAsync(sql, SYSTEM, REQUEST, OPTIONS);
      checkEqual([created.votes, created.voted, created.requestedBy], [0, false, null]);
      checkEqual(await requestLanguageAsync(sql, SYSTEM, REQUEST, OPTIONS), created);
      const voted = await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      checkEqual(
        [voted.id, voted.votes, voted.voted, voted.requestedBy],
        [1, 1, true, created.requestedBy],
      );
    },
  },
  {
    name: "request access and source or existing-language conflicts retain errors",
    async run(sql) {
      await seed(sql);
      await rejected(() => requestLanguageAsync(sql, ANONYMOUS, REQUEST, OPTIONS), "unauthorized");
      await rejected(
        () => requestLanguageAsync(sql, { type: "token", tokenId: 7 }, REQUEST, OPTIONS),
        "forbidden",
      );
      await rejected(
        () => requestLanguageAsync(sql, MEMBER, { tag: "EN" }, OPTIONS),
        "bad_request",
      );
      await rejected(() => requestLanguageAsync(sql, MEMBER, { tag: "DE" }, OPTIONS), "conflict");
      await rejected(
        () => requestLanguageAsync(sql, MEMBER, { tag: "xyz" }, OPTIONS),
        "bad_request",
      );
      await rejected(
        () => requestLanguageAsync(sql, MEMBER, { tag: "not a tag!" }, OPTIONS),
        "bad_request",
      );
      await rejected(
        () => reviewLanguageRequestAsync(sql, MEMBER, 1, { action: "approve" }, OPTIONS),
        "forbidden",
      );
      await rejected(
        () => reviewLanguageRequestAsync(sql, ADMIN, 999, { action: "approve" }, OPTIONS),
        "not_found",
      );
    },
  },
  {
    name: "approval restores a removed language and commits QA with review attribution",
    async run(sql) {
      await seedRemovedLanguage(sql);
      const approved = await reviewLanguageRequestAsync(
        sql,
        ADMIN,
        1,
        { action: "approve" },
        { ...OPTIONS, now: 300 },
      );
      checkEqual(
        [approved.status, approved.reviewedAt, approved.reviewedBy, approved.voted],
        ["approved", 300, { type: "user", id: 1, name: "Ada", avatarUrl: null }, false],
      );
      const [languages, qa, revision] = await sql.read([
        {
          sql: "SELECT tag, instructions, plural_override, created_at FROM languages WHERE tag = 'de'",
        },
        { sql: "SELECT qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [languages, qa, revision[0].value],
        [
          [{ tag: "de", instructions: "", plural_override: null, created_at: 300 }],
          [{ qa_warnings: 1 }],
          "6",
        ],
      );
      checkEqual((await listLanguageRequestsAsync(sql, ANONYMOUS)).requests, []);
      await rejected(
        () => reviewLanguageRequestAsync(sql, ADMIN, 1, { action: "reject" }, OPTIONS),
        "conflict",
      );
    },
  },
  {
    name: "rejection permits a fresh request and fresh personal votes",
    async run(sql) {
      await seed(sql);
      await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      const rejectedRequest = await reviewLanguageRequestAsync(
        sql,
        SYSTEM,
        1,
        { action: "reject" },
        OPTIONS,
      );
      checkEqual([rejectedRequest.status, rejectedRequest.reviewedBy], ["rejected", null]);
      const renewed = await requestLanguageAsync(sql, MEMBER, REQUEST, { ...OPTIONS, now: 300 });
      checkEqual(
        [renewed.id, renewed.status, renewed.votes, renewed.createdAt],
        [2, "pending", 1, 300],
      );
    },
  },
  {
    name: "overlapping members join one request while overlapping personal votes remain singular",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await requestLanguageAsync(sql, ADMIN, REQUEST, OPTIONS);
          return rows;
        },
      };
      const joined = await requestLanguageAsync(changing, MEMBER, REQUEST, OPTIONS);
      checkEqual([reads, joined.id, joined.votes], [2, 1, 2]);
      let personalReads = 0;
      const personal: Sql = {
        ...sql,
        async read(statements) {
          personalReads++;
          const rows = await sql.read(statements);
          if (personalReads === 1) await requestLanguageAsync(sql, MEMBER, { tag: "es" }, OPTIONS);
          return rows;
        },
      };
      const repeated = await requestLanguageAsync(personal, MEMBER, { tag: "es" }, OPTIONS);
      checkEqual([personalReads, repeated.id, repeated.votes], [2, 2, 1]);
    },
  },
  {
    name: "a concurrently added project language prevents a stale request",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) await addProjectLanguageAsync(sql, SYSTEM, "it", OPTIONS);
          return rows;
        },
      };
      await rejected(() => requestLanguageAsync(changing, MEMBER, REQUEST, OPTIONS), "conflict");
      checkEqual([reads, (await listLanguageRequestsAsync(sql, ANONYMOUS)).requests], [2, []]);
    },
  },
  {
    name: "the first competing review wins without a second language addition",
    async run(sql) {
      await seed(sql);
      await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await reviewLanguageRequestAsync(sql, SYSTEM, 1, { action: "reject" }, OPTIONS);
          return rows;
        },
      };
      await rejected(
        () => reviewLanguageRequestAsync(changing, ADMIN, 1, { action: "approve" }, OPTIONS),
        "conflict",
      );
      const [language, request] = await sql.read([
        { sql: "SELECT tag FROM languages WHERE tag = 'it'" },
        { sql: "SELECT status FROM language_requests WHERE id = 1" },
      ]);
      checkEqual([reads, language, request], [2, [], [{ status: "rejected" }]]);
    },
  },
  {
    name: "review rechecks administrator access after demotion",
    async run(sql) {
      await seed(sql);
      await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(4, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () => reviewLanguageRequestAsync(changing, ADMIN, 1, { action: "approve" }, OPTIONS),
        "forbidden",
      );
      checkEqual(
        [reads, (await listLanguageRequestsAsync(sql, ANONYMOUS)).requests[0].status],
        [2, "pending"],
      );
    },
  },
  {
    name: "approval tolerates a competing language addition without resetting its instructions",
    async run(sql) {
      await seed(sql);
      await requestLanguageAsync(sql, MEMBER, REQUEST, OPTIONS);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1) {
            await addProjectLanguageAsync(sql, SYSTEM, "it", OPTIONS);
            await updateProjectLanguageAsync(
              sql,
              SYSTEM,
              "it",
              { instructions: "Existing" },
              OPTIONS,
            );
          }
          return rows;
        },
      };
      checkEqual(
        (await reviewLanguageRequestAsync(changing, ADMIN, 1, { action: "approve" }, OPTIONS))
          .status,
        "approved",
      );
      const [language] = await sql.read([
        { sql: "SELECT instructions FROM languages WHERE tag = 'it'" },
      ]);
      checkEqual([reads, language], [2, [{ instructions: "Existing" }]]);
    },
  },
  {
    name: "failed approval rolls back the language, QA, review state and revision",
    async run(sql) {
      await seedRemovedLanguage(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_request_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await reviewLanguageRequestAsync(failing, ADMIN, 1, { action: "approve" }, OPTIONS);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [language, qa, request, revision] = await sql.read([
        { sql: "SELECT tag FROM languages WHERE tag = 'de'" },
        { sql: "SELECT qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'" },
        { sql: "SELECT status, reviewed_at FROM language_requests WHERE id = 1" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [language, qa, request, revision[0].value],
        [[], [{ qa_warnings: 0 }], [{ status: "pending", reviewed_at: null }], "5"],
      );
    },
  },
  {
    name: "validated request entry points preserve access, input errors and successful approval logging",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: () => 200,
        defaultModel: "test",
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(() => api.requestLanguage(ANONYMOUS, { tag: "" }), "unauthorized");
      await rejected(() => api.requestLanguage(MEMBER, { tag: "" }), "validation_failed");
      const created = await api.requestLanguage(MEMBER, REQUEST);
      checkEqual(
        (await api.reviewLanguageRequest(ADMIN, { id: created.id, action: "approve" })).status,
        "approved",
      );
      checkEqual(logs, [["Language added", { language: "it", actor: { type: "user", id: 1 } }]]);
    },
  },
];
