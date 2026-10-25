// SPDX-License-Identifier: MIT
/** Converting a project to ICU MessageFormat, on SQLite and on D1. */
import { sourceFileToIcu } from "@quaso/core";
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ANONYMOUS, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { convertToIcuAsync } from "../icu_conversion.ts";
import type { Sql, Statement } from "../ports.ts";
import { loadSettingsAsync } from "../settings.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";

const ADMIN: Actor = { type: "user", userId: 2 };
const MANAGER: Actor = { type: "user", userId: 1 };
const AT = { now: 500, model: "test" };
const UPLOAD = { model: "test", clock: () => 100, llmAvailable: false };

const ENGLISH = JSON.stringify({
  greeting: "Hello {{name}}",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  play: "Play",
});

async function change(sql: Sql, statements: Statement[]) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  await sql.commit(Number(rows[0].revision), statements);
}

async function upload(sql: Sql, content: string) {
  const file = { path: "common.json", repoPath: "common.json", content };
  return uploadAsync(sql, SYSTEM_AUTHOR, { files: [file], languages: ["de", "pl"] }, UPLOAD);
}

/** A translation of the active string with that key, made for its current English. */
function translation(
  key: string,
  language: string,
  value: unknown,
  colour: "green" | "blue",
  author: "user" | "llm",
): Statement {
  return {
    sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
      author_id, author_label, approver_id, revision, search_text, created_at, updated_at)
      SELECT id, ?, ?, ?, source_hash, ?, ?, ?, ?, 2, '', 100, 100 FROM strings
      WHERE display_key = ? AND active = 1`,
    params: [
      language,
      JSON.stringify(value),
      colour,
      author,
      author === "user" ? 1 : null,
      author === "llm" ? "a model" : null,
      colour === "blue" ? 2 : null,
      key,
    ],
  };
}

/**
 * The sample project: green and blue translations, an outdated one, a pending suggestion,
 * and a plural group with history and a comment.
 */
async function seed(sql: Sql) {
  await upload(sql, ENGLISH);
  await change(sql, [
    {
      sql: `INSERT INTO users (id, display_name, role, created_at)
        VALUES (1, 'Ada', 'manager', 100), (2, 'Grace', 'administrator', 100)`,
    },
    translation("greeting", "de", "Hallo {{name}}", "green", "llm"),
    translation("greeting", "pl", "Cześć {{name}}", "blue", "user"),
    translation(
      "coins",
      "de",
      { one: "{{count}} Münze", other: "{{count}} Münzen" },
      "blue",
      "user",
    ),
    translation(
      "coins",
      "pl",
      {
        one: "{{count}} moneta",
        few: "{{count}} monety",
        many: "{{count}} monet",
        other: "{{count}} monety",
      },
      "green",
      "llm",
    ),
    translation("play", "de", "Spielen", "green", "user"),
    { sql: "UPDATE translations SET source_hash = 'older English' WHERE value = '\"Spielen\"'" },
    {
      sql: `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
        author_type, author_id, created_at)
        SELECT id, 'de', 'correction', '"Hi {{name}}"', source_hash, 2, 'user', 1, 100 FROM strings
        WHERE display_key = 'greeting'`,
    },
    {
      sql: `INSERT INTO history (string_id, language, event, after_value, after_colour, actor_type,
        actor_id, created_at)
        SELECT id, 'de', 'translation_saved', '{}', 'blue', 'user', 1, 100 FROM strings
        WHERE display_key = 'coins'`,
    },
    {
      sql: `INSERT INTO comments (string_id, body, author_id, created_at)
        SELECT id, 'Mind the plural', 1, 100 FROM strings WHERE display_key = 'coins'`,
    },
  ]);
  const [coins] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'coins'" }]);
  return { coins: Number(coins[0].id) };
}

/** Everything the conversion may change. */
async function dump(sql: Sql) {
  return sql.read([
    { sql: "SELECT * FROM strings ORDER BY id" },
    { sql: "SELECT * FROM translations ORDER BY string_id, language" },
    { sql: "SELECT * FROM suggestions ORDER BY id" },
    { sql: "SELECT * FROM history ORDER BY id" },
    { sql: "SELECT data FROM settings" },
    { sql: "SELECT value FROM meta WHERE key = 'revision'" },
  ]);
}

async function rejected(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    check(error instanceof ServiceError);
    return error.code;
  }
  throw new Error("Expected an error");
}

export const ICU_CONVERSION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "the English, translations and suggestions become ICU; colours, authors, times and outdated flags stay",
    async run(sql) {
      await seed(sql);
      const result = await convertToIcuAsync(sql, ADMIN, {}, AT);
      checkEqual(result, {
        dryRun: false,
        converted: true,
        alreadyIcu: false,
        strings: 2,
        translations: 4,
        suggestions: 1,
        merged: [{ file: "common.json", key: "coins" }],
        escapes: 0,
        escaped: [],
        refusals: [],
        failing: [],
        revision: 3,
      });
      const [strings, translations, suggestions] = await sql.read([
        { sql: "SELECT display_key, key, kind, source FROM strings ORDER BY id" },
        {
          sql: `SELECT s.display_key, t.language, t.value, t.colour, t.author_type, t.author_id,
            t.approver_id, t.updated_at, t.revision, t.source_hash = s.source_hash AS current
            FROM translations t JOIN strings s ON s.id = t.string_id ORDER BY s.id, t.language`,
        },
        {
          sql: `SELECT g.value, g.status, g.base_revision, g.source_hash = s.source_hash AS current
            FROM suggestions g JOIN strings s ON s.id = g.string_id`,
        },
      ]);
      checkEqual(strings, [
        { display_key: "greeting", key: '["greeting"]', kind: "text", source: '"Hello {name}"' },
        {
          display_key: "coins",
          key: '["coins"]',
          kind: "text",
          source: '"{count, plural, one {{count} coin} other {{count} coins}}"',
        },
        { display_key: "play", key: '["play"]', kind: "text", source: '"Play"' },
      ]);
      const converted = { updated_at: 100, revision: 3, current: 1 };
      checkEqual(translations, [
        {
          display_key: "greeting",
          language: "de",
          value: '"Hallo {name}"',
          colour: "green",
          author_type: "llm",
          author_id: null,
          approver_id: null,
          ...converted,
        },
        {
          display_key: "greeting",
          language: "pl",
          value: '"Cześć {name}"',
          colour: "blue",
          author_type: "user",
          author_id: 1,
          approver_id: 2,
          ...converted,
        },
        {
          display_key: "coins",
          language: "de",
          value: '"{count, plural, one {{count} Münze} other {{count} Münzen}}"',
          colour: "blue",
          author_type: "user",
          author_id: 1,
          approver_id: 2,
          ...converted,
        },
        {
          display_key: "coins",
          language: "pl",
          value:
            '"{count, plural, one {{count} moneta} few {{count} monety} many {{count} monet} other {{count} monety}}"',
          colour: "green",
          author_type: "llm",
          author_id: null,
          approver_id: null,
          ...converted,
        },
        {
          display_key: "play",
          language: "de",
          value: '"Spielen"',
          colour: "green",
          author_type: "user",
          author_id: 1,
          approver_id: null,
          updated_at: 100,
          revision: 2,
          current: 0,
        },
      ]);
      checkEqual(suggestions, [
        { value: '"Hi {name}"', status: "pending", base_revision: 3, current: 1 },
      ]);
    },
  },
  {
    name: "a plural group keeps its row, so its translations keep their history and comments",
    async run(sql) {
      const ids = await seed(sql);
      await convertToIcuAsync(sql, ADMIN, {}, AT);
      const [history, comments] = await sql.read([
        {
          sql: `SELECT event, language, before_colour, after_colour, actor_type, actor_id
            FROM history WHERE string_id = ? ORDER BY id`,
          params: [ids.coins],
        },
        { sql: "SELECT string_id, body FROM comments" },
      ]);
      const byAdmin = { actor_type: "user", actor_id: 2 };
      checkEqual(history, [
        {
          event: "source_added",
          language: null,
          before_colour: null,
          after_colour: null,
          actor_type: "system",
          actor_id: null,
        },
        {
          event: "translation_saved",
          language: "de",
          before_colour: null,
          after_colour: "blue",
          actor_type: "user",
          actor_id: 1,
        },
        {
          event: "source_converted",
          language: null,
          before_colour: null,
          after_colour: null,
          ...byAdmin,
        },
        {
          event: "translation_converted",
          language: "de",
          before_colour: "blue",
          after_colour: "blue",
          ...byAdmin,
        },
        {
          event: "translation_converted",
          language: "pl",
          before_colour: "green",
          after_colour: "green",
          ...byAdmin,
        },
      ]);
      checkEqual(comments, [{ string_id: ids.coins, body: "Mind the plural" }]);
    },
  },
  {
    name: "the project reads ICU afterwards, and converting again changes nothing",
    async run(sql) {
      await seed(sql);
      await convertToIcuAsync(sql, ADMIN, {}, AT);
      const settings = await loadSettingsAsync(sql, "test");
      checkEqual(settings.syntax, {
        prefix: "{{",
        suffix: "}}",
        extra: [],
        optional: [],
        icu: true,
      });
      const before = await dump(sql);
      const again = await convertToIcuAsync(sql, ADMIN, {}, AT);
      checkEqual([again.alreadyIcu, again.converted, again.revision], [true, false, 3]);
      checkEqual(await dump(sql), before);
    },
  },
  {
    name: "a dry run reports the conversion and changes nothing",
    async run(sql) {
      await seed(sql);
      const before = await dump(sql);
      const result = await convertToIcuAsync(sql, ADMIN, { dryRun: true }, AT);
      checkEqual(
        [result.dryRun, result.converted, result.strings, result.translations, result.revision],
        [true, false, 2, 4, 2],
      );
      checkEqual(await dump(sql), before);
    },
  },
  {
    name: "texts ICU can't say are refused where they are, and nothing changes",
    async run(sql) {
      await seed(sql);
      await upload(
        sql,
        JSON.stringify({ ...JSON.parse(ENGLISH), back: "$t(menu.back)", price: "{{n, number}}" }),
      );
      await change(sql, [translation("greeting", "fr", "Salut {{user.name}}", "green", "user")]);
      await change(sql, [{ sql: "INSERT INTO languages (tag, created_at) VALUES ('fr', 100)" }]);
      const before = await dump(sql);
      const result = await convertToIcuAsync(sql, ADMIN, {}, AT);
      checkEqual(result.converted, false);
      checkEqual(result.refusals, [
        {
          file: "common.json",
          key: "back",
          message:
            "It is made of i18next nesting references only; ICU MessageFormat has no nesting",
        },
        {
          file: "common.json",
          key: "price",
          message:
            "{{n, number}} has an i18next format, which ICU MessageFormat writes differently",
        },
        {
          file: "common.json",
          key: "greeting",
          language: "fr",
          message:
            "{{user.name}} can't become an ICU argument: names are letters, digits and _ only",
        },
      ]);
      checkEqual(await dump(sql), before);
    },
  },
  {
    name: "a queued translation job stops the conversion",
    async run(sql) {
      await seed(sql);
      await change(sql, [
        {
          sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at)
            VALUES (4, 'queued', 2, 'website', '{}', 'system', 100, 100)`,
        },
      ]);
      const result = await convertToIcuAsync(sql, ADMIN, {}, AT);
      checkEqual(result.refusals, [
        { message: "Translation job 4 is queued or running: let it finish, or cancel it" },
      ]);
    },
  },
  {
    name: "a translation that fails the ICU checks stays, with its error, and is listed",
    async run(sql) {
      await upload(sql, JSON.stringify({ coins_one: "One coin", coins_other: "{{count}} coins" }));
      await change(sql, [
        translation(
          "coins",
          "pl",
          {
            one: "{{count}} moneta",
            few: "{{count}} monety",
            many: "x {{count}}",
            other: "y {{count}}",
          },
          "blue",
          "llm",
        ),
      ]);
      const failing = [
        {
          file: "common.json",
          key: "coins",
          language: "pl",
          check: "placeholder_extra",
          message: "Placeholder {count} isn't in the English in the one case of {count, plural}.",
        },
      ];
      const preview = await convertToIcuAsync(sql, { type: "system" }, { dryRun: true }, AT);
      checkEqual(preview.failing, failing);
      const result = await convertToIcuAsync(sql, { type: "system" }, {}, AT);
      checkEqual(result.failing, failing);
      const [rows] = await sql.read([{ sql: "SELECT colour, qa_errors FROM translations" }]);
      checkEqual(rows, [{ colour: "blue", qa_errors: 1 }]);
    },
  },
  {
    name: "a removed key that a plural group takes keeps its translation, and the converted file uploads unchanged",
    async run(sql) {
      await upload(sql, JSON.stringify({ coins: "Coins" }));
      await change(sql, [translation("coins", "de", "Münzen", "blue", "user")]);
      await upload(sql, ENGLISH);
      const result = await convertToIcuAsync(sql, { type: "system" }, {}, AT);
      checkEqual(result.converted, true);
      const [removed] = await sql.read([
        {
          sql: `SELECT s.id, s.key, s.active, t.value FROM strings s
            JOIN translations t ON t.string_id = s.id WHERE s.id = 1`,
        },
      ]);
      checkEqual(removed, [{ id: 1, key: '["coins"]#retired-1', active: 0, value: '"Münzen"' }]);
      const converted = sourceFileToIcu(ENGLISH, {
        syntax: { prefix: "{{", suffix: "}}" },
        language: "en",
      });
      const again = await upload(sql, converted.text);
      checkEqual(
        [again.added, again.changed, again.removed, again.restored, again.uploadId],
        [[], [], [], [], null],
      );
    },
  },
  {
    name: "a plural group whose key a string of the file has is refused",
    async run(sql) {
      await upload(sql, JSON.stringify({ coins: "Coins", ...JSON.parse(ENGLISH) }));
      const result = await convertToIcuAsync(sql, { type: "system" }, {}, AT);
      checkEqual(result.refusals, [
        {
          file: "common.json",
          key: "coins",
          message:
            "Its forms would become one string named coins, but another key has that name: rename one of them first",
        },
      ]);
    },
  },
  {
    name: "only administrators and upload keys convert",
    async run(sql) {
      await seed(sql);
      checkEqual(await rejected(() => convertToIcuAsync(sql, ANONYMOUS, {}, AT)), "unauthorized");
      checkEqual(await rejected(() => convertToIcuAsync(sql, MANAGER, {}, AT)), "forbidden");
    },
  },
];
