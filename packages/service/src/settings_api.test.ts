// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code, error.message);
  if (text !== undefined) assertStringIncludes(error.message, text);
  return error;
}

test("getSettings: the settings, the default template, languages, files and models", async () => {
  using instance = await project();
  const result = await instance.service.getSettings(instance.admin, {});
  assertEquals(result.settings.name, "Untitled project");
  assertEquals(result.defaultPromptTemplate, DEFAULT_PROMPT_TEMPLATE);
  assertEquals(
    result.languages.map((language) => language.tag),
    ["de", "pl"],
  );
  const pl = result.languages[1];
  assertEquals(pl.name, "Polish");
  assertEquals(pl.direction, "ltr");
  assertEquals(pl.pluralOverride, null);
  assertEquals(pl.categories.cardinal, ["one", "few", "many", "other"]);
  assertEquals(pl.categories.ordinal, ["other"]);
  assertEquals(result.files, [{ id: 1, path: "common.json", context: "", generatedContext: null }]);
  assertEquals(result.models, []);
  assertEquals(result.llmAvailable, false);
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
  assertEquals(file.context, "The main menu.");
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
  assertEquals(merged.name, "Wayfarer");
  assertEquals(merged.links, [{ label: "Site", url: "https://example.com" }]);
  assertEquals(merged.llm.model, "gemini-pro");
  assertEquals(merged.llm.batchSize, current.llm.batchSize);
  assertEquals(merged.llm.context, { ...current.llm.context, glossary: false });
  assertEquals(current.llm.context.glossary, true, "the current settings are unchanged");
});

test("updateSettings stores the merged settings; the Activity page doesn't list it", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const result = await instance.service.updateSettings(instance.admin, {
    name: "Wayfarer",
    description: "A game",
    llm: { autoTranslate: false, context: { otherLanguages: ["pt-br"] } },
  });
  assertEquals(result.settings.name, "Wayfarer");
  assertEquals(result.settings.llm.autoTranslate, false);
  assertEquals(result.settings.llm.updateOutdated, true);
  assertEquals(result.settings.llm.context.otherLanguages, ["pt-BR"]);
  assertEquals(result.settings.llm.context.identicalStrings, true);
  assertEquals(getRevision(instance.sql), revision + 1);
  const info = await instance.service.getProject(ANONYMOUS, {});
  assertEquals(info.name, "Wayfarer");
  // The Activity page shows uploads, jobs, reviews, imports and renames (design §6), in
  // the types the API knows: settings changes go to the log.
  const activity = (await instance.service.getActivity(ANONYMOUS, {})).items;
  assertEquals(
    activity.map((item) => item.type),
    ["upload"],
  );

  // The same values again: nothing changes.
  await instance.service.updateSettings(instance.admin, { name: "Wayfarer" });
  assertEquals(getRevision(instance.sql), revision + 1);
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
  assertStringIncludes(error.message, PROMPT_PLACEHOLDERS.join(", "));
  const ok = await service.updateSettings(admin, {
    llm: { promptTemplate: "Into %targetLanguage%, 100% of: %strings%" },
  });
  assertEquals(ok.settings.llm.promptTemplate, "Into %targetLanguage%, 100% of: %strings%");
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
  assertEquals(withNote.settings.llm.promptTemplate, noted);
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
  assertEquals(result.settings.sourceLanguage, "de");
  assertEquals(result.languages, [], "the new source language is no longer a target");
});

test("a new placeholder syntax runs the checks again on every translation", async () => {
  using instance = await project();
  write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!");
  const qa = () =>
    instance.sql.query<{ qa_errors: number }>("SELECT qa_errors FROM translations")[0].qa_errors;
  // A German text without the placeholder, stored as it could be from before the change.
  instance.sql.run("UPDATE translations SET value = ?", JSON.stringify("Hallo!"));
  await instance.service.updateSettings(instance.admin, { syntax: { prefix: "%", suffix: "%" } });
  assertEquals(qa(), 0, "with %…%, {{name}} is plain text, so nothing is missing");
  await instance.service.updateSettings(instance.admin, { syntax: { prefix: "{{", suffix: "}}" } });
  assertEquals(qa(), 1, "with {{…}}, {{name}} is missing");
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
  assertEquals(first.models, ["gemini-flash", "gemini-pro"]);
  assertEquals(first.llmAvailable, true);
  await instance.service.getSettings(admin, {});
  assertEquals(calls, 1);
  instance.clock.advance(10 * 60_000);
  await instance.service.getSettings(admin, {});
  assertEquals(calls, 2);
  assertEquals((await instance.service.getAdminInfo(admin, {})).llm.provider, "gemini");
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
  assertEquals((await instance.service.getSettings(admin, {})).models, []);
  assertEquals((await instance.service.updateSettings(admin, { name: "Game" })).models, []);
  assertEquals((await instance.service.listModels(admin, {})).models, []);
  assertEquals(calls, 1, "the failure is kept: callers don't each wait for the provider");
  instance.clock.advance(MODELS_FAILURE_TTL_MS);
  await instance.service.getSettings(admin, {});
  assertEquals(calls, 2);
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
  assertEquals((await instance.service.getProject(ANONYMOUS, {})).name, "New name");
  assertEquals((await saved).settings.name, "New name");
  assertEquals((await saved).models, []);
  assert(performance.now() - started < 5000);
  // The request it gave up on isn't waited for again.
  const again = performance.now();
  assertEquals((await instance.service.getSettings(admin, {})).models, []);
  assertEquals(
    (await instance.service.updateSettings(admin, { name: "Other" })).settings.name,
    "Other",
  );
  assert(performance.now() - again < 500, "no second wait");
  assertEquals(calls, 1);
});

