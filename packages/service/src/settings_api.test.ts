// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { hasPluralRules, PROMPT_PLACEHOLDERS } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { getRevision } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { drain } from "./jobs/testing.ts";
import { MODELS_FAILURE_TTL_MS } from "./jobs/models.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { DEFAULT_PROMPT_TEMPLATE, defaultSettings } from "./settings.ts";
import { mergeSettings } from "./settings_api.ts";
import {
  addUser,
  count,
  createToken,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  menu: { play: "Play", quit: "Quit" },
  greeting: "Hello, {{name}}!",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
};

async function project(): Promise<TestInstance & { admin: Actor }> {
  const instance = await startTestService();
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["de", "pl"] });
  return Object.assign(instance, { admin: addUser(instance.sql, "administrator") });
}

async function rejects(promise: Promise<unknown>, code: string, text?: string) {
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code, error.message).toStrictEqual(code);
  if (text !== undefined) expect(error.message).toContain(text);
  return error;
}

test("getSettings: the settings, the default template, languages, files and models", async () => {
  using instance = await project();
  const result = await instance.service.getSettings(instance.admin, {});
  expect(result.settings.name).toBe("Untitled project");
  expect(result.defaultPromptTemplate).toStrictEqual(DEFAULT_PROMPT_TEMPLATE);
  expect(result.languages.map((language) => language.tag)).toStrictEqual(["de", "pl"]);
  const pl = result.languages[1];
  expect(pl.name).toBe("Polish");
  expect(pl.direction).toBe("ltr");
  expect(pl.pluralOverride).toBe(null);
  expect(pl.categories.cardinal).toStrictEqual(["one", "few", "many", "other"]);
  expect(pl.categories.ordinal).toStrictEqual(["other"]);
  expect(result.files).toStrictEqual([
    { id: 1, path: "common.json", context: "", generatedContext: null },
  ]);
  expect(result.models).toStrictEqual([]);
  expect(result.llmAvailable).toBe(false);
});

test("only administrators see and change the settings; managers may write file context", async () => {
  using instance = await project();
  const manager = addUser(instance.sql, "manager");
  const contributor = addUser(instance.sql, "contributor");
  const key = await createToken(instance.service, "upload");
  const { service } = instance;
  await rejects(service.getSettings(ANONYMOUS, {}), "unauthorized");
  for (const actor of [manager, contributor, key.actor]) {
    await rejects(service.getSettings(actor, {}), "forbidden");
    await rejects(service.updateSettings(actor, { name: "X" }), "forbidden");
    await rejects(service.addLanguage(actor, { tag: "fr" }), "forbidden");
    await rejects(service.updateLanguage(actor, { tag: "de", instructions: "x" }), "forbidden");
    await rejects(service.removeLanguage(actor, { tag: "de" }), "forbidden");
    await rejects(service.updateString(actor, { id: 1, description: "x" }), "forbidden");
    await rejects(
      service.renameKey(actor, { file: "common.json", from: "a", to: "b" }),
      "forbidden",
    );
    await rejects(service.getAdminInfo(actor, {}), "forbidden");
    await rejects(service.backupInfo(actor, {}), "forbidden");
  }
  const file = await service.updateFile(manager, { id: 1, context: "The main menu." });
  expect(file.context).toBe("The main menu.");
  await rejects(service.updateFile(contributor, { id: 1, context: "x" }), "forbidden");
  await rejects(service.updateFile(key.actor, { id: 1, context: "x" }), "forbidden");
  await rejects(service.updateFile(ANONYMOUS, { id: 1, context: "x" }), "unauthorized");
});

