// SPDX-License-Identifier: MIT
import { ServiceError } from "../errors.ts";
import { readJobWork } from "../jobs/work.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

const SETTINGS = { updateOutdated: true, proposeForProofread: true, batchSize: 2 };
export async function seedJobWork(sql: Sql) {
  await sql.commit(0, [
    { sql: "INSERT INTO languages (tag, created_at) VALUES ('de', 100), ('fr', 100)" },
    {
      sql: "INSERT INTO files (id, path, repo_path, format, created_at, updated_at) VALUES (1, 'a.json', 'a.json', '{}', 100, 100), (2, 'b.json', 'b.json', '{}', 100, 100), (3, 'hidden.json', 'hidden.json', '{}', 100, 100)",
    },
    { sql: "UPDATE files SET active = 0 WHERE id = 3" },
    {
      sql: `INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash, words, search_text, position, created_at, updated_at)
        SELECT value, 1, CAST(value AS TEXT), '[]', CAST(value AS TEXT), 'text', '"Hello"', 'new', 1, '', value, 100, 100 FROM json_each('[1,2,3,4,5,6,7,8,9,10]')`,
    },
    { sql: "UPDATE strings SET file_id = 2 WHERE id = 7" },
    { sql: "UPDATE strings SET kind = 'literal' WHERE id = 8" },
    { sql: "UPDATE strings SET active = 0 WHERE id = 9" },
    { sql: "UPDATE strings SET file_id = 3 WHERE id = 10" },
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at) VALUES
        (2, 'de', '"fresh green"', 'green', 'new', 'llm', 2, '', 100, 100),
        (3, 'de', '"old green"', 'green', 'old', 'llm', 3, '', 100, 100),
        (4, 'de', '"fresh blue"', 'blue', 'new', 'user', 4, '', 100, 100),
        (5, 'de', '"old blue"', 'blue', 'old', 'user', 5, '', 100, 100),
        (6, 'de', '"proposal"', 'blue', 'old', 'user', 6, '', 100, 100)`,
    },
    {
      sql: "INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision, author_type, created_at) VALUES (6, 'de', 'llm', 'new', 6, 'llm', 100)",
    },
    {
      sql: "INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (1, 'running', 2, 'website', '{}', 'system', 100, 100)",
    },
    { sql: "INSERT INTO job_items VALUES (1, 1, 'de', 'translated')" },
  ]);
}

export const JOB_WORK_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "only pending LLM proposals for the current source suppress new proposals",
    async run(sql) {
      await seedJobWork(sql);
      await sql.commit(1, [{ sql: "UPDATE suggestions SET source_hash = 'old'" }]);
      checkEqual(
        (await readJobWork(sql, 0, "website", { languages: ["de"], strings: [6] }, SETTINGS)).total,
        1,
      );
      await sql.commit(2, [
        { sql: "UPDATE suggestions SET source_hash = 'new', status = 'rejected'" },
      ]);
      checkEqual(
        (await readJobWork(sql, 0, "website", { languages: ["de"], strings: [6] }, SETTINGS)).total,
        1,
      );
      await sql.commit(3, [
        { sql: "UPDATE suggestions SET status = 'pending', kind = 'correction'" },
      ]);
      checkEqual(
        (await readJobWork(sql, 0, "website", { languages: ["de"], strings: [6] }, SETTINGS)).total,
        1,
      );
    },
  },
  {
    name: "plural and ordinal work decodes forms and excludes whole-value references",
    async run(sql) {
      await seedJobWork(sql);
      await sql.commit(1, [
        {
          sql: `UPDATE strings SET kind = 'plural', source = '{"one":"One","other":"Many"}', description = 'Count', max_length = 20 WHERE id = 1`,
        },
        { sql: `UPDATE strings SET kind = 'ordinal', source = '{"other":"Rank"}' WHERE id = 7` },
        { sql: "UPDATE strings SET kind = 'reference' WHERE id = 8" },
      ]);
      const result = await readJobWork(
        sql,
        0,
        "website",
        { languages: ["fr"], strings: [1, 7, 8] },
        SETTINGS,
      );
      checkEqual(result.total, 2);
      checkEqual(result.batches[0].items[0].kind, "plural");
      checkEqual(result.batches[0].items[0].english, { one: "One", other: "Many" });
      checkEqual(
        [result.batches[0].items[0].description, result.batches[0].items[0].maxLength],
        ["Count", 20],
      );
      checkEqual(
        [result.batches[1].items[0].kind, result.batches[1].items[0].english],
        ["ordinal", { other: "Rank" }],
      );
    },
  },
  {
    name: "work preserves actions, current values, revision and active translatable filters",
    async run(sql) {
      await seedJobWork(sql);
      const result = await readJobWork(sql, 0, "website", { languages: ["de"] }, SETTINGS);
      checkEqual(result.revision, 1);
      checkEqual(result.total, 4);
      checkEqual(
        result.batches.map((batch) => [
          batch.path,
          batch.items.map((item) => [item.stringId, item.action, item.revision, item.current]),
        ]),
        [
          [
            "a.json",
            [
              [1, "translate", 0, null],
              [3, "update", 3, "old green"],
            ],
          ],
          ["a.json", [[5, "propose", 5, "old blue"]]],
          ["b.json", [[7, "translate", 0, null]]],
        ],
      );
      checkEqual(result.batches[0].items[0].english, "Hello");
      checkEqual(result.batches[0].items[0].words, 1);
    },
  },
  {
    name: "processed pairs are excluded only for their job and language",
    async run(sql) {
      await seedJobWork(sql);
      const result = await readJobWork(sql, 1, "website", {}, SETTINGS);
      checkEqual(result.total, 10);
      checkEqual(
        result.batches.flatMap((batch) =>
          batch.items.map((item) => [item.language, item.stringId]),
        ),
        [
          ["de", 3],
          ["de", 5],
          ["de", 7],
          ["fr", 1],
          ["fr", 2],
          ["fr", 3],
          ["fr", 4],
          ["fr", 5],
          ["fr", 6],
          ["fr", 7],
        ],
      );
    },
  },
  {
    name: "manual jobs update old green independently of the upload setting",
    async run(sql) {
      await seedJobWork(sql);
      const settings = { ...SETTINGS, updateOutdated: false, proposeForProofread: false };
      const manual = await readJobWork(sql, 0, "cli", { languages: ["de"] }, settings);
      const upload = await readJobWork(sql, 0, "upload", { languages: ["de"] }, settings);
      checkEqual(
        manual.batches.flatMap((batch) => batch.items.map((item) => item.stringId)),
        [1, 3, 7],
      );
      checkEqual(
        upload.batches.flatMap((batch) => batch.items.map((item) => item.stringId)),
        [1, 7],
      );
    },
  },
  {
    name: "retranslation includes green only and outdated false excludes updates and proposals",
    async run(sql) {
      await seedJobWork(sql);
      const result = await readJobWork(
        sql,
        0,
        "website",
        { languages: ["de"], retranslate: true, outdated: false },
        SETTINGS,
      );
      checkEqual(
        result.batches.flatMap((batch) =>
          batch.items.map((item) => [item.stringId, item.action, item.current]),
        ),
        [
          [1, "translate", null],
          [2, "translate", null],
          [3, "translate", null],
          [7, "translate", null],
        ],
      );
    },
  },
  {
    name: "file and string restrictions intersect and removed languages are omitted",
    async run(sql) {
      await seedJobWork(sql);
      const result = await readJobWork(
        sql,
        0,
        "website",
        { languages: ["missing", "de"], files: ["a.json", "missing.json"], strings: [1, 7] },
        SETTINGS,
      );
      checkEqual(result.scope.languages, ["de"]);
      checkEqual(result.scope.fileIds, [1]);
      checkEqual(result.total, 1);
      checkEqual(
        result.batches[0].items.map((item) => item.stringId),
        [1],
      );
      checkEqual((await readJobWork(sql, 0, "website", { files: [] }, SETTINGS)).total, 0);
      checkEqual((await readJobWork(sql, 0, "website", { languages: [] }, SETTINGS)).batches, []);
      checkEqual((await readJobWork(sql, 0, "website", { strings: [] }, SETTINGS)).total, 0);
    },
  },
  {
    name: "batch bounds preserve language and file order without truncating the total",
    async run(sql) {
      await seedJobWork(sql);
      const result = await readJobWork(sql, 0, "website", {}, SETTINGS, 4);
      checkEqual(result.total, 11);
      checkEqual(
        result.batches.map((batch) => [
          batch.language,
          batch.path,
          batch.items.map((item) => item.stringId),
        ]),
        [
          ["de", "a.json", [1, 3]],
          ["de", "a.json", [5]],
          ["de", "b.json", [7]],
          ["fr", "a.json", [1, 2]],
        ],
      );
      const countOnly = await readJobWork(sql, 0, "website", {}, SETTINGS, 0);
      checkEqual([countOnly.total, countOnly.batches], [11, []]);
    },
  },
  {
    name: "large scope lists use bounded parameters and selection never writes",
    async run(sql) {
      await seedJobWork(sql);
      const readOnly: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      const result = await readJobWork(
        readOnly,
        0,
        "website",
        {
          languages: ["de"],
          files: [
            "a.json",
            "b.json",
            ...Array.from({ length: 1001 }, (_, index) => `${index}.json`),
          ],
          strings: Array.from({ length: 1001 }, (_, index) => index + 1),
        },
        SETTINGS,
      );
      checkEqual(result.total, 4);
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision, [{ value: "1" }]);
    },
  },
  {
    name: "a scope change between snapshots refreshes languages and files",
    async run(sql) {
      await seedJobWork(sql);
      let first = true;
      const raced: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (first) {
            first = false;
            await sql.commit(1, [
              { sql: "DELETE FROM languages WHERE tag = 'de'" },
              { sql: "UPDATE files SET path = 'renamed.json' WHERE id = 1" },
            ]);
          }
          return rows;
        },
      };
      const result = await readJobWork(raced, 0, "website", { files: ["a.json"] }, SETTINGS);
      checkEqual(
        [
          result.revision,
          result.scope.languages,
          result.scope.fileIds,
          result.total,
          result.batches,
        ],
        [2, ["fr"], [], 0, []],
      );
    },
  },
  {
    name: "translation changes between snapshots refresh actions and counts",
    async run(sql) {
      await seedJobWork(sql);
      let first = true;
      const raced: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (first) {
            first = false;
            await sql.commit(1, [
              { sql: "UPDATE translations SET source_hash = 'new' WHERE string_id = 3" },
            ]);
          }
          return rows;
        },
      };
      const result = await readJobWork(raced, 0, "website", { languages: ["de"] }, SETTINGS);
      checkEqual([result.revision, result.total], [2, 3]);
      checkEqual(
        result.batches.flatMap((batch) => batch.items.map((item) => item.stringId)),
        [1, 5, 7],
      );
    },
  },
  {
    name: "continuous changes exhaust bounded retries instead of returning a mixed snapshot",
    async run(sql) {
      await seedJobWork(sql);
      let reads = 0;
      let revision = 1;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(revision++, [
            { sql: "UPDATE files SET updated_at = updated_at + 1 WHERE id = 1" },
          ]);
          return rows;
        },
      };
      let failure: unknown;
      try {
        await readJobWork(changing, 0, "website", {}, SETTINGS);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof ServiceError);
      checkEqual(failure.code, "unavailable");
      checkEqual(reads, 8);
    },
  },
];
