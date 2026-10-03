// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { suggestAsync } from "../suggestions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const USER: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager', languages = '[\"de\"]' WHERE id = 2" },
  ]);
}

async function idOf(sql: Sql, key: string) {
  const [rows] = await sql.read([
    { sql: "SELECT id FROM strings WHERE display_key = ?", params: [key] },
  ]);
  return Number(rows[0].id);
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

export const SUGGESTION_SUBMISSION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "red-string submission canonicalizes language and value and records its creation",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      const result = await suggestAsync(
        sql,
        USER,
        { id, language: "FR", kind: "correction", value: "Bonjour", baseRevision: 0 },
        200,
        "test",
      );
      checkEqual(
        [
          result.id,
          result.kind,
          result.value,
          result.language,
          result.status,
          result.author.name,
          result.source,
          result.current,
          result.checks,
        ],
        [2, "translation", "Bonjour", "fr", "pending", "Ada", "Hello", null, []],
      );
      const [history] = await sql.read([
        {
          sql: "SELECT before_value, after_value, actor_type, actor_id, detail, created_at FROM history WHERE event = 'suggestion_created'",
        },
      ]);
      checkEqual(history, [
        {
          before_value: null,
          after_value: '"Bonjour"',
          actor_type: "user",
          actor_id: 1,
          detail: '{"suggestionId":2,"kind":"translation"}',
          created_at: 200,
        },
      ]);
    },
  },
  {
    name: "green and blue strings determine corrections and looks-good suggestions",
    async run(sql) {
      await seed(sql);
      const title = await idOf(sql, "title");
      const play = await idOf(sql, "play");
      const correction = await suggestAsync(
        sql,
        USER,
        { id: title, language: "de", kind: "translation", value: "Guten Tag", baseRevision: 2 },
        200,
        "test",
      );
      const approval = await suggestAsync(
        sql,
        USER,
        { id: title, language: "de", kind: "correction", value: "Hallo", baseRevision: 2 },
        250,
        "test",
      );
      checkEqual(
        [correction.kind, correction.current?.value, approval.kind, approval.value],
        ["correction", "Hallo", "approval", null],
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: play, language: "de", kind: "correction", value: "Spielen", baseRevision: 2 },
            300,
            "test",
          ),
        "bad_request",
      );
      const blue = await suggestAsync(
        sql,
        USER,
        { id: play, language: "de", kind: "translation", value: "Los", baseRevision: 2 },
        300,
        "test",
      );
      checkEqual(blue.kind, "correction");
    },
  },
  {
    name: "submission supersedes only the author's older pending suggestions with history",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      await suggestAsync(
        sql,
        USER,
        { id, language: "de", kind: "correction", value: "First", baseRevision: 2 },
        200,
        "test",
      );
      await suggestAsync(
        sql,
        MANAGER,
        { id, language: "de", kind: "correction", value: "Other", baseRevision: 2 },
        210,
        "test",
      );
      const result = await suggestAsync(
        sql,
        USER,
        { id, language: "de", kind: "correction", value: "Second", baseRevision: 2 },
        220,
        "test",
      );
      const [suggestions, superseded] = await sql.read([
        { sql: "SELECT id, status, reviewed_at FROM suggestions WHERE id > 1 ORDER BY id" },
        {
          sql: "SELECT before_value, actor_id, detail FROM history WHERE event = 'suggestion_superseded'",
        },
      ]);
      checkEqual(result.id, 4);
      checkEqual(suggestions, [
        { id: 2, status: "superseded", reviewed_at: 220 },
        { id: 3, status: "pending", reviewed_at: null },
        { id: 4, status: "pending", reviewed_at: null },
      ]);
      checkEqual(superseded, [
        { before_value: '"First"', actor_id: 1, detail: '{"suggestionId":2}' },
      ]);
    },
  },
  {
    name: "kind-specific inputs, active strings and available languages are enforced",
    async run(sql) {
      await seed(sql);
      const title = await idOf(sql, "title");
      const play = await idOf(sql, "play");
      const ref = await idOf(sql, "ref");
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: title, language: "de", kind: "approval", value: "Hallo", baseRevision: 2 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: title, language: "fr", kind: "approval", baseRevision: 0 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: play, language: "de", kind: "approval", baseRevision: 2 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: title, language: "de", kind: "correction", baseRevision: 2 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: ref, language: "fr", kind: "translation", value: "Value", baseRevision: 0 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: title, language: "es", kind: "translation", value: "Value", baseRevision: 0 },
            200,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id: 999, language: "fr", kind: "translation", value: "Value", baseRevision: 0 },
            200,
            "test",
          ),
        "not_found",
      );
    },
  },
  {
    name: "permission and QA failures leave no pending suggestion",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      const request = {
        id,
        language: "fr",
        kind: "translation" as const,
        value: "Bonjour",
        baseRevision: 0,
      };
      await rejected(() => suggestAsync(sql, ANONYMOUS, request, 200, "test"), "unauthorized");
      await rejected(
        () => suggestAsync(sql, { type: "token", tokenId: 7 }, request, 200, "test"),
        "forbidden",
      );
      await rejected(() => suggestAsync(sql, MANAGER, request, 200, "test"), "forbidden");
      await sql.commit(3, [
        { sql: "UPDATE strings SET source = '\"Hello {{name}}\"' WHERE id = ?", params: [id] },
      ]);
      const failure = await rejected(
        () => suggestAsync(sql, USER, request, 200, "test"),
        "qa_failed",
      );
      check(JSON.stringify(failure.details).includes("placeholder_missing"));
      const [suggestions] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM suggestions" }]);
      checkEqual(suggestions, [{ n: 1 }]);
    },
  },
  {
    name: "stale base revisions return the current translation",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      const failure = await rejected(
        () =>
          suggestAsync(
            sql,
            USER,
            { id, language: "de", kind: "correction", value: "Value", baseRevision: 0 },
            200,
            "test",
          ),
        "conflict",
      );
      checkEqual(failure.current?.value, "Hallo");
    },
  },
  {
    name: "ID conflicts reallocate and supersede the latest own pending suggestion",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await suggestAsync(
              sql,
              USER,
              { id, language: "fr", kind: "translation", value: "Competing", baseRevision: 0 },
              150,
              "test",
            );
          return rows;
        },
      };
      const result = await suggestAsync(
        changing,
        USER,
        { id, language: "fr", kind: "translation", value: "Latest", baseRevision: 0 },
        200,
        "test",
      );
      const [suggestions] = await sql.read([
        { sql: "SELECT id, status FROM suggestions WHERE id > 1 ORDER BY id" },
      ]);
      checkEqual(
        [reads, result.id, suggestions],
        [
          2,
          3,
          [
            { id: 2, status: "superseded" },
            { id: 3, status: "pending" },
          ],
        ],
      );
    },
  },
  {
    name: "a concurrent translation revision prevents submitting stale work",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [
              {
                sql: "UPDATE translations SET value = '\"New translation\"', revision = 3 WHERE string_id = ? AND language = 'de'",
                params: [id],
              },
            ]);
          return rows;
        },
      };
      const failure = await rejected(
        () =>
          suggestAsync(
            changing,
            USER,
            { id, language: "de", kind: "correction", value: "Value", baseRevision: 2 },
            200,
            "test",
          ),
        "conflict",
      );
      checkEqual(reads, 2);
      checkEqual(failure.current?.value, "New translation");
    },
  },
  {
    name: "changed QA facts during a conflict prevent submitting unchecked text",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [
              { sql: "UPDATE strings SET max_length = 2 WHERE id = ?", params: [id] },
            ]);
          return rows;
        },
      };
      await rejected(
        () =>
          suggestAsync(
            changing,
            USER,
            { id, language: "fr", kind: "translation", value: "Bonjour", baseRevision: 0 },
            200,
            "test",
          ),
        "qa_failed",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "changed language grants during a conflict remove permission to suggest",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET languages = '[\"de\"]' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () =>
          suggestAsync(
            changing,
            USER,
            { id, language: "fr", kind: "translation", value: "Bonjour", baseRevision: 0 },
            200,
            "test",
          ),
        "forbidden",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "failed submission rolls back superseding, insertion and both history changes",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      await suggestAsync(
        sql,
        USER,
        { id, language: "fr", kind: "translation", value: "First", baseRevision: 0 },
        150,
        "test",
      );
      const queries = [
        { sql: "SELECT * FROM suggestions ORDER BY id" },
        { sql: "SELECT * FROM history ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_submission_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await suggestAsync(
          failing,
          USER,
          { id, language: "fr", kind: "translation", value: "Second", baseRevision: 0 },
          200,
          "test",
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(await sql.read(queries), before);
    },
  },
  {
    name: "validated submission checks input and permission precedence and supports the system author",
    async run(sql) {
      await seed(sql);
      const id = await idOf(sql, "title");
      const api = asyncWriteMethods({ sql, clock: () => 200, defaultModel: "test" });
      const request = {
        id,
        language: "fr",
        kind: "translation" as const,
        value: "Bonjour",
        baseRevision: 0,
      };
      await rejected(() => api.suggest(USER, { ...request, id: 0 }), "validation_failed");
      await rejected(() => api.suggest(ANONYMOUS, { ...request, id: 0 }), "unauthorized");
      const result = await api.suggest(SYSTEM, request);
      checkEqual([result.status, result.author.name], ["pending", "System"]);
    },
  },
];
