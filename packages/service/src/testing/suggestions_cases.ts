// SPDX-License-Identifier: MIT
import type { SuggestionsQuery } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { listSuggestionsAsync } from "../suggestions.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const CONTRIBUTOR: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager', languages = '[\"de\"]' WHERE id = 2" },
    { sql: "UPDATE strings SET max_length = 2 WHERE display_key = 'title'" },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, author_type, author_id, created_at)
        SELECT 2, id, 'de', 'correction', '"Guten Tag"', source_hash, 2, 'token', 7, 200 FROM strings WHERE display_key = 'title'`,
    },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, reviewer_id, comment, created_at, reviewed_at)
        SELECT 3, id, 'de', 'correction', '"Los"', source_hash, 2, 'rejected', 'user', 1, 2, 'Keep the old text', 300, 400 FROM strings WHERE display_key = 'play'`,
    },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, author_type, author_id, created_at)
        SELECT 4, id, 'fr', 'translation', '"Bonjour"', source_hash, 0, 'user', 1, 400 FROM strings WHERE display_key = 'title'`,
    },
  ]);
}

async function ids(
  sql: Sql,
  query: SuggestionsQuery = {},
  actor: Actor = MANAGER,
): Promise<number[]> {
  return (await listSuggestionsAsync(sql, actor, query, "test")).suggestions.map((row) => row.id);
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

export const SUGGESTION_LIST_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "reviewers see the queue while other people see only their own",
    async run(sql) {
      await seed(sql);
      checkEqual(await ids(sql), [1, 2, 4]);
      checkEqual(await ids(sql, {}, SYSTEM), [1, 2, 4]);
      checkEqual(await ids(sql, {}, CONTRIBUTOR), [4]);
      checkEqual(await ids(sql, { author: "me" }, CONTRIBUTOR), [4]);
      checkEqual(await ids(sql, { author: "1" }), [4]);
      await rejected(() => ids(sql, { author: "2" }, CONTRIBUTOR), "forbidden");
      await rejected(() => ids(sql, {}, ANONYMOUS), "forbidden");
      await rejected(() => ids(sql, {}, { type: "token", tokenId: 7 }), "forbidden");
      await rejected(() => ids(sql, { author: "me" }, SYSTEM), "bad_request");
      await rejected(() => ids(sql, { author: "someone" }), "bad_request");
      await rejected(() => ids(sql, { cursor: "1 OR 1=1" }), "bad_request");
    },
  },
  {
    name: "status, canonical language, kind, file and folder filters compose",
    async run(sql) {
      await seed(sql);
      checkEqual(await ids(sql, { language: "DE" }), [1, 2]);
      checkEqual(await ids(sql, { kind: "correction" }), [2]);
      checkEqual(await ids(sql, { file: "Menus/" }), [1]);
      checkEqual(await ids(sql, { file: "menus/" }), []);
      checkEqual(await ids(sql, { file: "common.json", language: "de" }), [2]);
      checkEqual(await ids(sql, { status: "rejected" }), [3]);
      checkEqual(await ids(sql, { status: "all" }), [4, 3, 2, 1]);
    },
  },
  {
    name: "paging retains total and ends with a null cursor",
    async run(sql) {
      await seed(sql);
      const first = await listSuggestionsAsync(sql, MANAGER, { limit: 2 }, "test");
      checkEqual(
        [first.total, first.nextCursor, first.suggestions.map((row) => row.id)],
        [3, "2", [1, 2]],
      );
      const last = await listSuggestionsAsync(sql, MANAGER, { cursor: "2", limit: 2 }, "test");
      checkEqual(
        [last.total, last.nextCursor, last.suggestions.map((row) => row.id)],
        [3, null, [4]],
      );
      const past = await listSuggestionsAsync(sql, MANAGER, { cursor: "99" }, "test");
      checkEqual([past.total, past.nextCursor, past.suggestions], [3, null, []]);
    },
  },
  {
    name: "suggestion and translation metadata decode with current quality checks",
    async run(sql) {
      await seed(sql);
      const page = await listSuggestionsAsync(sql, MANAGER, { status: "all" }, "test");
      const reviewed = page.suggestions[1];
      checkEqual(
        [
          reviewed.source,
          reviewed.value,
          reviewed.comment,
          reviewed.reviewedAt,
          reviewed.baseRevision,
        ],
        ["Play", "Los", "Keep the old text", 400, 2],
      );
      checkEqual(reviewed.author, { type: "user", id: 1, name: "Ada", avatarUrl: null });
      checkEqual(reviewed.reviewer, { type: "user", id: 2, name: "Reviewer", avatarUrl: null });
      checkEqual(
        [
          reviewed.current?.value,
          reviewed.current?.colour,
          reviewed.current?.author,
          reviewed.current?.approver,
        ],
        ["Spielen", "blue", reviewed.author, reviewed.reviewer],
      );
      const correction = page.suggestions[2];
      checkEqual(correction.author, { type: "token", id: 7, name: "CI" });
      checkEqual(
        correction.checks.map((result) => result.check),
        ["max_length"],
      );
      checkEqual([correction.current?.value, correction.current?.outdated], ["Hallo", true]);
      checkEqual(
        [page.suggestions[3].value, page.suggestions[3].current, page.suggestions[3].checks],
        [null, null, []],
      );
    },
  },
  {
    name: "approval suggestions check the current translation against glossary rules",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE suggestions SET kind = 'approval', value = NULL WHERE id = 2" },
        {
          sql: `INSERT INTO glossary_terms (term, term_normalized, language, kind, translation, created_by, created_at, updated_at)
            VALUES ('Hello', 'hello', 'de', 'translate', 'Guten Tag', 1, 100, 100)`,
        },
      ]);
      const page = await listSuggestionsAsync(
        sql,
        MANAGER,
        { kind: "approval", language: "de" },
        "test",
      );
      checkEqual(page.suggestions[1].value, null);
      checkEqual(
        page.suggestions[1].checks.map((result) => result.check),
        ["max_length", "glossary"],
      );
    },
  },
  {
    name: "the final snapshot retains attribution across a concurrent identity deletion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 2) await sql.commit(3, [{ sql: "DELETE FROM users WHERE id = 1" }]);
          return rows;
        },
      };
      const result = await listSuggestionsAsync(changing, MANAGER, {}, "test");
      checkEqual([reads, result.suggestions[2].author.name], [2, "Ada"]);
      const current = await listSuggestionsAsync(sql, MANAGER, {}, "test");
      checkEqual(current.suggestions[2].author.name, "Deleted user");
    },
  },
  {
    name: "removed files, strings and languages leave the pending queue but retain history",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE files SET active = 0 WHERE path = 'Menus/main.json'" },
        { sql: "UPDATE strings SET active = 0 WHERE display_key = 'title'" },
        { sql: "DELETE FROM languages WHERE tag = 'de'" },
      ]);
      checkEqual(await ids(sql), []);
      checkEqual(await ids(sql, { status: "all" }), [4, 3, 2, 1]);
    },
  },
  {
    name: "a concurrent demotion replans visibility before returning the queue",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 2" }]);
          return rows;
        },
      };
      const result = await listSuggestionsAsync(changing, MANAGER, {}, "test");
      checkEqual([reads, result.total, result.suggestions], [4, 0, []]);
    },
  },
  {
    name: "continuous revisions stop after four attempts",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          await sql.commit(3 + reads++, [
            { sql: "UPDATE users SET display_name = 'Changed' WHERE id = 1" },
          ]);
          return rows;
        },
      };
      await rejected(() => ids(changing), "unavailable");
      checkEqual(reads, 8);
    },
  },
];
