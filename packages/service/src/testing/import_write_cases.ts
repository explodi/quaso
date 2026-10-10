// SPDX-License-Identifier: MIT
import type { ImportRequest } from "@quaso/core";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { importTranslationsAsync } from "../imports.ts";
import type { Sql, Statement } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const TOKEN: Actor = { type: "token", tokenId: 7 };
const ADMIN: Actor = { type: "user", userId: 2 };

async function change(sql: Sql, statements: Statement[]) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  await sql.commit(Number(rows[0].revision), statements);
}

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await change(sql, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 2" },
    { sql: "UPDATE api_tokens SET scope = 'upload' WHERE id = 7" },
  ]);
}

function request(
  values: Record<string, unknown>,
  extra: Partial<ImportRequest> = {},
): ImportRequest {
  return {
    language: "de",
    as: "green",
    files: [{ path: "common.json", content: JSON.stringify(values) }],
    ...extra,
  };
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

function conflict(sql: Sql, update: () => Promise<void>): Sql {
  let first = true;
  return {
    ...sql,
    async read(statements) {
      const rows = await sql.read(statements);
      if (first) {
        first = false;
        await update();
      }
      return rows;
    },
  };
}

export const IMPORT_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "whitespace errors refuse imports unless explicitly kept and flagged",
    async run(sql) {
      await seed(sql);
      const refused = await importTranslationsAsync(
        sql,
        SYSTEM,
        request({ title: "Hallo\n" }),
        200,
        "test",
      );
      checkEqual(refused.imported, 0);
      checkEqual(refused.refused[0].checks[0].check, "whitespace");
      const kept = await importTranslationsAsync(
        sql,
        SYSTEM,
        request({ title: "Hallo\n" }, { allowQaErrors: true }),
        200,
        "test",
      );
      checkEqual(kept.imported, 1);
      const [rows] = await sql.read([
        {
          sql: "SELECT t.value, t.qa_errors FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
      ]);
      checkEqual(rows, [{ value: JSON.stringify("Hallo\n"), qa_errors: 1 }]);
    },
  },
  {
    name: "imports multiple green translations and history with one revision and activity",
    async run(sql) {
      await seed(sql);
      const input = request(
        { title: "Guten Tag" },
        {
          language: "DE",
          files: [
            { path: "common.json", content: '{"title":"Guten Tag"}' },
            { path: "Menus/main.json", content: '{"start":"Starten"}' },
          ],
        },
      );
      const result = await importTranslationsAsync(sql, SYSTEM, input, 200, "test");
      checkEqual(
        [result.language, result.imported, result.unchanged, result.refused],
        ["de", 2, 0, []],
      );
      const [translations, history, activity] = await sql.read([
        {
          sql: "SELECT t.value, t.colour, t.revision, t.author_type, t.author_label, t.updated_at FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key IN ('title', 'start') AND language = 'de' ORDER BY s.display_key",
        },
        {
          sql: "SELECT event, actor_type, detail FROM history WHERE event = 'translation_imported' ORDER BY id",
        },
        { sql: "SELECT summary, detail FROM activity WHERE type = 'import'" },
      ]);
      checkEqual(translations, [
        {
          value: '"Starten"',
          colour: "green",
          revision: 4,
          author_type: "import",
          author_label: "Import",
          updated_at: 200,
        },
        {
          value: '"Guten Tag"',
          colour: "green",
          revision: 4,
          author_type: "import",
          author_label: "Import",
          updated_at: 200,
        },
      ]);
      checkEqual(history, [
        { event: "translation_imported", actor_type: "import", detail: '{"file":"common.json"}' },
        {
          event: "translation_imported",
          actor_type: "import",
          detail: '{"file":"Menus/main.json"}',
        },
      ]);
      checkEqual(activity[0].summary, "Import (de, green): 2 imported");
      checkEqual(JSON.parse(String(activity[0].detail)).files, ["common.json", "Menus/main.json"]);
    },
  },
  {
    name: "upload keys are stored as authors for blue imports and human imports use Import",
    async run(sql) {
      await seed(sql);
      const result = await importTranslationsAsync(
        sql,
        TOKEN,
        request({ title: "Guten Tag" }, { as: "blue" }),
        200,
        "test",
      );
      checkEqual(result.imported, 1);
      const [rows] = await sql.read([
        {
          sql: "SELECT colour, author_type, author_id, author_label, approver_id FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
      ]);
      checkEqual(rows, [
        {
          colour: "blue",
          author_type: "token",
          author_id: 7,
          author_label: "CI",
          approver_id: null,
        },
      ]);
      await importTranslationsAsync(
        sql,
        ADMIN,
        request({ title: "Human import" }, { overwrite: true }),
        300,
        "test",
      );
      const [authors] = await sql.read([
        {
          sql: "SELECT author_type, author_id, author_label FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
      ]);
      checkEqual(authors, [{ author_type: "import", author_id: null, author_label: "Import" }]);
    },
  },
  {
    name: "identical English is skipped unless requested and blue values stay unless overwrite",
    async run(sql) {
      await seed(sql);
      const skipped = await importTranslationsAsync(
        sql,
        SYSTEM,
        request({ title: "Hello", play: "Los" }),
        200,
        "test",
      );
      checkEqual([skipped.imported, skipped.skippedIdentical, skipped.skippedBlue], [0, 1, 1]);
      const included = await importTranslationsAsync(
        sql,
        SYSTEM,
        request({ title: "Hello", play: "Los" }, { keepIdentical: true, overwrite: true }),
        200,
        "test",
      );
      checkEqual([included.imported, included.skippedIdentical, included.skippedBlue], [2, 0, 0]);
    },
  },
  {
    name: "unchanged values preserve their source hash and no-op imports write no activity",
    async run(sql) {
      await seed(sql);
      const result = await importTranslationsAsync(
        sql,
        SYSTEM,
        request({ title: "Hallo", play: "Spielen" }),
        200,
        "test",
      );
      checkEqual([result.imported, result.unchanged, result.skippedBlue], [0, 1, 1]);
      const [translation, revision, activity] = await sql.read([
        {
          sql: "SELECT t.source_hash, t.revision FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT id FROM activity WHERE type = 'import'" },
      ]);
      checkEqual(translation, [{ source_hash: "old", revision: 2 }]);
      checkEqual(revision, [{ value: "3" }]);
      checkEqual(activity, []);
    },
  },
  {
    name: "QA refusals and unknown keys and files are reported while accepted keys proceed",
    async run(sql) {
      await seed(sql);
      await change(sql, [{ sql: "UPDATE strings SET max_length = 1 WHERE display_key = 'title'" }]);
      const result = await importTranslationsAsync(
        sql,
        SYSTEM,
        request(
          {},
          {
            files: [
              { path: "common.json", content: '{"title":"Too long","unknown":"Unknown"}' },
              { path: "Menus/main.json", content: '{"start":"Starten"}' },
              { path: "missing.json", content: "not parsed" },
            ],
          },
        ),
        200,
        "test",
      );
      checkEqual(result.imported, 1);
      checkEqual(
        result.refused.map((row) => [row.file, row.key, row.language]),
        [["common.json", "title", "de"]],
      );
      check(result.refused[0].checks.length > 0);
      checkEqual(result.unknownKeys, [{ file: "common.json", key: "unknown" }]);
      checkEqual(result.unknownFiles, ["missing.json"]);
    },
  },
  {
    name: "dry-run returns the same decisions without any commit or side effects",
    async run(sql) {
      await seed(sql);
      const dry: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Dry run must not commit");
        },
      };
      const result = await importTranslationsAsync(
        dry,
        SYSTEM,
        request({ title: "Guten Tag" }, { dryRun: true }),
        200,
        "test",
      );
      checkEqual([result.dryRun, result.imported], [true, 1]);
      const [translation, history, activity, revision] = await sql.read([
        {
          sql: "SELECT value FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
        { sql: "SELECT event FROM history WHERE event = 'translation_imported'" },
        { sql: "SELECT id FROM activity WHERE type = 'import'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"' }]);
      checkEqual(history, []);
      checkEqual(activity, []);
      checkEqual(revision, [{ value: "3" }]);
    },
  },
  {
    name: "malformed files and duplicate paths leave earlier accepted files untouched",
    async run(sql) {
      await seed(sql);
      const error = await rejected(
        () =>
          importTranslationsAsync(
            sql,
            SYSTEM,
            request(
              {},
              {
                files: [
                  { path: "common.json", content: '{"title":"Guten Tag"}' },
                  { path: "Menus/main.json", content: '{"start":' },
                ],
              },
            ),
            200,
            "test",
          ),
        "invalid_source",
      );
      checkEqual(error.details?.[0].file, "Menus/main.json");
      await rejected(
        () =>
          importTranslationsAsync(
            sql,
            SYSTEM,
            request(
              {},
              {
                files: [
                  { path: "common.json", content: '{"title":"Guten Tag"}' },
                  { path: "common.json", content: "{}" },
                ],
              },
            ),
            200,
            "test",
          ),
        "bad_request",
      );
      const [translation, revision] = await sql.read([
        {
          sql: "SELECT value FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"' }]);
      checkEqual(revision, [{ value: "3" }]);
    },
  },
  {
    name: "upload permission and target-language validation apply before writes",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => importTranslationsAsync(sql, ANONYMOUS, request({}), 200, "test"),
        "unauthorized",
      );
      await rejected(
        () => importTranslationsAsync(sql, { type: "user", userId: 1 }, request({}), 200, "test"),
        "forbidden",
      );
      await rejected(
        () => importTranslationsAsync(sql, SYSTEM, request({}, { language: "en" }), 200, "test"),
        "bad_request",
      );
      await rejected(
        () => importTranslationsAsync(sql, SYSTEM, request({}, { language: "es" }), 200, "test"),
        "bad_request",
      );
    },
  },
  {
    name: "a concurrent blue edit is protected on retry and current token names are captured",
    async run(sql) {
      await seed(sql);
      const raced = conflict(sql, () =>
        change(sql, [
          {
            sql: "UPDATE translations SET colour = 'blue', value = '\"Winner\"' WHERE string_id IN (SELECT id FROM strings WHERE display_key = 'title') AND language = 'de'",
          },
          { sql: "UPDATE api_tokens SET name = 'Renamed CI' WHERE id = 7" },
        ]),
      );
      const skipped = await importTranslationsAsync(
        raced,
        TOKEN,
        request({ title: "Import", play: "Changed" }),
        200,
        "test",
      );
      checkEqual([skipped.imported, skipped.skippedBlue], [0, 2]);
      const overwritten = await importTranslationsAsync(
        sql,
        TOKEN,
        request({ title: "Import" }, { overwrite: true }),
        250,
        "test",
      );
      checkEqual(overwritten.imported, 1);
      const [rows] = await sql.read([
        {
          sql: "SELECT author_label FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
      ]);
      checkEqual(rows, [{ author_label: "Renamed CI" }]);
    },
  },
  {
    name: "QA, current English and active files are refreshed after a conflict",
    async run(sql) {
      await seed(sql);
      const raced = conflict(sql, () =>
        change(sql, [
          { sql: "UPDATE strings SET source = '\"Hello {{name}}\"' WHERE display_key = 'title'" },
          { sql: "UPDATE files SET active = 0 WHERE path = 'Menus/main.json'" },
        ]),
      );
      const result = await importTranslationsAsync(
        raced,
        SYSTEM,
        request(
          {},
          {
            files: [
              { path: "common.json", content: '{"title":"Guten Tag"}' },
              { path: "Menus/main.json", content: '{"start":"Starten"}' },
            ],
          },
        ),
        200,
        "test",
      );
      checkEqual(
        [result.imported, result.refused.length, result.unknownFiles],
        [0, 1, ["Menus/main.json"]],
      );
      checkEqual(result.refused[0].checks[0].check, "placeholder_missing");
    },
  },
  {
    name: "revoked upload keys cannot commit using their old authority",
    async run(sql) {
      await seed(sql);
      const raced = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE api_tokens SET revoked_at = 150 WHERE id = 7" }]),
      );
      await rejected(
        () => importTranslationsAsync(raced, TOKEN, request({ title: "Guten Tag" }), 200, "test"),
        "forbidden",
      );
      const [rows] = await sql.read([
        {
          sql: "SELECT value FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
      ]);
      checkEqual(rows, [{ value: '"Hallo"' }]);
    },
  },
  {
    name: "failed commits roll back imported values, history, activity and revision",
    async run(sql) {
      await seed(sql);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await importTranslationsAsync(broken, SYSTEM, request({ title: "Guten Tag" }), 200, "test");
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [translation, history, activity, revision] = await sql.read([
        {
          sql: "SELECT value FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.display_key = 'title' AND language = 'de'",
        },
        { sql: "SELECT event FROM history WHERE event = 'translation_imported'" },
        { sql: "SELECT id FROM activity WHERE type = 'import'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"' }]);
      checkEqual(history, []);
      checkEqual(activity, []);
      checkEqual(revision, [{ value: "3" }]);
    },
  },
  {
    name: "validated imports enforce input and permission error precedence",
    async run(sql) {
      await seed(sql);
      const methods = asyncWriteMethods({ sql, clock: () => 200 });
      await rejected(
        () =>
          methods.importTranslations(
            { type: "user", userId: 1 },
            request({}, { as: "red" as never }),
          ),
        "forbidden",
      );
      await rejected(
        () => methods.importTranslations(TOKEN, request({}, { as: "red" as never })),
        "validation_failed",
      );
      const result = await methods.importTranslations(TOKEN, request({ title: "Guten Tag" }));
      checkEqual([result.language, result.imported], ["de", 1]);
    },
  },
];
