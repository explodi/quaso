// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
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
  assertEquals(reads, 1);
  assertEquals(revision, 7);
  assertEquals(state.hasStrings, true);
  assertEquals(state.settings.llm.model, "test-model");
  assertEquals(
    state.files.map((row) => row.path),
    ["menu.json", "other.json", "hidden.json"],
  );
  assertEquals(
    state.strings.map((row) => row.id),
    [1],
  );
  assertEquals(
    state.translations.map((row) => [row.string_id, row.value]),
    [[1, '"Hallo"']],
  );
  assertEquals(state.suggestions.length, 1);
  assertEquals(state.humanHistory, [
    { string_id: 1, language: null, people: 1 },
    { string_id: 1, language: "de", people: 1 },
  ]);
  assertEquals(state.renames, [{ string_id: 1, detail: '{"fromStringId":4}' }]);
  assertEquals(state.languages[0].pluralOverride, { cardinal: ["other"] });
  assertEquals(state.glossary[0].term, "Wayfarer");
  assertEquals(state.nextIds, { file: 4, string: 4, upload: 1, job: 1 });
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
  assertEquals(
    state.strings.map((row) => row.id),
    [2, 3],
  );
  assertEquals(
    state.translations.map((row) => row.string_id),
    [2],
  );
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
  assertEquals(
    state.strings.map((row) => row.id),
    [1, 2],
  );
  assertEquals(
    state.translations.map((row) => row.string_id),
    [1, 2],
  );
  assertEquals(
    state.humanHistory.map((row) => row.string_id),
    [1, 1, 2],
  );
});
