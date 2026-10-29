// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { MIGRATIONS } from "./migrations.ts";
import { readUploadSnapshot } from "./upload_snapshot.ts";

function database() {
  const opened = openAsyncSqlite(":memory:");
  opened.db.exec(MIGRATIONS.map((migration) => migration.sql).join("\n"));
  opened.db.exec(`
    INSERT INTO meta VALUES ('revision', '7');
    INSERT INTO languages VALUES ('de', '', '{"cardinal":["other"]}', 100);
    INSERT INTO files (id, path, repo_path, format, active, created_at, updated_at)
      VALUES (1, 'menu.json', 'menu.json', '{}', 1, 100, 100),
             (2, 'other.json', 'other.json', '{}', 1, 100, 100),
             (3, 'hidden.json', 'hidden.json', '{}', 0, 100, 100);
    INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source,
      source_hash, search_text, position, created_at, updated_at)
      VALUES (1, 1, '["old"]', '["old"]', 'old', 'text', '"Hello"', 'hash', 'hello', 0, 100, 100),
             (2, 2, '["old"]', '["old"]', 'old', 'text', '"Other"', 'hash2', 'other', 0, 100, 100),
             (3, 3, '["old"]', '["old"]', 'old', 'text', '"Hidden"', 'hash3', 'hidden', 0, 100, 100);
    INSERT INTO translations (string_id, language, value, colour, source_hash,
      author_type, revision, search_text, created_at, updated_at)
      VALUES (1, 'de', '"Hallo"', 'green', 'hash', 'llm', 6, 'hallo', 100, 100),
             (2, 'de', '"Andere"', 'blue', 'hash2', 'user', 6, 'andere', 100, 100);
    INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision,
      author_type, created_at) VALUES (1, 'de', 'llm', 'hash', 6, 'llm', 100);
    INSERT INTO history (string_id, language, event, actor_type, created_at)
      VALUES (1, 'de', 'translation_written', 'user', 100),
             (1, 'de', 'translation_llm', 'llm', 100),
             (2, 'de', 'translation_written', 'user', 100);
    INSERT INTO history (string_id, event, actor_type, detail, created_at)
      VALUES (1, 'source_renamed', 'system', '{"fromStringId":4}', 100);
    INSERT INTO glossary_terms (term, term_normalized, kind, note, created_at, updated_at)
      VALUES ('Wayfarer', 'wayfarer', 'keep', '', 100, 100);
  `);
  return { ...opened, [Symbol.dispose]: opened.close };
}

test("upload snapshot reads revision and operation dependencies in one batch", async () => {
  using opened = database();
  let reads = 0;
  const sql = {
    ...opened.sql,
    read: (statements: Parameters<typeof opened.sql.read>[0]) => {
      reads++;
      return opened.sql.read(statements);
    },
  };
  const { revision, state } = await readUploadSnapshot(
    sql,
    {
      files: [{ path: "menu.json", repoPath: "menu.json", content: "{}" }],
    },
    "test-model",
  );
  expect(reads).toBe(1);
  expect(revision).toBe(7);
  expect(state.hasStrings).toBe(true);
  expect(state.settings.llm.model).toBe("test-model");
  expect(state.files.map((row) => row.path)).toStrictEqual([
    "menu.json",
    "other.json",
    "hidden.json",
  ]);
  expect(state.strings.map((row) => row.id)).toStrictEqual([1]);
  expect(state.translations.map((row) => [row.string_id, row.value])).toStrictEqual([
    [1, '"Hallo"'],
  ]);
  expect(state.suggestions.length).toBe(1);
  expect(state.humanHistory).toStrictEqual([
    { string_id: 1, language: null, people: 1 },
    { string_id: 1, language: "de", people: 1 },
  ]);
  expect(state.renames).toStrictEqual([{ string_id: 1, detail: '{"fromStringId":4}' }]);
  expect(state.languages[0].pluralOverride).toStrictEqual({ cardinal: ["other"] });
  expect(state.glossary[0].term).toBe("Wayfarer");
  expect(state.nextIds).toStrictEqual({ file: 4, string: 4, upload: 1, job: 1 });
});

test("upload snapshot includes limit and explicit rename files outside the upload", async () => {
  using opened = database();
  const { state } = await readUploadSnapshot(
    opened.sql,
    {
      files: [],
      partial: true,
      limits: [{ file: "hidden.json", key: "old", maxLength: 5 }],
      renames: [{ file: "other.json", from: "old", to: "new" }],
    },
    "model",
  );
  expect(state.strings.map((row) => row.id)).toStrictEqual([2, 3]);
  expect(state.translations.map((row) => row.string_id)).toStrictEqual([2]);
});

test("upload snapshot checks every active file for renames without a file", async () => {
  using opened = database();
  const { state } = await readUploadSnapshot(
    opened.sql,
    {
      files: [],
      partial: true,
      renames: [{ from: "old", to: "new" }],
    },
    "model",
  );
  expect(state.strings.map((row) => row.id)).toStrictEqual([1, 2]);
  expect(state.translations.map((row) => row.string_id)).toStrictEqual([1, 2]);
  expect(state.humanHistory.map((row) => row.string_id)).toStrictEqual([1, 1, 2]);
});