test("mergeSettings: top-level fields replace; llm and llm.context merge one level deep", () => {
  const current = defaultSettings("m");
  const merged = mergeSettings(current, {
    name: "Wayfarer",
    links: [{ label: "Site", url: "https://example.com" }],
    llm: { model: "gemini-pro", context: { glossary: false } },
  });
  expect(merged.name).toBe("Wayfarer");
  expect(merged.links).toStrictEqual([{ label: "Site", url: "https://example.com" }]);
  expect(merged.llm.model).toBe("gemini-pro");
  expect(merged.llm.batchSize).toStrictEqual(current.llm.batchSize);
  expect(merged.llm.context).toStrictEqual({ ...current.llm.context, glossary: false });
  expect(current.llm.context.glossary, "the current settings are unchanged").toBe(true);
});

test("updateSettings stores the merged settings; the Activity page doesn't list it", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const result = await instance.service.updateSettings(instance.admin, {
    name: "Wayfarer",
    description: "A game",
    llm: { autoTranslate: false, context: { otherLanguages: ["pt-br"] } },
  });
  expect(result.settings.name).toBe("Wayfarer");
  expect(result.settings.llm.autoTranslate).toBe(false);
  expect(result.settings.llm.updateOutdated).toBe(true);
  expect(result.settings.llm.context.otherLanguages).toStrictEqual(["pt-BR"]);
  expect(result.settings.llm.context.identicalStrings).toBe(true);
  expect(getRevision(instance.sql)).toStrictEqual(revision + 1);
  const info = await instance.service.getProject(ANONYMOUS, {});
  expect(info.name).toBe("Wayfarer");
  // The Activity page shows uploads, jobs, reviews, imports and renames (design §6), in
  // the types the API knows: settings changes go to the log.
  const activity = (await instance.service.getActivity(ANONYMOUS, {})).items;
  expect(activity.map((item) => item.type)).toStrictEqual(["upload"]);

  // The same values again: nothing changes.
  await instance.service.updateSettings(instance.admin, { name: "Wayfarer" });
  expect(getRevision(instance.sql)).toStrictEqual(revision + 1);
});

test("updateSettings validates the result", async () => {
  using instance = await project();
  await rejects(instance.service.updateSettings(instance.admin, { name: "" }), "validation_failed");
  await rejects(
    instance.service.updateSettings(instance.admin, { llm: { batchSize: 0 } }),
    "validation_failed",
  );
  await rejects(
    instance.service.updateSettings(instance.admin, { unknown: 1 } as never),
    "validation_failed",
  );
});

test("the prompt template must send %strings% and use known placeholders", async () => {
  using instance = await project();
  const { service, admin } = instance;
  await rejects(
    service.updateSettings(admin, { llm: { promptTemplate: "Translate into %targetLanguage%." } }),
    "bad_request",
    "%strings%",
  );
  const error = await rejects(
    service.updateSettings(admin, {
      llm: { promptTemplate: "Translate %strings% for %gameName% and %foo%, 100% sure." },
    }),
    "bad_request",
    "unknown placeholders: %gameName%, %foo%",
  );
  expect(error.message).toContain(PROMPT_PLACEHOLDERS.join(", "));
  const ok = await service.updateSettings(admin, {
    llm: { promptTemplate: "Into %targetLanguage%, 100% of: %strings%" },
  });
  expect(ok.settings.llm.promptTemplate).toBe("Into %targetLanguage%, 100% of: %strings%");
  // Notes (%% lines) are never sent: %strings% there doesn't count, other names don't matter.
  await rejects(
    service.updateSettings(admin, { llm: { promptTemplate: "%% then %strings%\nTranslate." } }),
    "bad_request",
    "%strings%",
  );
  await rejects(
    service.updateSettings(admin, { llm: { model: "../v1/files" } }),
    "bad_request",
    "Not a model name",
  );
  const noted = "%% %myNote% is only for us\n%strings%";
  const withNote = await service.updateSettings(admin, { llm: { promptTemplate: noted } });
  expect(withNote.settings.llm.promptTemplate).toStrictEqual(noted);
});

