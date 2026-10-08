// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
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
  assertEquals(approved.imported, 1);
  const full = await importPl(instance, {
    title: "Podróżnik",
    greeting: "Hello, {{name}}!",
    menu: { play: "Graj" },
  });
  assertEquals(full.imported, 1);
  assertEquals(full.skippedBlue, 1);
  assertEquals(full.skippedIdentical, 1);
  assertEquals(
    instance.sql.query(`SELECT s.display_key AS key, t.value, t.colour
    FROM translations t JOIN strings s ON s.id = t.string_id ORDER BY s.position`),
    [
      { key: "title", value: '"Wędrowiec"', colour: "blue" },
      { key: "menu.play", value: '"Graj"', colour: "green" },
    ],
  );
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
  assertEquals(result, {
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
  assertEquals(translations(instance), [
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
  assertEquals(count(instance.sql, "history", "event = 'translation_imported'"), 3);
  assertEquals(count(instance.sql, "activity", "type = 'import'"), 1);
  assertEquals(getRevision(instance.sql), revision + 1, "one revision for the whole import");
});

test("import as blue, by an API key", async () => {
  using instance = await project();
  const token = await createToken(instance.service, "upload", "Migration");
  await instance.service.importTranslations(token.actor, {
    language: "pl",
    as: "blue",
    files: [jsonFile("common.json", { title: "Wędrowiec" })],
  });
  assertEquals(translations(instance), [
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
  assertEquals([skipped.imported, skipped.skippedIdentical], [0, 3]);
  assertEquals(count(instance.sql, "activity", "type = 'import'"), 0);
  const kept = await importPl(instance, file, { keepIdentical: true });
  assertEquals([kept.imported, kept.skippedIdentical], [3, 0]);
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
  assertEquals([result.imported, result.droppedForms, result.refused], [1, 1, []]);
  assertEquals(
    translations(instance).map((row) => [row.key, row.value]),
    [["coins", '{"other":"コイン{{count}}枚"}']],
  );
});

test("allowQaErrors imports failing values with their QA errors; export fills the gaps", async () => {
  using instance = await project();
  const file = { coins_one: "{{count}} moneta", coins_other: "{{count}} monet" };
  const result = await importPl(instance, file, { allowQaErrors: true });
  assertEquals([result.imported, result.refused.length], [1, 0]);
  assertEquals(
    result.flagged.map((item) => [item.key, item.checks.map((check) => check.form)]),
    [["coins", ["few", "many"]]],
  );
  assertEquals(instance.sql.query("SELECT qa_errors FROM translations"), [{ qa_errors: 2 }]);
  const exported = await instance.service.exportFiles(SYSTEM, { languages: ["pl"] });
  const polish = JSON.parse(exported.files[0].content);
  assertEquals(
    [polish.coins_one, polish.coins_few, polish.coins_many, polish.coins_other],
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
  assertEquals(
    [result.imported, result.skippedEmpty, result.flagged.length, result.refused.length],
    [1, 3, 0, 0],
  );
  assertEquals(
    translations(instance).map((row) => row.key),
    ["menu.play"],
  );
});

test("values that fail the checks are refused, with the checks", async () => {
  using instance = await project();
  const result = await importPl(instance, {
    greeting: "Cześć!",
    coins_one: "{{count}} moneta",
    coins_other: "{{count}} monety",
    title: "Wędrowiec",
  });
  assertEquals(result.imported, 1);
  assertEquals(
    result.refused.map((item) => [item.file, item.key, item.language]),
    [
      ["common.json", "greeting", "pl"],
      ["common.json", "coins", "pl"],
    ],
  );
  assertEquals(
    result.refused[0].checks.map((check) => check.check),
    ["placeholder_missing"],
  );
  assertEquals(
    result.refused[1].checks.map((check) => [check.check, check.form]),
    [
      ["plural_form_missing", "few"],
      ["plural_form_missing", "many"],
    ],
  );
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
  assertEquals([kept.imported, kept.unchanged, kept.skippedBlue], [0, 1, 1]);
  const same = await importPl(instance, { title: "Podróżnik" }, { as: "blue" });
  assertEquals([same.imported, same.unchanged, same.skippedBlue], [0, 1, 0]);
  const overwritten = await importPl(instance, { title: "Wędrowiec" }, { overwrite: true });
  assertEquals([overwritten.imported, overwritten.skippedBlue], [1, 0]);
  assertEquals(translations(instance)[0].value, '"Wędrowiec"');
  assertEquals(translations(instance)[0].colour, "green");
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
  assertEquals(result.imported, 1);
  assertEquals(result.unknownKeys, [
    { file: "common.json", key: "extra" },
    { file: "common.json", key: "menu.settings" },
  ]);
  assertEquals(result.unknownFiles, ["missing.json"]);
});

test("a dry run imports nothing", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const result = await importPl(instance, { title: "Wędrowiec" }, { dryRun: true });
  assertEquals([result.dryRun, result.imported], [true, 1]);
  assertEquals(count(instance.sql, "translations"), 0);
  assertEquals(count(instance.sql, "activity", "type = 'import'"), 0);
  assertEquals(getRevision(instance.sql), revision);
});

test("the language must be a project language, not the source", async () => {
  using instance = await project();
  for (const language of ["fr", "en"]) {
    const error = await assertRejects(
      () => importPl(instance, { title: "x" }, { language }),
      ServiceError,
    );
    assertEquals(error.code, "bad_request");
  }
});

test("invalid translation files are reported with their position", async () => {
  using instance = await project();
  const error = await assertRejects(
    () =>
      instance.service.importTranslations(SYSTEM, {
        language: "pl",
        as: "green",
        files: [{ path: "common.json", content: '{\n  "title": "Wędrowiec",\n}' }],
      }),
    ServiceError,
  );
  assertEquals(error.code, "invalid_source");
  assertEquals(error.details?.[0].file, "common.json");
  assertEquals(error.details?.[0].line, 2, "the trailing comma");
  assertEquals(count(instance.sql, "translations"), 0);
});
