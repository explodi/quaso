// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { withdrawSuggestionAsync } from "../suggestions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const USER: Actor = { type: "user", userId: 1 };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 2" },
    {
      sql: "INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, author_type, author_id, created_at) SELECT 2, id, 'de', 'correction', '\"Guten Tag\"', source_hash, 2, 'user', 1, 150 FROM strings WHERE display_key = 'title'",
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

export const SUGGESTION_WITHDRAWAL_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "authors withdraw with one history record and a complete suggestion response",
    async run(sql) {
      await seed(sql);
      const result = await withdrawSuggestionAsync(sql, USER, 2, 200, "test");
      checkEqual(
        [
          result.id,
          result.status,
          result.reviewedAt,
          result.value,
          result.source,
          result.file,
          result.key,
          result.author.name,
          result.current?.value,
          result.current?.author.name,
          result.checks,
        ],
        [
          2,
          "withdrawn",
          200,
          "Guten Tag",
          "Hello",
          "common.json",
          "title",
          "Ada",
          "Hallo",
          "CI",
          [],
        ],
      );
      const [history, revision] = await sql.read([
        {
          sql: "SELECT event, before_value, after_value, actor_type, actor_id, actor_label, detail, created_at FROM history WHERE event = 'suggestion_withdrawn'",
        },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(history, [
        {
          event: "suggestion_withdrawn",
          before_value: '"Guten Tag"',
          after_value: null,
          actor_type: "user",
          actor_id: 1,
          actor_label: null,
          detail: '{"suggestionId":2}',
          created_at: 200,
        },
      ]);
      checkEqual(revision[0].value, "4");
    },
  },
  {
    name: "the system can withdraw an approval whose value is null",
    async run(sql) {
      await seed(sql);
      const result = await withdrawSuggestionAsync(sql, SYSTEM, 1, 200, "test");
      checkEqual([result.kind, result.value, result.status], ["approval", null, "withdrawn"]);
      const [history] = await sql.read([
        {
          sql: "SELECT before_value, actor_type, actor_id, actor_label FROM history WHERE event = 'suggestion_withdrawn'",
        },
      ]);
      checkEqual(history, [
        { before_value: null, actor_type: "system", actor_id: null, actor_label: "System" },
      ]);
    },
  },
  {
    name: "withdrawal requires account access and ownership even for administrators",
    async run(sql) {
      await seed(sql);
      await rejected(() => withdrawSuggestionAsync(sql, ANONYMOUS, 2, 200, "test"), "unauthorized");
      await rejected(
        () => withdrawSuggestionAsync(sql, { type: "token", tokenId: 7 }, 2, 200, "test"),
        "forbidden",
      );
      await rejected(
        () => withdrawSuggestionAsync(sql, { type: "user", userId: 2 }, 2, 200, "test"),
        "forbidden",
      );
      await rejected(() => withdrawSuggestionAsync(sql, USER, 1, 200, "test"), "forbidden");
      await rejected(() => withdrawSuggestionAsync(sql, USER, 99, 200, "test"), "not_found");
      await sql.commit(3, [{ sql: "UPDATE users SET deleted_at = 200 WHERE id = 1" }]);
      await rejected(() => withdrawSuggestionAsync(sql, USER, 2, 200, "test"), "forbidden");
    },
  },
  {
    name: "archived strings remain withdrawable and finished suggestions are refused",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [{ sql: "UPDATE strings SET active = 0 WHERE display_key = 'title'" }]);
      checkEqual((await withdrawSuggestionAsync(sql, USER, 2, 200, "test")).status, "withdrawn");
      await rejected(() => withdrawSuggestionAsync(sql, USER, 2, 300, "test"), "bad_request");
    },
  },
  {
    name: "a competing withdrawal creates only one history record",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1) await withdrawSuggestionAsync(sql, USER, 2, 150, "test");
          return rows;
        },
      };
      await rejected(() => withdrawSuggestionAsync(changing, USER, 2, 200, "test"), "bad_request");
      const [history, suggestion] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM history WHERE event = 'suggestion_withdrawn'" },
        { sql: "SELECT reviewed_at FROM suggestions WHERE id = 2" },
      ]);
      checkEqual([reads, history, suggestion], [2, [{ n: 1 }], [{ reviewed_at: 150 }]]);
    },
  },
  {
    name: "a competing review prevents withdrawal of an approved suggestion",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [
              {
                sql: "UPDATE suggestions SET status = 'approved', reviewed_at = 150, reviewer_id = 2 WHERE id = 2",
              },
            ]);
          return rows;
        },
      };
      await rejected(() => withdrawSuggestionAsync(changing, USER, 2, 200, "test"), "bad_request");
      const [history] = await sql.read([
        { sql: "SELECT id FROM history WHERE event = 'suggestion_withdrawn'" },
      ]);
      checkEqual([reads, history], [2, []]);
    },
  },
  {
    name: "account deletion during a conflict removes permission to withdraw",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET deleted_at = 150 WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => withdrawSuggestionAsync(changing, USER, 2, 200, "test"), "forbidden");
      checkEqual(reads, 2);
    },
  },
  {
    name: "conflicts refresh current translations, source QA and actor labels in the committed response",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(3, [
              { sql: "UPDATE users SET display_name = 'New name' WHERE id = 1" },
              { sql: "UPDATE api_tokens SET name = 'New key name' WHERE id = 7" },
              {
                sql: "UPDATE strings SET source = '\"Hello {{name}}\"', source_hash = 'changed' WHERE display_key = 'title'",
              },
              {
                sql: "UPDATE translations SET value = '\"New value\"' WHERE string_id = (SELECT id FROM strings WHERE display_key = 'title') AND language = 'de'",
              },
            ]);
          return rows;
        },
      };
      const result = await withdrawSuggestionAsync(changing, USER, 2, 200, "test");
      checkEqual(
        [
          reads,
          result.source,
          result.author.name,
          result.current?.value,
          result.current?.author.name,
        ],
        [2, "Hello {{name}}", "New name", "New value", "New key name"],
      );
      check(result.checks.length > 0);
    },
  },
  {
    name: "failed withdrawal rolls back status, history and revision",
    async run(sql) {
      await seed(sql);
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
            { sql: "INSERT INTO missing_withdrawal_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await withdrawSuggestionAsync(failing, USER, 2, 200, "test");
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(await sql.read(queries), before);
    },
  },
  {
    name: "validated withdrawal checks IDs and keeps permission precedence for invalid requests",
    async run(sql) {
      await seed(sql);
      const api = asyncWriteMethods({ sql, clock: () => 200, defaultModel: "test" });
      await rejected(() => api.withdrawSuggestion(USER, { id: 0 }), "validation_failed");
      await rejected(() => api.withdrawSuggestion(ANONYMOUS, { id: 0 }), "unauthorized");
      checkEqual((await api.withdrawSuggestion(USER, { id: 2 })).status, "withdrawn");
    },
  },
];