test("addLanguage: canonical tags; never the source language; conflict when it exists", async () => {
  using instance = await project();
  const { service, admin } = instance;
  const added = await service.addLanguage(admin, { tag: "pt-br" });
  assertEquals(added.language.tag, "pt-BR");
  assertEquals(added.language.name, "Portuguese (Brazil)");
  assertEquals(added.warnings, []);
  await rejects(service.addLanguage(admin, { tag: "pt-BR" }), "conflict");
  await rejects(service.addLanguage(admin, { tag: "en" }), "bad_request", "source language");
  const status = await service.getStatus(SYSTEM, {});
  assertEquals(
    status.languages.map((language) => language.tag),
    ["de", "pl", "pt-BR"],
  );
  await service.removeLanguage(admin, { tag: "pl" });
  await service.updateLanguage(admin, { tag: "de", instructions: "Formal." });
  const types = (await service.getActivity(ANONYMOUS, {})).items.map((item) => item.type);
  assertEquals(types, ["upload"], "only the types the API knows");
});

test("addLanguage warns when the runtime has no plural rules for the language", async () => {
  using instance = await project();
  const tag = ["cv", "kok", "sgs", "ie"].find((candidate) => !hasPluralRules(candidate));
  if (tag === undefined) return; // This runtime knows them all.
  const added = await instance.service.addLanguage(instance.admin, { tag });
  assertEquals(added.warnings.length, 1);
  assertStringIncludes(added.warnings[0], "plural override");
});

test("removeLanguage keeps translations and history; they come back with the language", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "title", "de", "Wanderer");
  const id = stringId(instance.sql, "common.json", "title");
  await service.removeLanguage(admin, { tag: "de" });
  const info = await service.getProject(ANONYMOUS, {});
  assertEquals(
    info.languages.map((language) => language.tag),
    ["pl"],
  );
  const exported = await service.exportFiles(SYSTEM, {});
  assertEquals(new Set(exported.files.map((file) => file.language)), new Set(["pl"]));
  await rejects(service.listStrings(ANONYMOUS, { language: "de" }), "not_found");
  await rejects(service.removeLanguage(admin, { tag: "de" }), "not_found");
  assertEquals(count(instance.sql, "translations", "language = 'de'"), 1);

  await service.addLanguage(admin, { tag: "de" });
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  assertEquals(detail.translation?.value, "Wanderer");
  const history = await service.getHistory(ANONYMOUS, { id, language: "de" });
  assertEquals(
    history.entries.map((entry) => entry.event),
    ["translation_llm", "source_added"],
  );
  const again = await service.exportFiles(SYSTEM, { languages: ["de"] });
  assertStringIncludes(again.files[0].content, "Wanderer");
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
  assertEquals((await service.listSuggestions(admin, {})).total, 1);
  await service.removeLanguage(admin, { tag: "de" });
  const queue = await service.listSuggestions(admin, {});
  assertEquals([queue.total, queue.suggestions.length], [0, 0]);
  assertEquals((await service.listSuggestions(contributor, {})).total, 0);
  // Still there, and in the full list.
  assertEquals((await service.listSuggestions(admin, { status: "all" })).total, 1);

  await service.addLanguage(admin, { tag: "de" });
  const back = await service.listSuggestions(admin, {});
  assertEquals(back.total, 1);
  const review = await service.reviewSuggestions(admin, {
    ids: back.suggestions.map((suggestion) => suggestion.id),
    action: "approve",
  });
  assertEquals(review.failed, []);
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
  assertEquals(qa(), 0);
  const updated = await service.updateLanguage(admin, {
    tag: "PL",
    instructions: "Informal.",
    pluralOverride: { cardinal: ["one", "other"] },
  });
  assertEquals(updated.instructions, "Informal.");
  assertEquals(updated.pluralOverride, { cardinal: ["one", "other"] });
  assertEquals(updated.categories.cardinal, ["one", "other"]);
  assert(qa() > 0, "few and many are now extra forms");
  await rejects(
    service.updateLanguage(admin, { tag: "pl", pluralOverride: { cardinal: ["one"] } }),
    "bad_request",
    "must include other",
  );
  const cleared = await service.updateLanguage(admin, { tag: "pl", pluralOverride: null });
  assertEquals(cleared.pluralOverride, null);
  assertEquals(cleared.categories.cardinal, ["one", "few", "many", "other"]);
  assertEquals(qa(), 0);
  await rejects(service.updateLanguage(admin, { tag: "fr", instructions: "" }), "not_found");
});

