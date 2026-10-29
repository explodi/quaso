// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { ImportRequest } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { getRevision } from "./db.ts";
import { ServiceError } from "./errors.ts";
import {
  count,
  createToken,
  jsonFile,
  startTestService,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  greeting: "Hello, {{name}}!",
  menu: { play: "Play", quit: "Quit" },
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  version: 3,
};

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["pl", "de"] });
  return instance;
}

function importPl(instance: TestInstance, value: unknown, extra: Partial<ImportRequest> = {}) {
  return instance.service.importTranslations(SYSTEM, {
    language: "pl",
    as: "green",
    files: [jsonFile("common.json", value)],
    ...extra,
  });
}

function translations(instance: TestInstance) {
  return instance.sql.query(
    `SELECT s.display_key AS key, t.value, t.colour, t.author_type, t.author_label
     FROM translations t JOIN strings s ON s.id = t.string_id ORDER BY s.position`,
  );
}

test("approved export followed by full export preserves blue and skips English", async () => {
  using instance = await project();
  const approved = await importPl(instance, { title: "Wędrowiec" }, { as: "blue" });
  expect(approved.imported).toBe(1);
  const full = await importPl(instance, {
    title: "Podróżnik",
    greeting: "Hello, {{name}}!",
    menu: { play: "Graj" },
  });
  expect(full.imported).toBe(1);
  expect(full.skippedBlue).toBe(1);
  expect(full.skippedIdentical).toBe(1);
  expect(
    instance.sql.query(`SELECT s.display_key AS key, t.value, t.colour
    FROM translations t JOIN strings s ON s.id = t.string_id ORDER BY s.position`),
  ).toStrictEqual([
    { key: "title", value: '"Wędrowiec"', colour: "blue" },
    { key: "menu.play", value: '"Graj"', colour: "green" },
  ]);
});

test("import writes green translations through the write path", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const result = await importPl(instance, {
    title: "Wędrowiec",
    menu: { play: "Graj" },
    coins_one: "{{count}} moneta",
    coins_few: "{{count}} monety",
    coins_many: "{{count}} monet",
    coins_other: "{{count}} monety",
  });
  expect(result).toStrictEqual({
    dryRun: false,
    language: "pl",
    imported: 3,
    unchanged: 0,
    skippedIdentical: 0,
    skippedEmpty: 0,
    droppedForms: 0,
    skippedBlue: 0,
    refused: [],
    flagged: [],
    unknownKeys: [],
    unknownFiles: [],
  });
  expect(translations(instance)).toStrictEqual([
    {
      key: "title",
      value: '"Wędrowiec"',
      colour: "green",
      author_type: "import",
      author_label: "Import",
    },
    {
      key: "menu.play",
      value: '"Graj"',
      colour: "green",
      author_type: "import",
      author_label: "Import",
    },
    {
      key: "coins",
      value:
        '{"one":"{{count}} moneta","few":"{{count}} monety","many":"{{count}} monet","other":"{{count}} monety"}',
      colour: "green",
      author_type: "import",
      author_label: "Import",
    },
  ]);
  expect(count(instance.sql, "history", "event = 'translation_imported'")).toBe(3);
  expect(count(instance.sql, "activity", "type = 'import'")).toBe(1);
  expect(getRevision(instance.sql), "one revision for the whole import").toStrictEqual(
    revision + 1,
  );
});

test("import as blue, by an API key", async () => {
  using instance = await project();
  const token = await createToken(instance.service, "upload", "Migration");
  await instance.service.importTranslations(token.actor, {
    language: "pl",
    as: "blue",
    files: [jsonFile("common.json", { title: "Wędrowiec" })],
  });
  expect(translations(instance)).toStrictEqual([
    {
      key: "title",
      value: '"Wędrowiec"',
      colour: "blue",
      author_type: "token",
      author_label: "Migration",
    },
  ]);
});

test("values identical to the English are skipped unless keepIdentical", async () => {
  using instance = await project();
  const file = {
    title: "Wayfarer",
    menu: { play: "Play" },
    coins_one: "{{count}} coin",
    coins_few: "{{count}} coins",
    coins_many: "{{count}} coins",
    coins_other: "{{count}} coins",
  };
  const skipped = await importPl(instance, file);
  expect([skipped.imported, skipped.skippedIdentical]).toStrictEqual([0, 3]);
  expect(count(instance.sql, "activity", "type = 'import'")).toBe(0);
  const kept = await importPl(instance, file, { keepIdentical: true });
  expect([kept.imported, kept.skippedIdentical]).toStrictEqual([3, 0]);
});

test("plural forms the language doesn't use are ignored, not refused", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["ja"] });
  const result = await instance.service.importTranslations(SYSTEM, {
    language: "ja",
    as: "green",
    files: [
      jsonFile("common.json", { coins_one: "コイン{{count}}枚", coins_other: "コイン{{count}}枚" }),
    ],
  });
  expect([result.imported, result.droppedForms, result.refused]).toStrictEqual([1, 1, []]);
  expect(translations(instance).map((row) => [row.key, row.value])).toStrictEqual([
    ["coins", '{"other":"コイン{{count}}枚"}'],
  ]);
});