test("the model for suggestions is a model name, or blank to follow the project's", async () => {
  using instance = await project();
  const { service, admin } = instance;
  expect((await service.getSettings(admin, {})).settings.llm.suggestionModel).toBe("");
  await rejects(
    service.updateSettings(admin, { llm: { suggestionModel: "../v1/files" } }),
    "bad_request",
    "Not a model name",
  );
  const named = await service.updateSettings(admin, {
    llm: { suggestionModel: "gemini-3.6-flash" },
  });
  expect(named.settings.llm.suggestionModel).toBe("gemini-3.6-flash");
  const blank = await service.updateSettings(admin, { llm: { suggestionModel: "" } });
  expect(blank.settings.llm.suggestionModel).toBe("");
});

test("the source language can't change once there are strings", async () => {
  using instance = await project();
  await rejects(
    instance.service.updateSettings(instance.admin, { sourceLanguage: "fr" }),
    "bad_request",
    "can't change once the project has strings",
  );
  using empty = await startTestService();
  const admin = addUser(empty.sql, "administrator");
  await empty.service.addLanguage(admin, { tag: "de" });
  const result = await empty.service.updateSettings(admin, { sourceLanguage: "de" });
  expect(result.settings.sourceLanguage).toBe("de");
  expect(result.languages, "the new source language is no longer a target").toStrictEqual([]);
});

test("a new placeholder syntax runs the checks again on every translation", async () => {
  using instance = await project();
  write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!");
  const qa = () =>
    instance.sql.query<{ qa_errors: number }>("SELECT qa_errors FROM translations")[0].qa_errors;
  // A German text without the placeholder, stored as it could be from before the change.
  instance.sql.run("UPDATE translations SET value = ?", JSON.stringify("Hallo!"));
  await instance.service.updateSettings(instance.admin, { syntax: { prefix: "%", suffix: "%" } });
  expect(qa(), "with %…%, {{name}} is plain text, so nothing is missing").toBe(0);
  await instance.service.updateSettings(instance.admin, { syntax: { prefix: "{{", suffix: "}}" } });
  expect(qa(), "with {{…}}, {{name}} is missing").toBe(1);
});

test("extra placeholder delimiters are saved and check the app's own placeholders", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    { "jobs.json": { hiring: "{company} is hiring" } },
    { languages: ["de"] },
  );
  const admin = addUser(instance.sql, "administrator");
  write(instance, "jobs.json", "hiring", "de", "{Firma} stellt ein");
  const qa = () =>
    instance.sql.query<{ qa_errors: number }>("SELECT qa_errors FROM translations")[0].qa_errors;
  expect(qa(), "without extra delimiters, {company} is plain text").toBe(0);
  const syntax = { prefix: "{{", suffix: "}}", extra: [{ prefix: "{", suffix: "}" }] };
  const result = await instance.service.updateSettings(admin, { syntax });
  expect(result.settings.syntax).toStrictEqual({ ...syntax, optional: [], icu: false });
  expect(qa(), "{company} is missing and {Firma} isn't in the English").toBe(2);
});

test("models come from the provider, kept for ten minutes", async () => {
  let calls = 0;
  const provider = {
    name: "gemini",
    listModels: () => {
      calls++;
      return Promise.resolve(["gemini-pro", "gemini-flash"]);
    },
  };
  using instance = await startTestService({ provider } as never);
  const admin = addUser(instance.sql, "administrator");
  const first = await instance.service.getSettings(admin, {});
  expect(first.models).toStrictEqual(["gemini-flash", "gemini-pro"]);
  expect(first.llmAvailable).toBe(true);
  await instance.service.getSettings(admin, {});
  expect(calls).toBe(1);
  instance.clock.advance(10 * 60_000);
  await instance.service.getSettings(admin, {});
  expect(calls).toBe(2);
  expect((await instance.service.getAdminInfo(admin, {})).llm.provider).toBe("gemini");
});