test("updateFile writes the context and clears nothing else", async () => {
  using instance = await project();
  instance.sql.run("UPDATE files SET generated_context = 'Generated.'");
  const file = await instance.service.updateFile(instance.admin, { id: 1, context: "Menus." });
  assertEquals(file, {
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
  assertEquals(result, {
    id,
    description: "The game's title",
    maxLength: 8,
    maxLengthLocked: false,
  });
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  assertEquals(detail.description, "The game's title");
  assertEquals(detail.translation?.qa.errors, 1, "11 characters over a limit of 8");
  const cleared = await service.updateString(admin, { id, maxLength: null });
  assertEquals(cleared.maxLength, null);
  assertEquals(
    (await service.getString(ANONYMOUS, { id, language: "de" })).translation?.qa.errors,
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
  assertEquals(same, { id: play, description: "Menu", maxLength: 10, maxLengthLocked: true });
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
  assertEquals(
    upload.renameSuggestions.map((rename) => rename.to),
    ["menu.start", "menu.exit"],
  );
  assert(upload.job !== null);
  await drain(instance);
  const start = stringId(instance.sql, "common.json", "menu.start");
  const exit = stringId(instance.sql, "common.json", "menu.exit");
  for (const id of [start, exit]) {
    const { translation } = await service.getString(ANONYMOUS, { id, language: "de" });
    assertEquals(translation?.colour, "green", "the job translated the new keys first");
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
  assertEquals(refused.details?.[0].language, "de");
  assertEquals(
    (await service.getString(ANONYMOUS, { id: exit, language: "de" })).translation?.value,
    "Verlassen",
  );

  const result = await service.renameKey(admin, upload.renameSuggestions[0]);
  assertEquals(result.renamed, [{ file: "common.json", from: "menu.play", to: "menu.start" }]);
  const { translation } = await service.getString(ANONYMOUS, { id: start, language: "de" });
  assertEquals([translation?.value, translation?.colour], ["Spielen", "blue"]);
  const history = await service.getHistory(ANONYMOUS, { id: start, language: "de" });
  const replaced = history.entries.find((entry) => entry.event === "translation_deleted");
  assertEquals(replaced?.actor.type, "user");
  assertEquals(replaced?.afterColour, null);
  assertEquals(replaced?.detail?.reason, "rename");
  assert(
    history.entries.some((entry) => entry.event === "translation_saved"),
    "the old history",
  );
  assertEquals(count(instance.sql, "translations", `string_id = ${start}`), 1);
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
  assertEquals(upload.renamed, [{ file: "a.json", from: "play", to: "start" }]);
  const id = stringId(instance.sql, "a.json", "start");
  const values = instance.sql.query<{ language: string; value: string; colour: string }>(
    "SELECT language, value, colour FROM translations WHERE string_id = ? ORDER BY language",
    id,
  );
  assertEquals(
    values.map((row) => ({ ...row })),
    [
      { language: "de", value: '"Spielen"', colour: "blue" },
      { language: "fr", value: '"Jouer"', colour: "green" },
    ],
  );
});

test("renameKey moves translations and history, as upload --rename does (S10.1)", async () => {
  using instance = await project();
  const { service, admin } = instance;
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const renamedEnglish = { ...COMMON, menu: { start: "Play", quit: "Quit" } };
  const upload = await uploadJson(service, { "common.json": renamedEnglish });
  assertEquals(upload.renameSuggestions, [
    { file: "common.json", from: "menu.play", to: "menu.start" },
  ]);
  const revision = getRevision(instance.sql);
  const result = await service.renameKey(admin, upload.renameSuggestions[0]);
  assertEquals(result, {
    renamed: [{ file: "common.json", from: "menu.play", to: "menu.start" }],
    revision: revision + 1,
  });
  const id = stringId(instance.sql, "common.json", "menu.start");
  const detail = await service.getString(ANONYMOUS, { id, language: "de" });
  assertEquals(detail.translation?.value, "Spielen");
  const history = await service.getHistory(ANONYMOUS, { id });
  assertEquals(history.entries[0].event, "source_renamed");
  assertEquals(history.entries[0].actor.type, "user");
  assertEquals(
    history.entries.map((entry) => entry.event).includes("translation_llm"),
    true,
    "the old key's history follows",
  );
  const [item] = (await service.getActivity(ANONYMOUS, {})).items;
  assertEquals(item.type, "rename");
  assertEquals(item.summary, "Renamed menu.play to menu.start in common.json");

  // Again: already made, nothing changes.
  const again = await service.renameKey(admin, upload.renameSuggestions[0]);
  assertEquals(again, { renamed: [], revision: revision + 1 });

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
