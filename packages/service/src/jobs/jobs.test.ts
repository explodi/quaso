// SPDX-License-Identifier: MIT
import { test } from "node:test";
/**
 * The whole LLM flow with the fake translator (S5.8): uploads queue jobs, the alarm runs
 * them, and the results follow the state rules of design §5.4.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
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
  assertEquals(instance.scheduler.scheduled, [instance.clock.now], "woken up at once");
  assertEquals(await drain(instance), 1);

  const polish = await translations(instance, "pl");
  assertEquals(polish.title?.value, "[Ŵáýƒáŕéŕ]");
  assertEquals(polish.greeting?.value, "[Ŵéļçöɱé ƀáçķ, {{name}}!]");
  assertEquals(polish.coins?.value, {
    one: "[{{count}} çöíñ]",
    few: "[{{count}} çöíñś]",
    many: "[{{count}} çöíñś]",
    other: "[{{count}} çöíñś]",
  });
  assertEquals(polish.again?.value, "[$t(title) áğáíñ]", "the reference comes back exactly");
  for (const language of ["de", "pl"]) {
    const all = Object.values(await translations(instance, language));
    assertEquals(all.length, STRINGS);
    assert(all.every((t) => t?.colour === "green" && !t.outdated && t.qa.errors === 0));
    assertEquals(all[0]?.author, { type: "llm", id: null, name: FAKE_MODEL });
  }
  const german = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  assertEquals(JSON.parse(german.files[0].content).coins_other, "[{{count}} çöíñś]");
  const polishFile = JSON.parse(
    (await instance.service.exportFiles(SYSTEM, { languages: ["pl"] })).files[0].content,
  );
  assertEquals(
    Object.keys(polishFile).filter((key) => key.startsWith("coins_")),
    ["coins_one", "coins_few", "coins_many", "coins_other"],
  );

  const job = await instance.service.getJob(SYSTEM, { id: upload.job.id });
  assertEquals(job.status, "done");
  assertEquals(job.priority, "upload");
  assertEquals(job.progress, {
    total: 2 * STRINGS,
    done: 2 * STRINGS,
    translated: 2 * STRINGS,
    proposed: 0,
    failed: 0,
    skipped: 0,
  });
  assert(job.tokens.input > 0 && job.tokens.output > 0);
  assert(job.startedAt !== null && job.finishedAt !== null);
  assertEquals(count(instance.sql, "job_items"), 0, "a finished job's items are gone");

  const history = await instance.service.getHistory(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "greeting"),
    language: "de",
  });
  const llm = history.entries.find((entry) => entry.event === "translation_llm")!;
  assertEquals(llm.actor.name, FAKE_MODEL);
  assertEquals(llm.detail?.model, FAKE_MODEL);
  assertEquals(llm.detail?.jobId, upload.job.id);
  assertEquals(typeof llm.detail?.requestId, "number");
  // Two batches (one per language) and the file's context.
  assertEquals(count(instance.sql, "llm_requests", "strings > 0"), 2);
  assertEquals(count(instance.sql, "llm_requests", "strings = 0"), 1);
  const activity = await instance.service.getActivity(ANONYMOUS, {});
  assertEquals(
    activity.items[0].summary,
    `Translation job ${upload.job.id} finished: 8 translated`,
  );
});

test("re-translating does green strings once each, never blue, and doesn't loop", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "title", "de", "Wanderer");
  const { job } = await instance.service.createJob(SYSTEM, { retranslate: true });
  assert(job !== null);
  assertEquals(job.priority, "bulk");
  assertEquals(job.progress.total, 2 * STRINGS - 1);
  assertEquals(await drain(instance), 1);
  const done = await instance.service.getJob(SYSTEM, { id: job.id });
  assertEquals(done.status, "done");
  assertEquals(done.progress.done, 2 * STRINGS - 1);
  assertEquals((await translations(instance, "de")).title?.value, "Wanderer", "blue stays");
  assertEquals((await translations(instance, "de")).title?.colour, "blue");
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
  assertEquals(greeting.value, "[Ĥéļļö áğáíñ, {{name}}!]");
  assertEquals([greeting.colour, greeting.outdated], ["green", false]);
});

test("an outdated blue translation gets a pending LLM proposal, and stays blue", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "greeting", "de", "Willkommen zurück, {{name}}!");
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, greeting: "Hello again, {{name}}!" },
  });
  await drain(instance);
  const greeting = (await translations(instance, "de")).greeting!;
  assertEquals(
    [greeting.value, greeting.colour, greeting.outdated],
    ["Willkommen zurück, {{name}}!", "blue", true],
  );
  const suggestions = instance.sql.query<{
    kind: string;
    value: string;
    status: string;
    author_label: string;
  }>("SELECT kind, value, status, author_label FROM suggestions WHERE language = 'de'");
  assertEquals(suggestions, [
    {
      kind: "llm",
      value: JSON.stringify("[Ĥéļļö áğáíñ, {{name}}!]"),
      status: "pending",
      author_label: FAKE_MODEL,
    },
  ]);
  const german = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  assertEquals(JSON.parse(german.files[0].content).greeting, "Willkommen zurück, {{name}}!");
  // Another run proposes nothing new: a proposal for this English is pending.
  const { job } = await instance.service.createJob(SYSTEM, {});
  assertEquals(job?.status, "done");
  assertEquals(job?.progress.total, 0);
  const string = await instance.service.listStrings(ANONYMOUS, { language: "de" });
  assertEquals(string.strings.find((s) => s.key === "greeting")?.pending, 1);

  // A manager approves the proposal: it is downloaded, blue, from then on.
  const [{ id }] = instance.sql.query<{ id: number }>(
    "SELECT id FROM suggestions WHERE kind = 'llm' AND status = 'pending'",
  );
  const manager = addUser(instance.sql, "manager");
  const review = await instance.service.reviewSuggestions(manager, {
    ids: [id],
    action: "approve",
  });
  assertEquals(review.approved, [id]);
  const approved = (await translations(instance, "de")).greeting!;
  assertEquals(
    [approved.value, approved.colour, approved.outdated],
    ["[Ĥéļļö áğáíñ, {{name}}!]", "blue", false],
  );
  const after = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  assertEquals(JSON.parse(after.files[0].content).greeting, "[Ĥéļļö áğáíñ, {{name}}!]");
});

test("upload jobs follow updateOutdated and proposeForProofread separately", async () => {
  using instance = await project();
  await drain(instance);
  writeBlue(instance, "title", "de", "Wanderer");
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, llm: { ...settings.llm, updateOutdated: false } });
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarers", greeting: "Hello again, {{name}}!" },
  });
  await drain(instance);
  const german = await translations(instance, "de");
  assertEquals(german.greeting?.outdated, true, "green stays outdated");
  assertEquals(german.title?.outdated, true);
  assertEquals(count(instance.sql, "suggestions", "kind = 'llm' AND language = 'de'"), 1);
  assertEquals(count(instance.sql, "suggestions", "kind = 'llm' AND language = 'pl'"), 0);

  saveSettings(instance.ctx, {
    ...settings,
    llm: { ...settings.llm, updateOutdated: false, proposeForProofread: false },
  });
  const upload = await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarers!", greeting: "Hello, {{name}}!" },
  });
  assertEquals(upload.job, null, "nothing to do: no job");
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
  assertEquals(
    (await translations(instance, "de")).greeting?.value,
    "Willkommen zurück, {{name}}!",
  );
  assertEquals((await translations(instance, "pl")).greeting?.value, "Witaj ponownie, {{name}}!");
  const [job] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  assertEquals(job.progress.skipped, 2);
  assertEquals(job.progress.translated, 2 * STRINGS - 2);
});

test("a cancelled job's results are dropped, and it runs no more", async () => {
  const held = heldProvider();
  using instance = await project(held);
  const running = instance.service.alarm();
  await held.started;
  const [queued] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  const cancelled = await instance.service.cancelJob(SYSTEM, { id: queued.id });
  assertEquals(cancelled.status, "cancelled");
  held.release();
  await running;
  assertEquals(await drain(instance), 0);
  assertEquals(count(instance.sql, "translations"), 0);
  const job = await instance.service.getJob(SYSTEM, { id: queued.id });
  assertEquals([job.status, job.progress.done], ["cancelled", 0]);
  assert(job.finishedAt !== null);
  // Cancelling again changes nothing.
  assertEquals((await instance.service.cancelJob(SYSTEM, { id: queued.id })).status, "cancelled");
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
    const error = await assertRejects(() => instance.service.createJob(actor, {}), ServiceError);
    assertEquals(error.code, code);
    await assertRejects(() => instance.service.listJobs(actor, {}), ServiceError);
  }
  const { job } = await instance.service.createJob(upload.actor, { languages: ["de"] });
  assert(job !== null);
  assertEquals(job.createdBy, { type: "token", id: upload.id, name: "upload key" });
  const denied = await assertRejects(
    () => instance.service.cancelJob(other.actor, { id: job.id }),
    ServiceError,
  );
  assertEquals(denied.code, "forbidden");
  assertEquals(
    (await instance.service.cancelJob(upload.actor, { id: job.id })).status,
    "cancelled",
  );
  const second = await instance.service.createJob(manager, { languages: ["pl"] });
  assertEquals(second.job?.createdBy.type, "user");
  await drain(instance);
  const finished = await assertRejects(
    () => instance.service.cancelJob(manager, { id: second.job!.id }),
    ServiceError,
  );
  assertEquals(finished.code, "conflict");
  const missing = await assertRejects(
    () => instance.service.getJob(manager, { id: 999 }),
    ServiceError,
  );
  assertEquals(missing.code, "not_found");
});

test("jobs: a manager limited to some languages runs and cancels jobs in those only (ROLE-3)", async () => {
  using instance = await project();
  const { service } = instance;
  const polish = addUser(instance.sql, "manager", ["pl"], "Polish manager");
  const none = addUser(instance.sql, "manager", [], "Manager without languages");
  const code = async (promise: Promise<unknown>) =>
    (await assertRejects(() => promise, ServiceError)).code;
  writeBlue(instance, "title", "de", "Wanderer");
  write(instance, "common.json", "greeting", "de", "Willkommen, {{name}}!");

  // Another language, alone or among theirs, is refused, dry run or not.
  for (const languages of [["de"], ["pl", "de"]]) {
    assertEquals(
      await code(service.createJob(polish, { languages, retranslate: true })),
      "forbidden",
    );
    assertEquals(await code(service.createJob(polish, { languages, dryRun: true })), "forbidden");
  }
  assertEquals(await code(service.createJob(none, {})), "forbidden");
  // Without languages, a job covers theirs.
  const estimate = (await service.createJob(polish, { dryRun: true })).estimate!;
  assertEquals(
    estimate.languages.map((l) => l.language),
    ["pl"],
  );
  const { job } = await service.createJob(polish, { retranslate: true });
  assertEquals([job!.scope.languages, job!.progress.total], [["pl"], STRINGS]);
  await drain(instance);
  assertEquals((await translations(instance, "de")).greeting?.value, "Willkommen, {{name}}!");
  assertEquals((await translations(instance, "pl")).greeting?.colour, "green");

  // They cancel jobs in their languages, not the others' (an upload's covers every one).
  const german = await service.createJob(SYSTEM, { languages: ["de"], retranslate: true });
  const everything = await service.createJob(SYSTEM, { retranslate: true });
  const theirs = await service.createJob(polish, { languages: ["pl"], retranslate: true });
  assertEquals(await code(service.cancelJob(polish, { id: german.job!.id })), "forbidden");
  assertEquals(await code(service.cancelJob(polish, { id: everything.job!.id })), "forbidden");
  assertEquals((await service.cancelJob(polish, { id: theirs.job!.id })).status, "cancelled");
  // Nothing limits administrators, whatever list they kept.
  const admin = addUser(instance.sql, "administrator", ["pl"]);
  assertEquals((await service.cancelJob(admin, { id: german.job!.id })).status, "cancelled");
});

test("jobs: the scope is checked, and a dry run only estimates", async () => {
  using instance = await project();
  const check = async (request: Parameters<typeof instance.service.createJob>[1], code: string) => {
    const error = await assertRejects(
      () => instance.service.createJob(SYSTEM, request),
      ServiceError,
    );
    assertEquals(error.code, code, JSON.stringify(request));
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
  assertEquals(job, null);
  assertEquals(count(instance.sql, "jobs"), jobs, "nothing created");
  assert(estimate !== null);
  assertEquals(estimate.strings, STRINGS);
  assertEquals(estimate.requests, 1);
  assertEquals(estimate.languages, [{ language: "pl", strings: STRINGS, words: estimate.words }]);
  assertEquals(estimate.files, [{ file: "common.json", strings: STRINGS, words: estimate.words }]);
  assert(estimate.words > 0);
  assert(estimate.estimatedTokens.input > 200, JSON.stringify(estimate));
  assert(estimate.estimatedTokens.output > 10);

  const single = await instance.service.createJob(SYSTEM, {
    strings: [stringId(instance.sql, "common.json", "greeting")],
    languages: ["de"],
    instruction: "  Be brief.  ",
    model: "model-b",
  });
  assertEquals(single.job?.priority, "string");
  assertEquals(single.job?.scope, {
    languages: ["de"],
    strings: [stringId(instance.sql, "common.json", "greeting")],
    instruction: "Be brief.",
    model: "model-b",
  });
  assertEquals(single.job?.progress.total, 1);
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
  assertEquals(upload.job, null);
  assertEquals((await instance.service.getProject(ANONYMOUS, {})).llmAvailable, false);
  const error = await assertRejects(() => instance.service.createJob(SYSTEM, {}), ServiceError);
  assertEquals(error.code, "llm_unavailable");
  assertEquals(error.message, "LLM translation is off: enter a Gemini API key in Settings.");
  assertEquals(error.status, 503);
  assertEquals(await instance.service.listModels(SYSTEM, {}), { models: [] });

  using withProvider = await project();
  assertEquals((await withProvider.service.getProject(ANONYMOUS, {})).llmAvailable, true);
  assertEquals(await withProvider.service.listModels(SYSTEM, {}), { models: [FAKE_MODEL] });
});

test("a file's context is generated once, and a person's context wins", async () => {
  const provider = heldProvider();
  provider.release();
  using instance = await project(provider);
  await drain(instance);
  assertEquals(provider.texts.length, 1);
  const [file] = instance.sql.query<{ generated_context: string | null }>(
    "SELECT generated_context FROM files",
  );
  assert(file.generated_context !== null && file.generated_context.length > 0);
  assert(provider.requests[0].prompt.includes(file.generated_context!));
  await instance.service.createJob(SYSTEM, { retranslate: true });
  await drain(instance);
  assertEquals(provider.texts.length, 1, "cached");

  instance.sql.run("UPDATE files SET context = 'Words shown on the title screen.'");
  await instance.service.createJob(SYSTEM, { retranslate: true, languages: ["de"] });
  await drain(instance);
  const last = provider.requests[provider.requests.length - 1];
  assert(last.prompt.includes("Words shown on the title screen."));
  assert(!last.prompt.includes(file.generated_context!));
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
  assertEquals(last.model, "model-b");
  assert(last.prompt.endsWith("Keep it short."));
  assertEquals(
    last.batch?.strings.map((s) => s.id),
    [`s${single}`],
  );
  const forms = (await translations(instance, "pl")).coins?.value as PluralForms;
  assertEquals(Object.keys(forms), ["one", "few", "many", "other"]);
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
  assertEquals(provider.requests.length, 1);
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