test("a provider that can't list its models gives none, and is asked again a minute later", async () => {
  let calls = 0;
  const provider = {
    name: "gemini",
    listModels: () => {
      calls++;
      return Promise.reject(new Error("offline"));
    },
  };
  using instance = await startTestService({ provider } as never);
  const admin = addUser(instance.sql, "administrator");
  expect((await instance.service.getSettings(admin, {})).models).toStrictEqual([]);
  expect((await instance.service.updateSettings(admin, { name: "Game" })).models).toStrictEqual([]);
  expect((await instance.service.listModels(admin, {})).models).toStrictEqual([]);
  expect(calls, "the failure is kept: callers don't each wait for the provider").toBe(1);
  instance.clock.advance(MODELS_FAILURE_TTL_MS);
  await instance.service.getSettings(admin, {});
  expect(calls).toBe(2);
});

test("settings never wait for a provider that doesn't answer", async () => {
  // Unreachable (packets dropped): Gemini's requests would retry for minutes.
  let calls = 0;
  const provider = { name: "gemini", listModels: () => (calls++, new Promise<string[]>(() => {})) };
  using instance = await startTestService({ provider } as never);
  const admin = addUser(instance.sql, "administrator");
  const started = performance.now();
  const saved = instance.service.updateSettings(admin, { name: "New name" });
  // Stored before the provider is even asked.
  await Promise.resolve();
  expect((await instance.service.getProject(ANONYMOUS, {})).name).toBe("New name");
  expect((await saved).settings.name).toBe("New name");
  expect((await saved).models).toStrictEqual([]);
  assert(performance.now() - started < 5000);
  // The request it gave up on isn't waited for again.
  const again = performance.now();
  expect((await instance.service.getSettings(admin, {})).models).toStrictEqual([]);
  expect((await instance.service.updateSettings(admin, { name: "Other" })).settings.name).toBe(
    "Other",
  );
  assert(performance.now() - again < 500, "no second wait");
  expect(calls).toBe(1);
});

test("addLanguage: canonical tags; never the source language; conflict when it exists", async () => {
  using instance = await project();
  const { service, admin } = instance;
  const added = await service.addLanguage(admin, { tag: "pt-br" });
  expect(added.language.tag).toBe("pt-BR");
  expect(added.language.name).toBe("Portuguese (Brazil)");
  expect(added.warnings).toStrictEqual([]);
  await rejects(service.addLanguage(admin, { tag: "pt-BR" }), "conflict");
  await rejects(service.addLanguage(admin, { tag: "en" }), "bad_request", "source language");
  const status = await service.getStatus(SYSTEM, {});
  expect(status.languages.map((language) => language.tag)).toStrictEqual(["de", "pl", "pt-BR"]);
  await service.removeLanguage(admin, { tag: "pl" });
  await service.updateLanguage(admin, { tag: "de", instructions: "Formal." });
  const types = (await service.getActivity(ANONYMOUS, {})).items.map((item) => item.type);
  expect(types, "only the types the API knows").toStrictEqual(["upload"]);
});

test("addLanguage warns when the runtime has no plural rules for the language", async () => {
  using instance = await project();
  const tag = ["cv", "kok", "sgs", "ie"].find((candidate) => !hasPluralRules(candidate));
  if (tag === undefined) return; // This runtime knows them all.
  const added = await instance.service.addLanguage(instance.admin, { tag });
  expect(added.warnings.length).toBe(1);
  expect(added.warnings[0]).toContain("plural override");
});

