// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/**
 * The whole LLM flow with the fake translator (S5.8): uploads queue jobs, the alarm runs
 * them, and the results follow the state rules of design §5.4.
 */
import type { PluralForms } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { createFakeTranslator, FAKE_MODEL } from "../llm/fake.ts";
import { loadSettings, saveSettings } from "../settings.ts";
import {
  addUser,
  count,
  createToken,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "../test_helpers.ts";
import { drain, heldProvider } from "./testing.ts";

const COMMON = {
  title: "Wayfarer",
  greeting: "Welcome back, {{name}}!",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  again: "$t(title) again",
  version: 3,
};

/** The translatable strings of COMMON. */
const STRINGS = 4;

async function project(provider = createFakeTranslator()): Promise<TestInstance> {
  const instance = await startTestService({ provider });
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["de", "pl"] });
  return instance;
}

/** Every translation of a language, by key. */
async function translations(instance: TestInstance, language: string) {
  const page = await instance.service.listStrings(ANONYMOUS, { language });
  return Object.fromEntries(page.strings.map((string) => [string.key, string.translation]));
}

/** Writes a person's translation, blue. */
function writeBlue(instance: TestInstance, key: string, language: string, value: string) {
  return write(instance, "common.json", key, language, value, {
    colour: "blue",
    actor: { type: "system", id: null, label: "System" },
    event: "translation_saved",
  });
}

test("an upload with automatic translation makes every language green", async () => {
  using instance = await startTestService({ provider: createFakeTranslator() });
  const upload = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      languages: ["de", "pl"],
    },
  );
  assert(upload.job !== null, "the upload queued a job");
  expect(instance.scheduler.scheduled, "woken up at once").toStrictEqual([instance.clock.now]);
  expect(await drain(instance)).toBe(1);

  const polish = await translations(instance, "pl");
  expect(polish.title?.value).toBe("[Ŵáýƒáŕéŕ]");
  expect(polish.greeting?.value).toBe("[Ŵéļçöɱé ƀáçķ, {{name}}!]");
  expect(polish.coins?.value).toStrictEqual({
    one: "[{{count}} çöíñ]",
    few: "[{{count}} çöíñś]",
    many: "[{{count}} çöíñś]",
    other: "[{{count}} çöíñś]",
  });
  expect(polish.again?.value, "the reference comes back exactly").toStrictEqual(
    "[$t(title) áğáíñ]",
  );
  for (const language of ["de", "pl"]) {
    const all = Object.values(await translations(instance, language));
    expect(all.length).toStrictEqual(STRINGS);
    assert(all.every((t) => t?.colour === "green" && !t.outdated && t.qa.errors === 0));
    expect(all[0]?.author).toStrictEqual({ type: "llm", id: null, name: FAKE_MODEL });
  }
  const german = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  expect(JSON.parse(german.files[0].content).coins_other).toBe("[{{count}} çöíñś]");
  const polishFile = JSON.parse(
    (await instance.service.exportFiles(SYSTEM, { languages: ["pl"] })).files[0].content,
  );
  expect(Object.keys(polishFile).filter((key) => key.startsWith("coins_"))).toStrictEqual([
    "coins_one",
    "coins_few",
    "coins_many",
    "coins_other",
  ]);

  const job = await instance.service.getJob(SYSTEM, { id: upload.job.id });
  expect(job.status).toBe("done");
  expect(job.priority).toBe("upload");
  expect(job.progress).toStrictEqual({
    total: 2 * STRINGS,
    done: 2 * STRINGS,
    translated: 2 * STRINGS,
    proposed: 0,
    failed: 0,
    skipped: 0,
  });
  assert(job.tokens.input > 0 && job.tokens.output > 0);
  assert(job.startedAt !== null && job.finishedAt !== null);
  expect(count(instance.sql, "job_items"), "a finished job's items are gone").toBe(0);

  const history = await instance.service.getHistory(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "greeting"),
    language: "de",
  });
  const llm = history.entries.find((entry) => entry.event === "translation_llm")!;
  expect(llm.actor.name).toStrictEqual(FAKE_MODEL);
  expect(llm.detail?.model).toStrictEqual(FAKE_MODEL);
  expect(llm.detail?.jobId).toStrictEqual(upload.job.id);
  expect(typeof llm.detail?.requestId).toBe("number");
  // Two batches (one per language) and the file's context.
  expect(count(instance.sql, "llm_requests", "strings > 0")).toBe(2);
  expect(count(instance.sql, "llm_requests", "strings = 0")).toBe(1);
  const activity = await instance.service.getActivity(ANONYMOUS, {});
  expect(activity.items[0].summary).toStrictEqual(
    `Translation job ${upload.job.id} finished: 8 translated`,
  );
});

