// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { RepositorySettings, UploadResult } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { getRevision } from "./db.ts";
import { loadSettings } from "./settings.ts";
import { jsonFile, startTestService, type TestInstance } from "./test_helpers.ts";

const COMMON = { title: "Quest", coins_one: "{{count}} coin", coins_other: "{{count}} coins" };

function upload(
  instance: TestInstance,
  settings: RepositorySettings | undefined,
  options: { dryRun?: boolean; partial?: boolean } = {},
): Promise<UploadResult> {
  return instance.service.upload(SYSTEM, {
    files: [{ ...jsonFile("common.json", COMMON), repoPath: "src/en/common.json" }],
    languages: ["de"],
    settings,
    ...options,
  });
}

function settingsOf(instance: TestInstance) {
  return loadSettings({ sql: instance.sql, defaultModel: "test-model" });
}

function germanRow(instance: TestInstance) {
  return instance.sql.query(
    "SELECT instructions, plural_override FROM languages WHERE tag = 'de'",
  )[0];
}

test("an upload stores the settings the config gives", async () => {
  using instance = await startTestService();
  const result = await upload(instance, {
    name: "Quaso Quest",
    llm: { projectInstructions: "Keep it playful." },
  });
  expect(result.settings).toStrictEqual(["name", "llm.projectInstructions"]);
  expect(settingsOf(instance).name).toBe("Quaso Quest");
  expect(settingsOf(instance).llm.projectInstructions).toBe("Keep it playful.");
});

test("settings the config leaves out stay as they are", async () => {
  using instance = await startTestService();
  await instance.service.updateSettings(SYSTEM, { description: "Written on the website" });
  await upload(instance, { name: "Quaso Quest" });
  expect(settingsOf(instance).description).toBe("Written on the website");
});

test("the config wins over a value changed on the website", async () => {
  using instance = await startTestService();
  await upload(instance, { name: "Quaso Quest" });
  await instance.service.updateSettings(SYSTEM, { name: "Renamed on the website" });
  const result = await upload(instance, { name: "Quaso Quest" });
  expect(result.settings).toStrictEqual(["name"]);
  expect(settingsOf(instance).name).toBe("Quaso Quest");
});

test("an upload with the same settings changes nothing", async () => {
  using instance = await startTestService();
  await upload(instance, { name: "Quaso Quest", llm: { context: { glossary: false } } });
  const result = await upload(instance, {
    name: "Quaso Quest",
    llm: { context: { glossary: false } },
  });
  expect(result.settings).toStrictEqual([]);
  expect(result.uploadId).toBe(null);
});

test("one field of llm.context changes without the others", async () => {
  using instance = await startTestService();
  const result = await upload(instance, { llm: { context: { glossary: false } } });
  expect(result.settings).toStrictEqual(["llm.context.glossary"]);
  expect(settingsOf(instance).llm.context).toStrictEqual({
    otherLanguages: [],
    identicalStrings: true,
    fileContext: true,
    glossary: false,
  });
});

test("an upload stores a language's instructions and plural override", async () => {
  using instance = await startTestService();
  const result = await upload(instance, {
    languages: { de: { instructions: "Use du.", pluralOverride: { cardinal: ["other"] } } },
  });
  expect(result.settings).toStrictEqual([
    "languages.de.instructions",
    "languages.de.pluralOverride",
  ]);
  expect(germanRow(instance)).toStrictEqual({
    instructions: "Use du.",
    plural_override: '{"cardinal":["other"]}',
  });
});

test("settings for a language the project doesn't have are refused", async () => {
  using instance = await startTestService();
  await expect(
    upload(instance, { languages: { fr: { instructions: "Tutoie." } } }),
  ).rejects.toThrow("settings.languages names fr, which isn't a language of the project.");
});

test("an upload of some files can't change the settings", async () => {
  using instance = await startTestService();
  await expect(upload(instance, { name: "Quaso Quest" }, { partial: true })).rejects.toThrow(
    "An upload of some files can't change the settings.",
  );
});

test("an invalid setting is refused and nothing is saved", async () => {
  using instance = await startTestService();
  await expect(upload(instance, { llm: { promptTemplate: "No strings here" } })).rejects.toThrow();
  expect(instance.sql.query("SELECT 1 FROM files")).toStrictEqual([]);
});

test("the syntax the upload brings decides how its files are read", async () => {
  using instance = await startTestService();
  const result = await instance.service.upload(SYSTEM, {
    files: [
      { ...jsonFile("common.json", { greeting: "Hi, {name}!" }), repoPath: "src/en/common.json" },
    ],
    settings: {
      syntax: { prefix: "{{", suffix: "}}", icu: true },
    },
  });
  expect(result.settings).toStrictEqual(["syntax.icu"]);
  expect(settingsOf(instance).syntax.icu).toBe(true);
});

test("a dry run reports the settings that would change and saves nothing", async () => {
  using instance = await startTestService();
  await upload(instance, undefined);
  const before = getRevision(instance.sql);
  const result = await upload(instance, { name: "Quaso Quest" }, { dryRun: true });
  expect(result.settings).toStrictEqual(["name"]);
  expect(settingsOf(instance).name).toBe("Untitled project");
  expect(getRevision(instance.sql)).toBe(before);
});

test("an upload that only changes settings is recorded", async () => {
  using instance = await startTestService();
  await upload(instance, undefined);
  await upload(instance, { name: "Quaso Quest", description: "A game about pastry." });
  const [activity] = instance.sql.query<{ summary: string }>(
    "SELECT summary FROM activity ORDER BY id DESC LIMIT 1",
  );
  expect(activity.summary).toBe("Upload: 2 settings updated");
});

test("a context file that replaces a website edit says so", async () => {
  using instance = await startTestService();
  await upload(instance, undefined);
  await instance.service.updateFile(SYSTEM, { id: 1, context: "Written here" });
  const result = await instance.service.upload(SYSTEM, {
    files: [
      { ...jsonFile("common.json", COMMON), repoPath: "src/en/common.json", context: "From file" },
    ],
    folderContexts: [],
  });
  expect(result.contexts).toStrictEqual([
    { target: "file", path: "common.json", change: "set", overwritesEdit: true },
  ]);
});