test("removeLanguage keeps translations and history; they come back with the language", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "title", "de", "Wanderer");
  const id = stringId(instance.sql, "common.json", "title");
  await service.removeLanguage(admin, { tag: "de" });
  const info = await service.getProject(ANONYMOUS, {});
  expect(info.languages.map((language) => language.tag)).toStrictEqual(["pl"]);
  const exported = await service.exportFiles(SYSTEM, {});
  expect(new Set(exported.files.map((file) => file.language))).toStrictEqual(new Set(["pl"]));
  await rejects(service.listStrings(ANONYMOUS, { language: "de" }), "not_found");
  await rejects(service.removeLanguage(admin, { tag: "de" }), "not_found");
  expect(count(instance.sql, "translations", "language = 'de'")).toBe(1);

  await service.addLanguage(admin, { tag: "de" });
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  expect(detail.translation?.value).toBe("Wanderer");
  const history = await service.getHistory(ANONYMOUS, { id, language: "de" });
  expect(history.entries.map((entry) => entry.event)).toStrictEqual([
    "translation_llm",
    "source_added",
  ]);
  const again = await service.exportFiles(SYSTEM, { languages: ["de"] });
  expect(again.files[0].content).toContain("Wanderer");
});

test("a removed language's pending suggestions leave the review queue, and come back with it", async () => {
  using instance = await project();
  const { service, admin } = instance;
  const contributor = addUser(instance.sql, "contributor");
  const id = stringId(instance.sql, "common.json", "title");
  await service.suggest(contributor, {
    id,
    language: "de",
    kind: "translation",
    value: "Wanderer",
    baseRevision: 0,
  });
  expect((await service.listSuggestions(admin, {})).total).toBe(1);
  await service.removeLanguage(admin, { tag: "de" });
  const queue = await service.listSuggestions(admin, {});
  expect([queue.total, queue.suggestions.length]).toStrictEqual([0, 0]);
  expect((await service.listSuggestions(contributor, {})).total).toBe(0);
  // Still there, and in the full list.
  expect((await service.listSuggestions(admin, { status: "all" })).total).toBe(1);

  await service.addLanguage(admin, { tag: "de" });
  const back = await service.listSuggestions(admin, {});
  expect(back.total).toBe(1);
  const review = await service.reviewSuggestions(admin, {
    ids: back.suggestions.map((suggestion) => suggestion.id),
    action: "approve",
  });
  expect(review.failed).toStrictEqual([]);
});

test("updateLanguage: instructions, and a plural override that must include other", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "coins#plural", "pl", {
    one: "{{count}} moneta",
    few: "{{count}} monety",
    many: "{{count}} monet",
    other: "{{count}} monety",
  });
  const qa = () =>
    instance.sql.query<{ qa_errors: number }>(
      "SELECT qa_errors FROM translations WHERE language = 'pl'",
    )[0].qa_errors;
  expect(qa()).toBe(0);
  const updated = await service.updateLanguage(admin, {
    tag: "PL",
    instructions: "Informal.",
    pluralOverride: { cardinal: ["one", "other"] },
  });
  expect(updated.instructions).toBe("Informal.");
  expect(updated.pluralOverride).toStrictEqual({ cardinal: ["one", "other"] });
  expect(updated.categories.cardinal).toStrictEqual(["one", "other"]);
  assert(qa() > 0, "few and many are now extra forms");
  await rejects(
    service.updateLanguage(admin, { tag: "pl", pluralOverride: { cardinal: ["one"] } }),
    "bad_request",
    "must include other",
  );
  const cleared = await service.updateLanguage(admin, { tag: "pl", pluralOverride: null });
  expect(cleared.pluralOverride).toBe(null);
  expect(cleared.categories.cardinal).toStrictEqual(["one", "few", "many", "other"]);
  expect(qa()).toBe(0);
  await rejects(service.updateLanguage(admin, { tag: "fr", instructions: "" }), "not_found");
});

test("updateFile writes the context and clears nothing else", async () => {
  using instance = await project();
  instance.sql.run("UPDATE files SET generated_context = 'Generated.'");
  const file = await instance.service.updateFile(instance.admin, { id: 1, context: "Menus." });
  expect(file).toStrictEqual({
    id: 1,
    path: "common.json",
    context: "Menus.",
    generatedContext: "Generated.",
  });
  await rejects(instance.service.updateFile(instance.admin, { id: 99, context: "x" }), "not_found");
});

