// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SYSTEM } from "./api.ts";
import { refreshContextualChecks } from "./contextual_checks.ts";
import type { Sql, SqlRow, Statement } from "./ports.ts";
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

test("progress read between a commit and its check refresh isn't served after the refresh", async () => {
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
      files: [{ path: "buildings.json", content: '{"barn":"Scheune","loft":"Heuboden"}' }],
    });
    const [[{ revision }]] = await opened.sql.read([
      { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
    ]);
    // A commit that bypasses the service's check refresh, as if the read below came in between.
    await opened.sql.commit(Number(revision), [
      {
        sql: `UPDATE translations SET value = '"scheune"' WHERE language = 'de'
          AND string_id = (SELECT id FROM strings WHERE display_key = 'loft')`,
      },
    ]);
    assertEquals((await service.getStatus(SYSTEM, {})).languages[0].qa, 0);
    await refreshContextualChecks(opened.sql);
    assertEquals((await service.getStatus(SYSTEM, {})).languages[0].qa, 2);
  } finally {
    opened.close();
  }
});

async function twoFileProject(sql: Sql) {
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "test",
  });
  await service.start();
  await service.upload(SYSTEM, {
    files: [
      {
        path: "menu.json",
        repoPath: "menu.json",
        content: '{"open":"Open","start":"Start","quit":"Quit"}',
      },
      { path: "dialog.json", repoPath: "dialog.json", content: '{"open":"Open","close":"Close"}' },
    ],
    languages: ["de", "fr"],
  });
  await service.importTranslations(SYSTEM, {
    language: "de",
    as: "blue",
    files: [
      { path: "menu.json", content: '{"open":"Öffnen","start":"Beginnen","quit":"Beenden"}' },
      { path: "dialog.json", content: '{"open":"Aufmachen","close":"Schließen"}' },
    ],
  });
  await service.importTranslations(SYSTEM, {
    language: "fr",
    as: "blue",
    files: [{ path: "dialog.json", content: '{"open":"Ouvrir","close":"ouvrir"}' }],
  });
  return service;
}

const EXTRA_CHECKS: Statement = {
  sql: "SELECT string_id, language, extra_checks FROM translations ORDER BY string_id, language",
};

/** The checks as stored, and as a full refresh then stores them. */
async function storedAndFull(sql: Sql) {
  const [stored] = await sql.read([EXTRA_CHECKS]);
  await refreshContextualChecks(sql);
  const [full] = await sql.read([EXTRA_CHECKS]);
  return { stored, full };
}

/** Which translations have warnings, as "string language". */
function warned(rows: SqlRow[]) {
  return rows
    .filter((row) => row.extra_checks !== "[]")
    .map((row) => `${row.string_id} ${row.language}`);
}

test("checks refreshed after each translation save equal a full refresh's", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    const service = await twoFileProject(opened.sql);
    const afterImports = await storedAndFull(opened.sql);
    assertEquals(afterImports.stored, afterImports.full);
    // menu › open and dialog › open differ in German; both French values are "ouvrir".
    assertEquals(warned(afterImports.full), ["1 de", "4 de", "4 fr", "5 fr"]);

    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      overwrite: true,
      files: [{ path: "menu.json", content: '{"quit":"beginnen"}' }],
    });
    const afterDuplicate = await storedAndFull(opened.sql);
    assertEquals(afterDuplicate.stored, afterDuplicate.full);
    assertEquals(warned(afterDuplicate.full), ["1 de", "2 de", "3 de", "4 de", "4 fr", "5 fr"]);

    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      overwrite: true,
      files: [{ path: "dialog.json", content: '{"open":"Öffnen"}' }],
    });
    const afterAgreeing = await storedAndFull(opened.sql);
    assertEquals(afterAgreeing.stored, afterAgreeing.full);
    assertEquals(warned(afterAgreeing.full), ["2 de", "3 de", "4 fr", "5 fr"]);
  } finally {
    opened.close();
  }
});

test("a translation save reads the translations it can affect, not the whole project", async () => {
  const opened = openAsyncSqlite(":memory:");
  const reads: string[] = [];
  const recording: Sql = {
    ...opened.sql,
    read(statements) {
      reads.push(...statements.map((statement) => statement.sql));
      return opened.sql.read(statements);
    },
  };
  try {
    const service = await twoFileProject(recording);
    reads.length = 0;
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      overwrite: true,
      files: [{ path: "menu.json", content: '{"quit":"beginnen"}' }],
    });
    const scoped = reads.filter((sql) => sql.includes("WITH scope"));
    const whole = reads.filter(
      (sql) => sql.includes("extra_checks") && !sql.includes("WITH scope"),
    );
    assertEquals([scoped.length, whole.length], [1, 0]);
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
