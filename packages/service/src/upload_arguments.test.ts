// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import type { ArgumentDeclaration } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import {
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const FEED = {
  posts: {
    joined: "Excited to join {company}!",
    hiring: "{name} says {authorGender, select, female {she} male {he} other {they}}'s hiring.",
  },
  menu: { title: "Your feed" },
};

const AUTHOR_GENDER: ArgumentDeclaration = {
  name: "authorGender",
  cases: ["female", "male"],
  description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
  files: ["feed.json"],
  keys: ["posts.*"],
};

const RECEIVED = JSON.stringify([
  {
    name: "authorGender",
    cases: ["female", "male"],
    description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
  },
]);

const UNIDA =
  "{authorGender, select, female {¡Emocionada de unirme a {company}!} male {¡Emocionado de unirme a {company}!} other {¡Qué ganas de empezar en {company}!}}";

/** A project with ICU MessageFormat on and Spanish. */
async function icuProject(): Promise<TestInstance> {
  const instance = await startTestService();
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, syntax: { ...settings.syntax, icu: true } });
  return instance;
}

function argumentsOf(instance: TestInstance, key: string) {
  return instance.sql.query<{ arguments: string | null }>(
    "SELECT arguments FROM strings WHERE display_key = ?",
    key,
  )[0].arguments;
}

test("an upload gives each string the declared arguments in its scope", async () => {
  using instance = await icuProject();
  await uploadJson(
    instance.service,
    { "feed.json": FEED },
    { languages: ["es"], arguments: [AUTHOR_GENDER] },
  );
  assertEquals(argumentsOf(instance, "posts.joined"), RECEIVED);
  assertEquals(argumentsOf(instance, "menu.title"), null);
});

test("without ICU MessageFormat, an upload keeps the arguments and says they don't apply", async () => {
  using instance = await startTestService();
  const result = await uploadJson(
    instance.service,
    { "feed.json": FEED },
    { languages: ["es"], arguments: [AUTHOR_GENDER] },
  );
  assertEquals(result.warnings, [
    "The config declares arguments, which only apply with ICU MessageFormat on (Settings → Placeholders); the strings keep them for when it is",
  ]);
  assertEquals(argumentsOf(instance, "posts.joined"), RECEIVED);
});

test("an argument that applies to no string is a warning", async () => {
  using instance = await icuProject();
  const result = await uploadJson(
    instance.service,
    { "feed.json": FEED },
    { languages: ["es"], arguments: [{ ...AUTHOR_GENDER, files: ["chat.json"] }] },
  );
  assertEquals(result.warnings, [
    "The argument authorGender applies to no string, so it does nothing: correct its files and keys, or remove it",
  ]);
});

test("a translation may vary by a declared argument; without the declaration it fails again", async () => {
  using instance = await icuProject();
  await uploadJson(
    instance.service,
    { "feed.json": FEED },
    { languages: ["es"], arguments: [AUTHOR_GENDER] },
  );
  write(instance, "feed.json", "posts.joined", "es", UNIDA);
  const qa = () => instance.sql.query("SELECT qa_errors FROM translations")[0].qa_errors;
  assertEquals(qa(), 0);
  await uploadJson(instance.service, { "feed.json": FEED });
  assertEquals(argumentsOf(instance, "posts.joined"), null);
  assertEquals(qa(), 2, "rechecked: {company} is missing, and the select isn't in the English");
});

test("an undeclared argument's select is refused on write", async () => {
  using instance = await icuProject();
  await uploadJson(instance.service, { "feed.json": FEED }, { languages: ["es"] });
  await assertRejects(
    async () => write(instance, "feed.json", "posts.joined", "es", UNIDA),
    ServiceError,
    "Placeholder {company} is missing.",
  );
});

test("the string's details list its arguments for the editor", async () => {
  using instance = await icuProject();
  await uploadJson(
    instance.service,
    { "feed.json": FEED },
    { languages: ["es"], arguments: [AUTHOR_GENDER] },
  );
  const id = stringId(instance.sql, "feed.json", "posts.joined");
  const detail = await instance.service.getString(SYSTEM, { id, language: "es" });
  assertEquals(detail.arguments, JSON.parse(RECEIVED));
});