test("updateString: description and limit; a limit from the CLI config is locked", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "title", "de", "Wandersmann");
  const id = stringId(instance.sql, "common.json", "title");
  const result = await service.updateString(admin, {
    id,
    description: "The game's title",
    maxLength: 8,
  });
  expect(result).toStrictEqual({
    id,
    description: "The game's title",
    maxLength: 8,
    maxLengthLocked: false,
  });
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  expect(detail.description).toBe("The game's title");
  expect(detail.translation?.qa.errors, "11 characters over a limit of 8").toBe(1);
  const cleared = await service.updateString(admin, { id, maxLength: null });
  expect(cleared.maxLength).toBe(null);
  expect((await service.getString(ANONYMOUS, { id, language: "de" })).translation?.qa.errors).toBe(
    0,
  );

  await uploadJson(
    service,
    { "common.json": COMMON },
    {
      limits: [{ file: "common.json", key: "menu.play", maxLength: 10 }],
    },
  );
  const play = stringId(instance.sql, "common.json", "menu.play");
  await rejects(
    service.updateString(admin, { id: play, maxLength: 20 }),
    "bad_request",
    "set by the CLI config",
  );
  const same = await service.updateString(admin, { id: play, maxLength: 10, description: "Menu" });
  expect(same).toStrictEqual({
    id: play,
    description: "Menu",
    maxLength: 10,
    maxLengthLocked: true,
  });
  await rejects(service.updateString(admin, { id: 999, description: "x" }), "not_found");
});

test("a website rename after the upload's LLM job: the old key's translations replace the LLM's, never a person's", async () => {
  using instance = await startTestService({ provider: createFakeTranslator() });
  const { service } = instance;
  const admin = addUser(instance.sql, "administrator");
  await uploadJson(
    service,
    { "common.json": { menu: { play: "Play", quit: "Quit" } } },
    {
      languages: ["de"],
    },
  );
  await drain(instance);
  const person = { type: "user" as const, id: 1, label: null };
  for (const [key, value] of [
    ["menu.play", "Spielen"],
    ["menu.quit", "Beenden"],
  ]) {
    write(instance, "common.json", key, "de", value, {
      colour: "blue",
      actor: person,
      event: "translation_saved",
    });
  }
  // The game renames both keys; the CI uploads without --rename (automatic translation on).
  const upload = await uploadJson(service, {
    "common.json": { menu: { start: "Play", exit: "Quit" } },
  });
  expect(upload.renameSuggestions.map((rename) => rename.to)).toStrictEqual([
    "menu.start",
    "menu.exit",
  ]);
  assert(upload.job !== null);
  await drain(instance);
  const start = stringId(instance.sql, "common.json", "menu.start");
  const exit = stringId(instance.sql, "common.json", "menu.exit");
  for (const id of [start, exit]) {
    const { translation } = await service.getString(ANONYMOUS, { id, language: "de" });
    expect(translation?.colour, "the job translated the new keys first").toBe("green");
  }
  // Someone corrected the LLM's text of menu.exit meanwhile: that one stays.
  write(instance, "common.json", "menu.exit", "de", "Verlassen", {
    colour: "green",
    actor: person,
    event: "translation_saved",
  });
  const refused = await rejects(
    service.renameKey(admin, upload.renameSuggestions[1]),
    "bad_request",
    "a person made or reviewed (de)",
  );
  expect(refused.details?.[0].language).toBe("de");
  expect(
    (await service.getString(ANONYMOUS, { id: exit, language: "de" })).translation?.value,
  ).toBe("Verlassen");

  const result = await service.renameKey(admin, upload.renameSuggestions[0]);
  expect(result.renamed).toStrictEqual([
    { file: "common.json", from: "menu.play", to: "menu.start" },
  ]);
  const { translation } = await service.getString(ANONYMOUS, { id: start, language: "de" });
  expect([translation?.value, translation?.colour]).toStrictEqual(["Spielen", "blue"]);
  const history = await service.getHistory(ANONYMOUS, { id: start, language: "de" });
  const replaced = history.entries.find((entry) => entry.event === "translation_deleted");
  expect(replaced?.actor.type).toBe("user");
  expect(replaced?.afterColour).toBe(null);
  expect(replaced?.detail?.reason).toBe("rename");
  assert(
    history.entries.some((entry) => entry.event === "translation_saved"),
    "the old history",
  );
  expect(count(instance.sql, "translations", `string_id = ${start}`)).toBe(1);
});

