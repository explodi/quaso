// SPDX-License-Identifier: MIT
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION, MIGRATIONS } from "../migrations.ts";
import { migrateAsync } from "../migrate.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { GUARD_STATEMENTS } from "../write.ts";
import { check, checkEqual } from "./assert.ts";

const OPTIONS = { model: "test", clock: () => 100, llmAvailable: false };
const FILE = { path: "menu.json", repoPath: "menu.json", content: '{"old":"Hello"}' };

export async function resetUploadSql(sql: Sql): Promise<void> {
  const tables = MIGRATIONS.flatMap((migration) =>
    [...migration.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((match) => match[1]),
  );
  await sql.migrate([
    { sql: "PRAGMA defer_foreign_keys = ON" },
    { sql: "DROP TABLE IF EXISTS revision_guard" },
    ...tables.reverse().map((table) => ({ sql: `DROP TABLE IF EXISTS ${table}` })),
  ]);
  await initializeUploadSql(sql);
}

export async function initializeUploadSql(sql: Sql): Promise<void> {
  await migrateAsync(sql);
  await sql.migrate(GUARD_STATEMENTS);
}

export const UPLOAD_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "repository paths update display metadata without moving source or translation identity",
    async run(sql) {
      const first = { ...FILE, repoPath: "src/locales/en/menu.json" };
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [first], languages: ["de"] }, OPTIONS);
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
          author_type, revision, search_text, created_at, updated_at)
          SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'system', 2, 'hallo', 100, 100 FROM strings`,
        },
      ]);
      const moved = { ...first, repoPath: "packages/app/locales/en/menu.json" };
      const preview = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [moved], dryRun: true },
        OPTIONS,
      );
      checkEqual(preview.files[0].status, "updated");
      checkEqual(await sql.read([{ sql: "SELECT repo_path FROM files" }]), [
        [{ repo_path: first.repoPath }],
      ]);
      const result = await uploadAsync(sql, SYSTEM_AUTHOR, { files: [moved] }, OPTIONS);
      checkEqual(result.files[0].status, "updated");
      checkEqual([result.added, result.changed, result.removed, result.renamed], [[], [], [], []]);
      checkEqual(
        await sql.read([
          { sql: "SELECT id, path, repo_path FROM files" },
          { sql: "SELECT id, file_id, display_key FROM strings" },
          { sql: "SELECT string_id, value, colour, revision FROM translations" },
          { sql: "SELECT COUNT(*) AS n FROM history" },
        ]),
        [
          [{ id: 1, path: "menu.json", repo_path: moved.repoPath }],
          [{ id: 1, file_id: 1, display_key: "old" }],
          [{ string_id: 1, value: '"Hallo"', colour: "blue", revision: 2 }],
          [{ n: 1 }],
        ],
      );
      const again = await uploadAsync(sql, SYSTEM_AUTHOR, { files: [moved] }, OPTIONS);
      checkEqual([again.uploadId, again.revision], [null, result.revision]);
    },
  },
  {
    name: "upload commits source, history, activity and automatic job atomically",
    async run(sql) {
      const result = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [FILE], languages: ["de"] },
        { ...OPTIONS, llmAvailable: true },
      );
      checkEqual(result.added, [{ file: "menu.json", key: "old" }]);
      checkEqual([result.revision, result.uploadId, result.job], [1, 1, { id: 1 }]);
      checkEqual(
        await sql.read([
          { sql: "SELECT string_id, event, detail FROM history" },
          { sql: "SELECT total, source, scope FROM jobs" },
          { sql: "SELECT type FROM activity" },
        ]),
        [
          [{ string_id: 1, event: "source_added", detail: '{"upload":1}' }],
          [{ total: 1, source: "upload", scope: '{"strings":[1],"outdated":true}' }],
          [{ type: "upload" }],
        ],
      );
      const again = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [FILE], languages: ["de"] },
        { ...OPTIONS, llmAvailable: true },
      );
      checkEqual([again.revision, again.uploadId, again.job], [1, null, null]);
      checkEqual(await sql.read([{ sql: "SELECT COUNT(*) AS n FROM history" }]), [[{ n: 1 }]]);
    },
  },
  {
    name: "dry run computes all changes without storing rows or raising revision",
    async run(sql) {
      const result = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [FILE], languages: ["de"], dryRun: true },
        { ...OPTIONS, llmAvailable: true },
      );
      checkEqual(result.added, [{ file: "menu.json", key: "old" }]);
      checkEqual([result.revision, result.uploadId, result.job], [0, null, null]);
      checkEqual(
        await sql.read([
          { sql: "SELECT COUNT(*) AS n FROM files" },
          { sql: "SELECT COUNT(*) AS n FROM languages" },
          { sql: "SELECT COUNT(*) AS n FROM jobs" },
          { sql: "SELECT * FROM meta" },
        ]),
        [
          [{ n: 0 }],
          [{ n: 0 }],
          [{ n: 0 }],
          [{ key: "schema_version", value: String(DATABASE_VERSION) }],
        ],
      );
    },
  },
  {
    name: "hidden source strings restore their ID and translations",
    async run(sql) {
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE], languages: ["de"] }, OPTIONS);
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
        author_type, revision, search_text, created_at, updated_at)
        SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'user', 2, 'hallo', 100, 100 FROM strings`,
        },
      ]);
      const removed = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [{ ...FILE, content: "{}" }] },
        OPTIONS,
      );
      checkEqual(removed.removed, [{ file: "menu.json", key: "old" }]);
      const restored = await uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE] }, OPTIONS);
      checkEqual(restored.restored, [{ file: "menu.json", key: "old" }]);
      checkEqual(
        await sql.read([
          {
            sql: "SELECT s.id, s.active, t.value, t.colour FROM strings s JOIN translations t ON t.string_id = s.id",
          },
        ]),
        [[{ id: 1, active: 1, value: '"Hallo"', colour: "blue" }]],
      );
    },
  },
  {
    name: "limits recompute QA and omitted limits clear only uploaded files",
    async run(sql) {
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE], languages: ["de"] }, OPTIONS);
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
        author_type, revision, search_text, created_at, updated_at)
        SELECT id, 'de', '"Hallo"', 'green', source_hash, 'llm', 2, 'hallo', 100, 100 FROM strings`,
        },
      ]);
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [FILE], limits: [{ file: FILE.path, key: "old", maxLength: 3 }] },
        OPTIONS,
      );
      checkEqual(
        await sql.read([
          {
            sql: "SELECT s.max_length, s.max_length_locked, t.qa_errors FROM strings s JOIN translations t ON t.string_id = s.id",
          },
        ]),
        [[{ max_length: 3, max_length_locked: 1, qa_errors: 1 }]],
      );
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [], partial: true }, OPTIONS);
      checkEqual(await sql.read([{ sql: "SELECT max_length FROM strings" }]), [
        [{ max_length: 3 }],
      ]);
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE] }, OPTIONS);
      checkEqual(
        await sql.read([
          {
            sql: "SELECT s.max_length, s.max_length_locked, t.qa_errors FROM strings s JOIN translations t ON t.string_id = s.id",
          },
        ]),
        [[{ max_length: null, max_length_locked: 0, qa_errors: 0 }]],
      );
    },
  },
  {
    name: "renames move translations and history and are idempotent",
    async run(sql) {
      await uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE], languages: ["de"] }, OPTIONS);
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
        author_type, revision, search_text, created_at, updated_at)
        SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'user', 2, 'hallo', 100, 100 FROM strings`,
        },
      ]);
      const request = {
        files: [{ ...FILE, content: '{"new":"Hello"}' }],
        renames: [{ file: FILE.path, from: "old", to: "new" }],
      };
      const result = await uploadAsync(sql, SYSTEM_AUTHOR, request, OPTIONS);
      checkEqual(result.renamed, [{ file: FILE.path, from: "old", to: "new" }]);
      checkEqual(
        await sql.read([
          { sql: "SELECT string_id, value, colour FROM translations" },
          { sql: "SELECT string_id, event, detail FROM history ORDER BY id" },
        ]),
        [
          [{ string_id: 2, value: '"Hallo"', colour: "blue" }],
          [
            { string_id: 2, event: "source_added", detail: '{"upload":1}' },
            { string_id: 2, event: "source_added", detail: '{"upload":2}' },
            { string_id: 1, event: "source_removed", detail: '{"upload":2}' },
            {
              string_id: 2,
              event: "source_renamed",
              detail: '{"file":"menu.json","from":"old","to":"new","fromStringId":1,"upload":2}',
            },
          ],
        ],
      );
      const again = await uploadAsync(sql, SYSTEM_AUTHOR, request, OPTIONS);
      checkEqual([again.revision, again.uploadId, again.renamed], [3, null, []]);
    },
  },
  {
    name: "renames replace only untouched green LLM work and retain deleted history",
    async run(sql) {
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        {
          files: [{ ...FILE, content: '{"old":"Hello","new":"Hello"}' }],
          languages: ["de"],
        },
        OPTIONS,
      );
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
          author_type, revision, search_text, created_at, updated_at)
          SELECT id, 'de', CASE WHEN id = 1 THEN '"Hallo"' ELSE '"Neu"' END,
            'green', source_hash, 'llm', 2, '', 100, 100 FROM strings`,
        },
        {
          sql: "INSERT INTO llm_failures (string_id, language, reason, created_at) VALUES (2, 'de', 'test', 100)",
        },
      ]);
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        {
          files: [{ ...FILE, content: '{"new":"Hello"}' }],
          renames: [{ file: FILE.path, from: "old", to: "new" }],
        },
        OPTIONS,
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT string_id, value FROM translations" },
          {
            sql: "SELECT string_id, before_value, detail FROM history WHERE event = 'translation_deleted'",
          },
          { sql: "SELECT COUNT(*) AS n FROM llm_failures" },
        ]),
        [
          [{ string_id: 2, value: '"Hallo"' }],
          [
            {
              string_id: 2,
              before_value: '"Neu"',
              detail: '{"reason":"rename","file":"menu.json","from":"old","to":"new"}',
            },
          ],
          [{ n: 0 }],
        ],
      );
    },
  },
  {
    name: "a protected rename aborts every source write in the upload",
    async run(sql) {
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [{ ...FILE, content: '{"old":"Hello","new":"Hello"}' }], languages: ["de"] },
        OPTIONS,
      );
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash,
        author_type, revision, search_text, created_at, updated_at)
        SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'user', 2, 'hallo', 100, 100 FROM strings`,
        },
      ]);
      const error = await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        {
          files: [{ ...FILE, content: '{"new":"Hello"}' }],
          renames: [{ file: FILE.path, from: "old", to: "new" }],
        },
        OPTIONS,
      ).catch((error: unknown) => error);
      check(error instanceof ServiceError);
      checkEqual(error.code, "bad_request");
      checkEqual(
        await sql.read([
          { sql: "SELECT display_key, active FROM strings ORDER BY id" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [
          [
            { display_key: "old", active: 1 },
            { display_key: "new", active: 1 },
          ],
          [{ value: "2" }],
        ],
      );
    },
  },
  {
    name: "a conflicting upload rereads languages and replans IDs and job work",
    async run(sql) {
      let attempts = 0;
      const competing: Sql = {
        ...sql,
        async commit(revision, statements) {
          attempts++;
          if (attempts === 1)
            await sql.commit(revision, [
              { sql: "INSERT INTO languages (tag, created_at) VALUES ('es', 100)" },
            ]);
          return sql.commit(revision, statements);
        },
      };
      const result = await uploadAsync(
        competing,
        SYSTEM_AUTHOR,
        { files: [FILE], languages: ["de"] },
        { ...OPTIONS, llmAvailable: true },
      );
      checkEqual(attempts, 2);
      checkEqual([result.revision, result.uploadId, result.job], [2, 1, { id: 1 }]);
      checkEqual(
        await sql.read([
          { sql: "SELECT total FROM jobs" },
          { sql: "SELECT COUNT(*) AS n FROM strings" },
        ]),
        [[{ total: 2 }], [{ n: 1 }]],
      );
    },
  },
  {
    name: "overlapping uploads allocate distinct IDs through guarded retries",
    async run(sql) {
      await Promise.all([
        uploadAsync(sql, SYSTEM_AUTHOR, { files: [FILE], partial: true }, OPTIONS),
        uploadAsync(
          sql,
          SYSTEM_AUTHOR,
          { files: [{ ...FILE, path: "other.json" }], partial: true },
          OPTIONS,
        ),
      ]);
      checkEqual(
        await sql.read([
          { sql: "SELECT path FROM files ORDER BY path" },
          { sql: "SELECT COUNT(DISTINCT id) AS n FROM strings" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ path: "menu.json" }, { path: "other.json" }], [{ n: 2 }], [{ value: "2" }]],
      );
    },
  },
];