test("re-translating does green strings once each, never blue, and doesn't loop", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "title", "de", "Wanderer");
  const { job } = await instance.service.createJob(SYSTEM, { retranslate: true });
  assert(job !== null);
  expect(job.priority).toBe("bulk");
  expect(job.progress.total).toStrictEqual(2 * STRINGS - 1);
  expect(await drain(instance)).toBe(1);
  const done = await instance.service.getJob(SYSTEM, { id: job.id });
  expect(done.status).toBe("done");
  expect(done.progress.done).toStrictEqual(2 * STRINGS - 1);
  expect((await translations(instance, "de")).title?.value, "blue stays").toBe("Wanderer");
  expect((await translations(instance, "de")).title?.colour).toBe("blue");
});

test("an outdated green translation is updated", async () => {
  using instance = await project();
  await drain(instance);
  const upload = await uploadJson(instance.service, {
    "common.json": { ...COMMON, greeting: "Hello again, {{name}}!" },
  });
  assert(upload.job !== null);
  await drain(instance);
  const greeting = (await translations(instance, "de")).greeting!;
  expect(greeting.value).toBe("[Ĥéļļö áğáíñ, {{name}}!]");
  expect([greeting.colour, greeting.outdated]).toStrictEqual(["green", false]);
});

test("an outdated proofread translation is updated green, and comes back blue with its English", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "greeting", "de", "Willkommen zurück, {{name}}!");
  // The proofreading was for this English, not the next.
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, greeting: "Hello again, {{name}}!" },
  });
  await drain(instance);
  const updated = (await translations(instance, "de")).greeting!;
  expect([updated.value, updated.colour, updated.outdated]).toStrictEqual([
    "[Ĥéļļö áğáíñ, {{name}}!]",
    "green",
    false,
  ]);
  expect(count(instance.sql, "suggestions", "language = 'de'"), "nothing to review").toStrictEqual(
    0,
  );

  await uploadJson(instance.service, { "common.json": COMMON });
  await drain(instance);
  const restored = (await translations(instance, "de")).greeting!;
  expect([restored.value, restored.colour, restored.outdated]).toStrictEqual([
    "Willkommen zurück, {{name}}!",
    "blue",
    false,
  ]);
  const after = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  expect(JSON.parse(after.files[0].content).greeting).toBe("Willkommen zurück, {{name}}!");
});

test("upload jobs follow updateOutdated for green and proofread translations alike", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "title", "de", "Wanderer");
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, llm: { ...settings.llm, updateOutdated: false } });
  const upload = await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarers", greeting: "Hello again, {{name}}!" },
  });
  expect(upload.job, "nothing to do: no job").toBe(null);
  const german = await translations(instance, "de");
  expect(german.greeting?.outdated, "green stays outdated").toBe(true);
  expect(german.title?.outdated, "and so does the proofread one").toBe(true);
});

test("a person's job updates outdated translations, proofread ones too, whatever the upload settings", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "title", "de", "Wanderer");
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, {
    ...settings,
    llm: { ...settings.llm, autoTranslate: false, updateOutdated: false },
  });
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarers", greeting: "Hello again, {{name}}!" },
  });
  const { estimate } = await instance.service.createJob(SYSTEM, {
    dryRun: true,
    languages: ["de"],
  });
  expect(estimate?.work).toStrictEqual({ translate: 0, retranslate: 0, update: 2 });

  await instance.service.createJob(SYSTEM, { languages: ["de"] });
  await drain(instance);
  const german = await translations(instance, "de");
  expect([german.title?.colour, german.title?.outdated]).toStrictEqual(["green", false]);
  expect(german.greeting?.outdated).toBe(false);
});

test("a person's change during a batch wins over the LLM's result", async () => {
  const held = heldProvider();
  using instance = await project(held);
  const running = instance.service.alarm();
  await held.started;
  writeBlue(instance, "greeting", "de", "Willkommen zurück, {{name}}!");
  writeBlue(instance, "greeting", "pl", "Witaj ponownie, {{name}}!");
  held.release();
  await running;
  await drain(instance);
  expect((await translations(instance, "de")).greeting?.value).toStrictEqual(
    "Willkommen zurück, {{name}}!",
  );
  expect((await translations(instance, "pl")).greeting?.value).toStrictEqual(
    "Witaj ponownie, {{name}}!",
  );
  const [job] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  expect(job.progress.skipped).toBe(2);
  expect(job.progress.translated).toStrictEqual(2 * STRINGS - 2);
});