test("upload --rename after the LLM translated the new key: the old key's translation wins too", async () => {
  using instance = await startTestService();
  const { service } = instance;
  await uploadJson(service, { "a.json": { play: "Play" } }, { languages: ["de", "fr"] });
  write(instance, "a.json", "play", "de", "Spielen", {
    colour: "blue",
    actor: { type: "user", id: 1, label: null },
    event: "translation_saved",
  });
  await uploadJson(service, { "a.json": { start: "Play" } });
  // The upload's job translated the new key (fr: the old key has none, so it stays).
  write(instance, "a.json", "start", "de", "Starten");
  write(instance, "a.json", "start", "fr", "Jouer");
  const upload = await uploadJson(
    service,
    { "a.json": { start: "Play" } },
    {
      renames: [{ from: "play", to: "start" }],
    },
  );
  expect(upload.renamed).toStrictEqual([{ file: "a.json", from: "play", to: "start" }]);
  const id = stringId(instance.sql, "a.json", "start");
  const values = instance.sql.query<{ language: string; value: string; colour: string }>(
    "SELECT language, value, colour FROM translations WHERE string_id = ? ORDER BY language",
    id,
  );
  expect(values.map((row) => ({ ...row }))).toStrictEqual([
    { language: "de", value: '"Spielen"', colour: "blue" },
    { language: "fr", value: '"Jouer"', colour: "green" },
  ]);
});

test("renameKey moves translations and history, as upload --rename does (S10.1)", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const renamedEnglish = { ...COMMON, menu: { start: "Play", quit: "Quit" } };
  const upload = await uploadJson(service, { "common.json": renamedEnglish });
  expect(upload.renameSuggestions).toStrictEqual([
    { file: "common.json", from: "menu.play", to: "menu.start" },
  ]);
  const revision = getRevision(instance.sql);
  const result = await service.renameKey(admin, upload.renameSuggestions[0]);
  expect(result).toStrictEqual({
    renamed: [{ file: "common.json", from: "menu.play", to: "menu.start" }],
    revision: revision + 1,
  });
  const id = stringId(instance.sql, "common.json", "menu.start");
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  expect(detail.translation?.value).toBe("Spielen");
  const history = await service.getHistory(ANONYMOUS, { id });
  expect(history.entries[0].event).toBe("source_renamed");
  expect(history.entries[0].actor.type).toBe("user");
  expect(
    history.entries.map((entry) => entry.event).includes("translation_llm"),
    "the old key's history follows",
  ).toBe(true);
  const [item] = (await service.getActivity(ANONYMOUS, {})).items;
  expect(item.type).toBe("rename");
  expect(item.summary).toBe("Renamed menu.play to menu.start in common.json");

  // Again: already made, nothing changes.
  const again = await service.renameKey(admin, upload.renameSuggestions[0]);
  expect(again).toStrictEqual({ renamed: [], revision: revision + 1 });

  await rejects(
    service.renameKey(admin, { file: "common.json", from: "menu.quit", to: "menu.start" }),
    "bad_request",
    "the English still has it",
  );
  await rejects(
    service.renameKey(admin, { file: "common.json", from: "nope", to: "menu.start" }),
    "bad_request",
    "there is no key nope",
  );
});
