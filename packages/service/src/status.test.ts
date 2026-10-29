// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import type { SyncSql, SqlRow, SqlValue } from "./ports.ts";
import {
  addUser,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  intro: "Everything you learn ends up here",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  back: "$t(title)",
  version: 3,
};
const HUD = { hp: "Health points" };

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(
    instance.service,
    { "common.json": COMMON, "hud.json": HUD },
    {
      languages: ["de", "pl", "ar"],
    },
  );
  return instance;
}

const BLUE = {
  colour: "blue" as const,
  actor: { type: "user" as const, id: 1, label: null },
  event: "translation_saved" as const,
};

test("progress counts strings, words and states per language and file", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  write(instance, "common.json", "intro", "de", "Alles, was du lernst, landet hier", BLUE);
  write(instance, "hud.json", "hp", "de", "Lebenspunkte", BLUE);
  write(
    instance,
    "common.json",
    "coins",
    "de",
    { one: "{{count}} Münze" },
    {
      allowQaErrors: true,
    },
  );
  instance.sql.run(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       author_type, created_at) VALUES (?, 'de', 'correction', '"Reisender"', 'x', 0, 'user', 0)`,
    stringId(instance.sql, "common.json", "title"),
  );
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarer II" },
    "hud.json": HUD,
  });
  const status = await instance.service.getStatus(SYSTEM, { language: "de" });
  expect(status.sourceLanguage).toBe("en");
  expect(status.languages.length).toBe(1);
  const de = status.languages[0];
  // Words: title 2, intro 6, coins 2 (forms), hp 2 → 12.
  expect({
    strings: de.strings,
    words: de.words,
    untranslated: de.untranslated,
    green: de.green,
    blue: de.blue,
    outdated: de.outdated,
    pending: de.pending,
    qa: de.qa,
    wordsLeft: de.wordsLeft,
    translatedPercent: de.translatedPercent,
    proofreadPercent: de.proofreadPercent,
  }).toStrictEqual({
    strings: 4,
    words: 12,
    untranslated: 0,
    green: 2,
    blue: 2,
    outdated: 1,
    pending: 1,
    qa: 1,
    wordsLeft: 0,
    translatedPercent: 100,
    proofreadPercent: 66,
  });
  expect([de.tag, de.name, de.direction]).toStrictEqual(["de", "German", "ltr"]);
  expect(de.plural).toStrictEqual({ cardinal: ["one", "other"], ordinal: ["other"] });
  expect(de.files.map((file) => [file.path, file.strings, file.words, file.blue])).toStrictEqual([
    ["common.json", 3, 10, 1],
    ["hud.json", 1, 2, 1],
  ]);
  expect(de.files[0].proofreadPercent).toBe(60);
});

test("status lists every language with its plural categories, after overrides", async () => {
  using instance = await project();
  instance.sql.run(
    "UPDATE languages SET plural_override = ? WHERE tag = 'pl'",
    JSON.stringify({ cardinal: ["one", "few", "other"] }),
  );
  const status = await instance.service.getStatus(SYSTEM, {});
  expect(status.languages.map((language) => [language.tag, language.direction])).toStrictEqual([
    ["ar", "rtl"],
    ["de", "ltr"],
    ["pl", "ltr"],
  ]);
  expect(status.languages[0].plural.cardinal).toStrictEqual([
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
  expect(status.languages[2].plural).toStrictEqual({
    cardinal: ["one", "few", "other"],
    ordinal: ["other"],
  });
  for (const language of status.languages) {
    expect([language.untranslated, language.translatedPercent]).toStrictEqual([4, 0]);
  }
});

test("percentages use string counts when there are no words", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    { "a.json": { a: "{{x}}", b: "{{y}}" } },
    {
      languages: ["de"],
    },
  );
  write(instance, "a.json", "a", "de", "{{x}}");
  const result = await instance.service.listFiles(ANONYMOUS, { language: "de" });
  assert(result.language !== undefined);
  const { files } = result;
  expect(files.map((file) => [file.path, file.words, file.translatedPercent])).toStrictEqual([
    ["a.json", 0, 50],
  ]);
});

test("unknown languages are not found", async () => {
  using instance = await project();
  const error = await instance.service
    .listFiles(ANONYMOUS, { language: "fr" })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("not_found");
});

test("getProject describes the project, its languages and facts", async () => {
  using instance = await project();
  addUser(instance.sql, "manager");
  addUser(instance.sql, "none");
  write(instance, "common.json", "title", "pl", "Wędrowiec");
  const info = await instance.service.getProject(ANONYMOUS, {});
  expect(info.name).toBe("Untitled project");
  expect([info.sourceLanguage, info.sourceLanguageName]).toStrictEqual(["en", "English"]);
  expect(info.syntax).toStrictEqual({
    prefix: "{{",
    suffix: "}}",
    extra: [],
    optional: [],
    icu: false,
  });
  expect(info.languages.map((language) => [language.tag, language.green])).toStrictEqual([
    ["ar", 0],
    ["de", 0],
    ["pl", 1],
  ]);
  expect(info.details).toStrictEqual({
    strings: 4,
    words: 11,
    files: 2,
    members: 1,
    lastActivity: instance.clock.now,
  });
  expect(info.llmAvailable).toBe(false);
  expect(info.referenceLanguages).toStrictEqual([]);
  expect(info.revision).toBe(2);
});

test("counts are kept until the next write, even one that doesn't raise the revision", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  let reads = 0;
  const query = instance.sql.query;
  instance.sql.query = <T extends SqlRow>(text: string, ...params: SqlValue[]): T[] => {
    if (text.includes("FROM translations WHERE language")) reads++;
    return query.call<SyncSql, [string, ...SqlValue[]], T[]>(instance.sql, text, ...params);
  };
  const first = await instance.service.getProject(ANONYMOUS, {});
  expect(reads, "one read per language").toBe(3);
  expect(await instance.service.getProject(ANONYMOUS, {})).toStrictEqual(first);
  const status = await instance.service.getStatus(SYSTEM, {});
  await instance.service.listFiles(ANONYMOUS, { language: "de" });
  expect(reads, "the same state is counted once").toBe(3);
  expect(status.languages.map((language) => language.green)).toStrictEqual([0, 1, 0]);

  instance.sql.run(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       author_type, created_at) VALUES (?, 'de', 'correction', '"Reisender"', 'x', 0, 'user', 0)`,
    stringId(instance.sql, "common.json", "title"),
  );
  const after = await instance.service.getStatus(SYSTEM, { language: "de" });
  expect(after.languages[0].pending).toBe(1);
  expect(reads).toBe(4);

  write(instance, "common.json", "intro", "de", "Alles", BLUE);
  const project2 = await instance.service.getProject(ANONYMOUS, {});
  expect(project2.languages.find((language) => language.tag === "de")?.blue).toBe(1);
});