test("a cancelled job's results are dropped, and it runs no more", async () => {
  const held = heldProvider();
  using instance = await project(held);
  const running = instance.service.alarm();
  await held.started;
  const [queued] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  const cancelled = await instance.service.cancelJob(SYSTEM, { id: queued.id });
  expect(cancelled.status).toBe("cancelled");
  held.release();
  await running;
  expect(await drain(instance)).toBe(0);
  expect(count(instance.sql, "translations")).toBe(0);
  const job = await instance.service.getJob(SYSTEM, { id: queued.id });
  expect([job.status, job.progress.done]).toStrictEqual(["cancelled", 0]);
  assert(job.finishedAt !== null);
  // Cancelling again changes nothing.
  expect((await instance.service.cancelJob(SYSTEM, { id: queued.id })).status).toStrictEqual(
    "cancelled",
  );
});

test("jobs: who may start, see and cancel them", async () => {
  using instance = await project();
  const read = await createToken(instance.service, "read");
  const upload = await createToken(instance.service, "upload");
  const other = await createToken(instance.service, "upload", "other");
  const contributor = addUser(instance.sql, "contributor");
  const manager = addUser(instance.sql, "manager");
  for (const [actor, code] of [
    [ANONYMOUS, "unauthorized"],
    [read.actor, "forbidden"],
    [contributor, "forbidden"],
  ] as const) {
    const error = await instance.service.createJob(actor, {}).catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toStrictEqual(code);
    await expect(instance.service.listJobs(actor, {})).rejects.toThrow(ServiceError);
  }
  const { job } = await instance.service.createJob(upload.actor, { languages: ["de"] });
  assert(job !== null);
  expect(job.createdBy).toStrictEqual({ type: "token", id: upload.id, name: "upload key" });
  const denied = await instance.service
    .cancelJob(other.actor, { id: job.id })
    .catch((error: unknown) => error);
  assert(denied instanceof ServiceError);
  expect(denied.code).toBe("forbidden");
  expect((await instance.service.cancelJob(upload.actor, { id: job.id })).status).toStrictEqual(
    "cancelled",
  );
  const second = await instance.service.createJob(manager, { languages: ["pl"] });
  expect(second.job?.createdBy.type).toBe("user");
  await drain(instance);
  const finished = await instance.service
    .cancelJob(manager, { id: second.job!.id })
    .catch((error: unknown) => error);
  assert(finished instanceof ServiceError);
  expect(finished.code).toBe("conflict");
  const missing = await instance.service
    .getJob(manager, { id: 999 })
    .catch((error: unknown) => error);
  assert(missing instanceof ServiceError);
  expect(missing.code).toBe("not_found");
});

test("jobs: a manager limited to some languages runs and cancels jobs in those only (ROLE-3)", async () => {
  using instance = await project();
  const { service } = instance;
  const polish = addUser(instance.sql, "manager", ["pl"], "Polish manager");
  const none = addUser(instance.sql, "manager", [], "Manager without languages");
  const code = async (promise: Promise<unknown>) => {
    const error = await promise.catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    return error.code;
  };
  writeBlue(instance, "title", "de", "Wanderer");
  write(instance, "common.json", "greeting", "de", "Willkommen, {{name}}!");

  // Another language, alone or among theirs, is refused, dry run or not.
  for (const languages of [["de"], ["pl", "de"]]) {
    expect(await code(service.createJob(polish, { languages, retranslate: true }))).toStrictEqual(
      "forbidden",
    );
    expect(await code(service.createJob(polish, { languages, dryRun: true }))).toStrictEqual(
      "forbidden",
    );
  }
  expect(await code(service.createJob(none, {}))).toBe("forbidden");
  // Without languages, a job covers theirs.
  const estimate = (await service.createJob(polish, { dryRun: true })).estimate!;
  expect(estimate.languages.map((l) => l.language)).toStrictEqual(["pl"]);
  const { job } = await service.createJob(polish, { retranslate: true });
  expect([job!.scope.languages, job!.progress.total]).toStrictEqual([["pl"], STRINGS]);
  await drain(instance);
  expect((await translations(instance, "de")).greeting?.value).toStrictEqual(
    "Willkommen, {{name}}!",
  );
  expect((await translations(instance, "pl")).greeting?.colour).toBe("green");

  // They cancel jobs in their languages, not the others' (an upload's covers every one).
  const german = await service.createJob(SYSTEM, { languages: ["de"], retranslate: true });
  const everything = await service.createJob(SYSTEM, { retranslate: true });
  const theirs = await service.createJob(polish, { languages: ["pl"], retranslate: true });
  expect(await code(service.cancelJob(polish, { id: german.job!.id }))).toBe("forbidden");
  expect(await code(service.cancelJob(polish, { id: everything.job!.id }))).toStrictEqual(
    "forbidden",
  );
  expect((await service.cancelJob(polish, { id: theirs.job!.id })).status).toStrictEqual(
    "cancelled",
  );
  // Nothing limits administrators, whatever list they kept.
  const admin = addUser(instance.sql, "administrator", ["pl"]);
  expect((await service.cancelJob(admin, { id: german.job!.id })).status).toStrictEqual(
    "cancelled",
  );
});