test("allowQaErrors imports failing values with their QA errors; export fills the gaps", async () => {
  using instance = await project();
  const file = { coins_one: "{{count}} moneta", coins_other: "{{count}} monet" };
  const result = await importPl(instance, file, { allowQaErrors: true });
  expect([result.imported, result.refused.length]).toStrictEqual([1, 0]);
  expect(
    result.flagged.map((item) => [item.key, item.checks.map((check) => check.form)]),
  ).toStrictEqual([["coins", ["few", "many"]]]);
  expect(instance.sql.query("SELECT qa_errors FROM translations")).toStrictEqual([
    { qa_errors: 2 },
  ]);
  const exported = await instance.service.exportFiles(SYSTEM, { languages: ["pl"] });
  const polish = JSON.parse(exported.files[0].content);
  expect([polish.coins_one, polish.coins_few, polish.coins_many, polish.coins_other]).toStrictEqual(
    ["{{count}} moneta", "{{count}} coins", "{{count}} coins", "{{count}} monet"],
  );
});

test("empty values are skipped as untranslated, even with allowQaErrors", async () => {
  using instance = await project();
  const file = {
    title: "",
    greeting: "  ",
    coins_one: "",
    coins_other: "",
    menu: { play: "Graj" },
  };
  const result = await importPl(instance, file, { as: "blue", allowQaErrors: true });
  expect([
    result.imported,
    result.skippedEmpty,
    result.flagged.length,
    result.refused.length,
  ]).toStrictEqual([1, 3, 0, 0]);
  expect(translations(instance).map((row) => row.key)).toStrictEqual(["menu.play"]);
});

test("values that fail the checks are refused, with the checks", async () => {
  using instance = await project();
  const result = await importPl(instance, {
    greeting: "Cześć!",
    coins_one: "{{count}} moneta",
    coins_other: "{{count}} monety",
    title: "Wędrowiec",
  });
  expect(result.imported).toBe(1);
  expect(result.refused.map((item) => [item.file, item.key, item.language])).toStrictEqual([
    ["common.json", "greeting", "pl"],
    ["common.json", "coins", "pl"],
  ]);
  expect(result.refused[0].checks.map((check) => check.check)).toStrictEqual([
    "placeholder_missing",
  ]);
  expect(result.refused[1].checks.map((check) => [check.check, check.form])).toStrictEqual([
    ["plural_form_missing", "few"],
    ["plural_form_missing", "many"],
  ]);
});

test("blue translations stay unless overwrite; the same value is unchanged", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "pl", "Podróżnik", {
    colour: "blue",
    actor: { type: "user", id: 1, label: null },
    event: "translation_saved",
  });
  write(instance, "common.json", "menu.play", "pl", "Graj");
  const kept = await importPl(instance, { title: "Wędrowiec", menu: { play: "Graj" } });
  expect([kept.imported, kept.unchanged, kept.skippedBlue]).toStrictEqual([0, 1, 1]);
  const same = await importPl(instance, { title: "Podróżnik" }, { as: "blue" });
  expect([same.imported, same.unchanged, same.skippedBlue]).toStrictEqual([0, 1, 0]);
  const overwritten = await importPl(instance, { title: "Wędrowiec" }, { overwrite: true });
  expect([overwritten.imported, overwritten.skippedBlue]).toStrictEqual([1, 0]);
  expect(translations(instance)[0].value).toBe('"Wędrowiec"');
  expect(translations(instance)[0].colour).toBe("green");
});

test("unknown keys and files are reported and skipped", async () => {
  using instance = await project();
  const result = await instance.service.importTranslations(SYSTEM, {
    language: "pl",
    as: "green",
    files: [
      jsonFile("common.json", { title: "Wędrowiec", extra: "Nowy", menu: { settings: "Opcje" } }),
      jsonFile("missing.json", { a: "A" }),
    ],
  });
  expect(result.imported).toBe(1);
  expect(result.unknownKeys).toStrictEqual([
    { file: "common.json", key: "extra" },
    { file: "common.json", key: "menu.settings" },
  ]);
  expect(result.unknownFiles).toStrictEqual(["missing.json"]);
});

test("a dry run imports nothing", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const result = await importPl(instance, { title: "Wędrowiec" }, { dryRun: true });
  expect([result.dryRun, result.imported]).toStrictEqual([true, 1]);
  expect(count(instance.sql, "translations")).toBe(0);
  expect(count(instance.sql, "activity", "type = 'import'")).toBe(0);
  expect(getRevision(instance.sql)).toStrictEqual(revision);
});

test("the language must be a project language, not the source", async () => {
  using instance = await project();
  for (const language of ["fr", "en"]) {
    const error = await importPl(instance, { title: "x" }, { language }).catch(
      (error: unknown) => error,
    );
    assert(error instanceof ServiceError);
    expect(error.code).toBe("bad_request");
  }
});

test("invalid translation files are reported with their position", async () => {
  using instance = await project();
  const error = await instance.service
    .importTranslations(SYSTEM, {
      language: "pl",
      as: "green",
      files: [{ path: "common.json", content: '{\n  "title": "Wędrowiec",\n}' }],
    })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("invalid_source");
  expect(error.details?.[0].file).toBe("common.json");
  expect(error.details?.[0].line, "the trailing comma").toBe(2);
  expect(count(instance.sql, "translations")).toBe(0);
});
