// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SYSTEM } from "./api.ts";
import { createAsyncService } from "./service_async.ts";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { migrate } from "./migrate.ts";
import { MIGRATION_1 } from "./migrations/001_initial.ts";
import { DATABASE_VERSION } from "./migrations.ts";

test("duplicate warnings flag both keys, stay nonblocking and disappear after correction", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    const service = createAsyncService({
      sql: opened.sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.upload(SYSTEM, {
      files: [
        {
          path: "buildings.json",
          repoPath: "buildings.json",
          content: '{"barn":"Storage Barn","loft":"Hay Loft"}',
        },
      ],
      languages: ["de"],
    });
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      files: [{ path: "buildings.json", content: '{"barn":"Scheune","loft":"scheune"}' }],
    });
    const qa = await service.listStrings(SYSTEM, { language: "de", state: "qa" });
    assertEquals(qa.total, 2);
    const barn = qa.strings[0];
    const detail = await service.getString(SYSTEM, { id: barn.id, language: "de" });
    assertEquals(detail.checks[0].check, "duplicate_translation");
    assertEquals(detail.checks[0].severity, "warning");
    assertStringIncludes(detail.checks[0].message, "loft");
    assertStringIncludes(detail.checks[0].message, "Hay Loft");
    assertEquals((await service.getStatus(SYSTEM, {})).languages[0].qa, 2);
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      overwrite: true,
      files: [{ path: "buildings.json", content: '{"loft":"Heuboden"}' }],
    });
    assertEquals((await service.listStrings(SYSTEM, { language: "de", state: "qa" })).total, 0);
    assertEquals((await service.getString(SYSTEM, { id: barn.id, language: "de" })).checks, []);
  } finally {
    opened.close();
  }
});

test("contextual-check migration keeps existing translations, history, roles and settings", async () => {
  const opened = openNodeSqlite(":memory:");
  try {
    await migrate(opened.sql, { migrations: [MIGRATION_1] });
    opened.sql.script(`
      INSERT INTO files (id, path, repo_path, format, created_at, updated_at) VALUES (1, 'a.json', 'a.json', '{}', 1, 1);
      INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash, search_text, position, created_at, updated_at) VALUES (1, 1, 'a', '["a"]', 'a', 'text', '"Source"', 'source', 'source', 1, 1, 1);
      INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at) VALUES (1, 'de', '"Kept"', 'blue', 'source', 'user', 3, 'kept', 1, 1);
      INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Owner', 'administrator', 1);
      INSERT INTO settings (id, data) VALUES (1, '{"name":"Kept project"}');
      INSERT INTO history (string_id, event, after_value, actor_type, created_at) VALUES (1, 'translation_saved', '"Kept"', 'user', 1);
    `);
    await migrate(opened.sql);
    assertEquals(opened.sql.query("SELECT value, colour, extra_checks FROM translations"), [
      { value: '"Kept"', colour: "blue", extra_checks: "[]" },
    ]);
    assertEquals(opened.sql.query("SELECT after_value FROM history"), [{ after_value: '"Kept"' }]);
    assertEquals(opened.sql.query("SELECT role FROM users"), [{ role: "administrator" }]);
    assertEquals(opened.sql.query("SELECT data FROM settings"), [
      { data: '{"name":"Kept project"}' },
    ]);
    assertEquals(opened.sql.query("SELECT value FROM meta WHERE key = 'schema_version'"), [
      { value: String(DATABASE_VERSION) },
    ]);
  } finally {
    opened.close();
  }
});