test("jobs: qa re-translates the green translations that fail the checks, and only those", async () => {
  using instance = await project();
  await drain(instance);
  const title = stringId(instance.sql, "common.json", "title");
  instance.sql.run(
    "UPDATE translations SET qa_errors = 1 WHERE string_id = ? AND language = 'pl'",
    title,
  );
  const plain = await instance.service.createJob(SYSTEM, { dryRun: true });
  const qa = await instance.service.createJob(SYSTEM, { qa: true, dryRun: true });
  expect([plain.estimate!.strings, qa.estimate!.strings]).toStrictEqual([0, 1]);
  instance.sql.run("UPDATE translations SET colour = 'blue' WHERE string_id = ?", title);
  const blue = await instance.service.createJob(SYSTEM, { qa: true, dryRun: true });
  expect(blue.estimate!.strings, "blue translations never change").toBe(0);
});

test("jobs: the scope is checked, and a dry run only estimates", async () => {
  using instance = await project();
  const check = async (request: Parameters<typeof instance.service.createJob>[1], code: string) => {
    const error = await instance.service
      .createJob(SYSTEM, request)
      .catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code, JSON.stringify(request)).toStrictEqual(code);
  };
  await check({ languages: ["fr"] }, "bad_request");
  await check({ files: ["missing.json"] }, "bad_request");
  await check({ strings: [999] }, "not_found");
  await check({ model: "../etc" }, "bad_request");
  await check({ languages: ["de"], strings: [], outdated: "yes" } as never, "validation_failed");

  const jobs = count(instance.sql, "jobs");
  const { job, estimate } = await instance.service.createJob(SYSTEM, {
    dryRun: true,
    languages: ["PL"],
  });
  expect(job).toBe(null);
  expect(count(instance.sql, "jobs"), "nothing created").toStrictEqual(jobs);
  assert(estimate !== null);
  expect(estimate.strings).toStrictEqual(STRINGS);
  expect(estimate.requests).toBe(1);
  expect(estimate.languages).toStrictEqual([
    { language: "pl", strings: STRINGS, words: estimate.words },
  ]);
  expect(estimate.files).toStrictEqual([
    { file: "common.json", strings: STRINGS, words: estimate.words },
  ]);
  assert(estimate.words > 0);
  assert(estimate.estimatedTokens.input > 200, JSON.stringify(estimate));
  assert(estimate.estimatedTokens.output > 10);

  const single = await instance.service.createJob(SYSTEM, {
    strings: [stringId(instance.sql, "common.json", "greeting")],
    languages: ["de"],
    instruction: "  Be brief.  ",
    model: "model-b",
  });
  expect(single.job?.priority).toBe("string");
  expect(single.job?.scope).toStrictEqual({
    languages: ["de"],
    strings: [stringId(instance.sql, "common.json", "greeting")],
    instruction: "Be brief.",
    model: "model-b",
  });
  expect(single.job?.progress.total).toBe(1);
});

test("without a provider, LLM translation is off with a clear message", async () => {
  using instance = await startTestService();
  const upload = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      languages: ["de"],
    },
  );
  expect(upload.job).toBe(null);
  expect((await instance.service.getProject(ANONYMOUS, {})).llmAvailable).toBe(false);
  const error = await instance.service.createJob(SYSTEM, {}).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("llm_unavailable");
  expect(error.message).toStrictEqual(
    "LLM translation is off: enter a Gemini API key in Settings.",
  );
  expect(error.status).toBe(503);
  expect(await instance.service.listModels(SYSTEM, {})).toStrictEqual({ models: [] });

  using withProvider = await project();
  expect((await withProvider.service.getProject(ANONYMOUS, {})).llmAvailable).toBe(true);
  expect(await withProvider.service.listModels(SYSTEM, {})).toStrictEqual({ models: [FAKE_MODEL] });
});