test("source listings are public without a language and record only the last upload change", async () => {
  using instance = await startTestService();
  expect(await instance.service.listFiles(ANONYMOUS, {})).toStrictEqual({ files: [] });
  const file = {
    path: "main.json",
    repoPath: "src/locales/en/main.json",
    content: '{"hello":"Hello"}',
  };
  await instance.service.upload(SYSTEM, { files: [file] });
  const initial = await instance.service.listFiles(ANONYMOUS, {});
  assert(initial.language === undefined);
  expect(
    initial.files.map((source) => [
      source.path,
      source.repoPath,
      source.strings,
      source.words,
      source.revision,
    ]),
  ).toStrictEqual([["main.json", "src/locales/en/main.json", 1, 1, 1]]);
  instance.clock.advance(500);
  await instance.service.upload(SYSTEM, { files: [file] });
  expect(await instance.service.listFiles(ANONYMOUS, {})).toStrictEqual(initial);
  await instance.service.upload(SYSTEM, {
    files: [{ ...file, content: '{"hello":"Good morning"}' }],
  });
  const changed = await instance.service.listFiles(ANONYMOUS, {});
  assert(changed.language === undefined);
  expect([
    changed.files[0].words,
    changed.files[0].updatedAt,
    changed.files[0].revision,
  ]).toStrictEqual([2, initial.files[0].updatedAt + 500, 2]);
});