test("a file's context is generated once, and a person's context wins", async () => {
  const provider = heldProvider();
  provider.release();
  using instance = await project(provider);
  await drain(instance);
  expect(provider.texts.length).toBe(1);
  const [file] = instance.sql.query<{ generated_context: string | null }>(
    "SELECT generated_context FROM files",
  );
  assert(file.generated_context !== null && file.generated_context.length > 0);
  assert(provider.requests[0].prompt.includes(file.generated_context!));
  await instance.service.createJob(SYSTEM, { retranslate: true });
  await drain(instance);
  expect(provider.texts.length, "cached").toBe(1);

  instance.sql.run("UPDATE files SET context = 'Words shown on the title screen.'");
  await instance.service.createJob(SYSTEM, { retranslate: true, languages: ["de"] });
  await drain(instance);
  const last = provider.requests[provider.requests.length - 1];
  assert(last.prompt.includes("Words shown on the title screen."));
  assert(!last.prompt.includes(file.generated_context!));
});

test("a file's prompt has its folders' contexts, outermost first, then its own", async () => {
  const provider = heldProvider();
  provider.release();
  using instance = await startTestService({ provider });
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, {
    ...settings,
    llm: {
      ...settings.llm,
      autoTranslate: false,
      context: { ...settings.llm.context, fileContext: false },
    },
  });
  await uploadJson(
    instance.service,
    { "text/menus/main.json": { play: "Play" } },
    { languages: ["de"] },
  );
  await instance.service.updateFolder(SYSTEM, {
    path: "text",
    context: "Words of a sailing game.",
  });
  await instance.service.updateFolder(SYSTEM, { path: "text/menus", context: "Menu buttons." });
  instance.sql.run("UPDATE files SET context = 'The main menu.'");
  await instance.service.createJob(SYSTEM, { languages: ["de"] });
  await drain(instance);
  expect(provider.requests[0].prompt).toContain(
    "About this file:\nWords of a sailing game.\n\nMenu buttons.\n\nThe main menu.\n",
  );
});

test("the upload key's usage, the custom instruction and the model reach the request", async () => {
  const provider = heldProvider();
  provider.release();
  using instance = await project(provider);
  await drain(instance);
  const single = stringId(instance.sql, "common.json", "title");
  await instance.service.createJob(SYSTEM, {
    strings: [single],
    languages: ["pl"],
    retranslate: true,
    instruction: "Keep it short.",
    model: "model-b",
  });
  await drain(instance);
  const last = provider.requests[provider.requests.length - 1];
  expect(last.model).toBe("model-b");
  assert(last.prompt.endsWith("Keep it short."));
  expect(last.batch?.strings.map((s) => s.id)).toStrictEqual([`s${single}`]);
  const forms = (await translations(instance, "pl")).coins?.value as PluralForms;
  expect(Object.keys(forms)).toStrictEqual(["one", "few", "many", "other"]);
});

test("other languages in the prompt: only translations of the current English", async () => {
  const provider = heldProvider();
  provider.release();
  using instance = await startTestService({ provider });
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, {
    ...settings,
    llm: {
      ...settings.llm,
      autoTranslate: false,
      context: { ...settings.llm.context, otherLanguages: ["de"], fileContext: false },
    },
  });
  const english = { play: "Play", quit: "Quit the game" };
  await uploadJson(instance.service, { "common.json": english }, { languages: ["de", "pl"] });
  writeBlue(instance, "play", "de", "Spielen");
  writeBlue(instance, "quit", "de", "Spiel beenden");
  // The English changes: the German is now outdated, a translation of other words.
  await uploadJson(instance.service, { "common.json": { ...english, quit: "Save the game" } });
  await instance.service.createJob(SYSTEM, { languages: ["pl"] });
  await drain(instance);
  expect(provider.requests.length).toBe(1);
  const prompt = provider.requests[0].prompt;
  const play = stringId(instance.sql, "common.json", "play");
  assert(
    prompt.includes(
      JSON.stringify({ id: `s${play}`, language: "de", translation: "Spielen", proofread: true }),
    ),
    "an up-to-date translation, proofread",
  );
  assert(!prompt.includes("Spiel beenden"), "not an outdated one");
});
