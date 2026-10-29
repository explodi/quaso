// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/**
 * The job runner (S5.1, S5.4, S5.8): priorities, the concurrency limit, retries with the
 * reasons, failures, pauses, the budget, restarts, and acceptance tests 3 and 9.
 */
import { openNodeSqlite } from "../adapters/node_sqlite.ts";
import { TimerScheduler } from "../adapters/timer_scheduler.ts";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { ProviderError, type TranslationProvider } from "../llm/provider.ts";
import { createService } from "../service.ts";
import { loadSettings, saveSettings } from "../settings.ts";
import {
  count,
  FakeScheduler,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "../test_helpers.ts";
import { nextWakeUp } from "../wakeups.ts";
import { answered, drain, heldProvider, scriptedProvider } from "./testing.ts";
import { AUTH_ERROR, BUDGET_ERROR, NO_PROVIDER_ERROR } from "./store.ts";
import { MAX_ATTEMPTS, RETRY_BASE_MS } from "./runner.ts";
import { nextMonthStart } from "./usage.ts";

const COMMON = {
  title: "Wayfarer",
  greeting: "Welcome back, {{name}}!",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  again: "$t(title) again",
};

/** Sets LLM settings. */
function llmSettings(instance: TestInstance, llm: Partial<ReturnType<typeof loadSettings>["llm"]>) {
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, llm: { ...settings.llm, ...llm } });
}

/** A project uploaded without an automatic job, and the provider. */
async function quietProject(
  provider: TranslationProvider,
  options: { llmConcurrency?: number; monthlyTokenBudget?: number | null } = {},
  languages = ["de", "pl"],
): Promise<TestInstance> {
  const instance = await startTestService({ provider, ...options });
  llmSettings(instance, {
    autoTranslate: false,
    context: { ...loadSettings(instance.ctx).llm.context, fileContext: false },
  });
  await uploadJson(instance.service, { "common.json": COMMON }, { languages });
  return instance;
}

test("runner: single strings first, then uploads, then bulk jobs", async () => {
  const provider = scriptedProvider();
  using instance = await startTestService({ provider });
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["de"] });
  const upload = (await instance.service.listJobs(SYSTEM, {})).jobs[0];
  const bulk = await instance.service.createJob(SYSTEM, { languages: ["de"] });
  const title = stringId(instance.sql, "common.json", "title");
  const single = await instance.service.createJob(SYSTEM, { strings: [title], languages: ["de"] });
  await instance.service.alarm();
  expect(provider.requests[0].batch?.strings.map((s) => s.id)).toStrictEqual([`s${title}`]);
  const status = async (id: number) => (await instance.service.getJob(SYSTEM, { id })).status;
  expect(await status(single.job!.id)).toBe("done");
  expect(await status(upload.id), "one job per alarm run").toBe("queued");
  expect(await status(bulk.job!.id)).toBe("queued");
  await instance.service.alarm();
  expect(await status(upload.id)).toBe("done");
  expect((await instance.service.getJob(SYSTEM, { id: upload.id })).progress.translated).toBe(3);
  // Nothing was left for the bulk job.
  expect(await status(bulk.job!.id)).toBe("done");
  expect((await instance.service.getJob(SYSTEM, { id: bulk.job!.id })).progress.total).toBe(0);
  expect(provider.requests.length).toBe(2);
});

test("runner: at most LLM_CONCURRENCY batches at once, 3 × that per alarm run", async () => {
  let active = 0;
  let most = 0;
  const provider = scriptedProvider(async () => {
    active++;
    most = Math.max(most, active);
    await new Promise((done) => setTimeout(done, 5));
    active--;
    return undefined;
  });
  using instance = await quietProject(provider, { llmConcurrency: 2 });
  llmSettings(instance, { batchSize: 1 });
  await instance.service.createJob(SYSTEM, {});
  await instance.service.alarm();
  expect(provider.requests.length).toBe(6);
  expect(most).toBe(2);
  expect(nextWakeUp(instance.sql)! <= instance.clock.now + 1, "more work: now").toBe(true);
  await drain(instance);
  expect(provider.requests.length).toBe(8);
  expect(count(instance.sql, "translations")).toBe(8);
});

test("runner: a new service on the same database finishes the job (a restart)", async () => {
  const database = openNodeSqlite(":memory:");
  try {
    const held = heldProvider();
    const clock = () => Date.UTC(2026, 8, 24, 12);
    const first = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "k",
      clock,
      provider: held,
    });
    await first.start();
    await uploadJson(first, { "common.json": COMMON }, { languages: ["de", "pl"] });
    void first.alarm(); // Never finishes: the process "dies" while waiting for the provider.
    await held.started;

    const scheduler = new FakeScheduler();
    const second = createService({
      sql: database.sql,
      scheduler,
      secretKey: "k",
      clock,
      provider: createFakeTranslator(),
    });
    await second.start();
    expect(scheduler.scheduled.length > 0, "start() arms the wake-up again").toBe(true);
    await second.alarm();
    const [job] = (await second.listJobs(SYSTEM, {})).jobs;
    expect(job.status).toBe("done");
    expect(job.progress.translated).toBe(8);
    expect(database.sql.query("SELECT COUNT(*) AS n FROM translations")[0].n).toBe(8);
  } finally {
    database.close();
  }
});

test("checks and retries: the reason goes into the retry, which passes (acceptance test 9)", async () => {
  const provider = scriptedProvider((request, index) => {
    if (index > 0) return undefined;
    const coins = request.batch!.strings.find((s) => s.kind === "plural")!;
    return answered({
      translations: request.batch!.strings.map((s) =>
        s === coins
          ? {
              id: s.id,
              forms: {
                one: "{{count}} moneta",
                few: "kilka monet",
                many: "{{count}} monet",
                other: "{{count}} monety",
              },
            }
          : { id: s.id, text: `PL ${s.english}` },
      ),
    });
  });
  using instance = await quietProject(provider, {}, ["pl"]);
  await instance.service.createJob(SYSTEM, {});
  await drain(instance);
  expect(provider.requests.length).toBe(2);
  const retry = provider.requests[1];
  expect(
    retry.batch?.strings.map((s) => s.kind),
    "only the string that failed",
  ).toStrictEqual(["plural"]);
  expect(retry.prompt).toContain("Placeholder {{count}} is missing from the few form.");
  expect(retry.prompt).toContain('"answer":{"one":"{{count}} moneta","few":"kilka monet"');
  const coins = (await instance.service.listStrings(ANONYMOUS, { language: "pl" })).strings.find(
    (s) => s.key === "coins",
  )!;
  expect(coins.translation?.colour).toBe("green");
  expect((coins.translation?.value as Record<string, string>).few).toStrictEqual(
    "[{{count}} çöíñś]",
  );
  expect(coins.llmFailure).toBe(null);
  const outcomes = instance.sql
    .query<{ outcome: string }>("SELECT outcome FROM llm_requests ORDER BY id")
    .map((row) => row.outcome);
  expect(outcomes).toStrictEqual(["partial", "ok"]);
});

test("checks and retries: a string failing 3 times stays untranslated, its failure recorded", async () => {
  const provider = scriptedProvider((request) =>
    answered({
      translations: request
        .batch!.strings.filter((s) => s.kind !== "plural")
        .map((s) => ({ id: s.id, text: typeof s.english === "string" ? `PL ${s.english}` : "" })),
    }),
  );
  using instance = await quietProject(provider, {}, ["pl"]);
  const { job } = await instance.service.createJob(SYSTEM, {});
  await drain(instance);
  expect(provider.requests.length, "the first try and 2 retries").toBe(3);
  const done = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect(done.status).toBe("done");
  expect(done.progress.failed).toBe(1);
  expect(done.progress.translated).toBe(3);
  expect(done.failures).toStrictEqual([
    {
      stringId: stringId(instance.sql, "common.json", "coins"),
      language: "pl",
      file: "common.json",
      key: "coins",
      reason: "No translation was returned.",
    },
  ]);
  const page = await instance.service.listStrings(ANONYMOUS, { language: "pl" });
  const coins = page.strings.find((s) => s.key === "coins")!;
  expect(coins.translation).toBe(null);
  expect(coins.llmFailure).toBe("No translation was returned.");
  const detail = await instance.service.getString(ANONYMOUS, { id: coins.id, language: "pl" });
  expect(detail.llmFailure).toBe("No translation was returned.");

  // A person's translation clears it.
  write(
    instance,
    "common.json",
    "coins",
    "pl",
    {
      one: "{{count}} moneta",
      few: "{{count}} monety",
      many: "{{count}} monet",
      other: "{{count}} monety",
    },
    {
      colour: "blue",
      actor: { type: "system", id: null, label: "System" },
      event: "translation_saved",
    },
  );
  const after = await instance.service.getString(ANONYMOUS, { id: coins.id, language: "pl" });
  expect(after.llmFailure).toBe(null);
});

test("provider errors: failures per string; blocked answers retried in halves", async () => {
  const provider = scriptedProvider((request, index) => {
    if (index === 0) {
      return {
        answer: null,
        usage: { inputTokens: 50, outputTokens: 0, thinkingTokens: 0 },
        durationMs: 3,
        blocked: "SAFETY",
      };
    }
    if (request.batch!.strings.some((s) => s.english === "Wayfarer")) {
      throw new ProviderError("server", "HTTP 500: An internal error has occurred.");
    }
    return undefined;
  });
  using instance = await quietProject(provider, {}, ["de"]);
  await instance.service.createJob(SYSTEM, {});
  await drain(instance);
  // Blocked with 4 strings: two halves of 2; the half with "Wayfarer" fails for good.
  expect(provider.requests.map((r) => r.batch!.strings.length)).toStrictEqual([4, 2, 2]);
  expect(provider.requests[1].prompt).toContain("blocked by the safety filters (SAFETY)");
  const [job] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  expect(job.progress.failed).toBe(2);
  expect(job.progress.translated).toBe(2);
  expect(job.failures[0].reason).toBe("HTTP 500: An internal error has occurred.");
  expect(
    instance.sql
      .query<{ outcome: string }>("SELECT outcome FROM llm_requests ORDER BY id")
      .map((row) => row.outcome),
  ).toStrictEqual(["blocked", "failed", "ok"]);
});

test("a file's context that can't be generated is asked for once per job, not every run", async () => {
  const provider = scriptedProvider();
  provider.generateText = (request) => {
    provider.texts.push(request);
    return Promise.reject(
      new ProviderError("blocked", "The answer was blocked (SAFETY).", {
        usage: { inputTokens: 500, outputTokens: 0, thinkingTokens: 0 },
      }),
    );
  };
  using instance = await quietProject(provider, { llmConcurrency: 1 }, ["de"]);
  llmSettings(instance, {
    batchSize: 1,
    context: { ...loadSettings(instance.ctx).llm.context, fileContext: true },
  });
  const { job } = await instance.service.createJob(SYSTEM, {});
  assert((await drain(instance)) > 1, "several alarm runs");
  expect(provider.texts.length).toBe(1);
  const done = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect([done.status, done.progress.translated]).toStrictEqual(["done", 4]);
  const contextRequests = () =>
    instance.sql
      .query<{
        outcome: string;
      }>("SELECT outcome FROM llm_requests WHERE language IS NULL ORDER BY id")
      .map((row) => row.outcome);
  expect(contextRequests()).toStrictEqual(["blocked"]);

  // A later job asks again, once.
  await instance.service.createJob(SYSTEM, { retranslate: true });
  await drain(instance);
  expect(provider.texts.length).toBe(2);
  expect(contextRequests()).toStrictEqual(["blocked", "blocked"]);
});

test("an API key the provider refuses pauses the job; a restart resumes it", async () => {
  const refusing = scriptedProvider(() => {
    throw new ProviderError("auth", "HTTP 403: Permission denied.", { status: 403 });
  });
  const database = openNodeSqlite(":memory:");
  try {
    const clock = () => Date.UTC(2026, 8, 24, 12);
    const first = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "k",
      clock,
      provider: refusing,
    });
    await first.start();
    await uploadJson(first, { "common.json": COMMON }, { languages: ["de"] });
    await first.alarm();
    const [paused] = (await first.listJobs(SYSTEM, {})).jobs;
    expect([paused.status, paused.error]).toStrictEqual(["paused", AUTH_ERROR]);
    expect(paused.progress.failed, "not a failure per string").toBe(0);
    expect(database.sql.query("SELECT COUNT(*) AS n FROM llm_failures")[0].n).toBe(0);
    expect(nextWakeUp(database.sql), "no more wake-ups").toBe(null);

    const second = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "k",
      clock,
      provider: createFakeTranslator(),
    });
    await second.start();
    await second.alarm();
    expect((await second.getJob(SYSTEM, { id: paused.id })).status).toBe("done");

    // Without a provider, jobs pause with a clear message.
    const third = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "k",
      clock,
      provider: createFakeTranslator(),
    });
    await third.start();
    await uploadJson(third, { "common.json": { ...COMMON, extra: "More" } });
    const none = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "k",
      clock,
    });
    await none.start();
    await none.alarm();
    const [latest] = (await none.listJobs(SYSTEM, {})).jobs;
    expect([latest.status, latest.error]).toStrictEqual(["paused", NO_PROVIDER_ERROR]);
  } finally {
    database.close();
  }
});

test("a failed alarm run is retried with backoff; the job fails after 5 in a row", async () => {
  const provider = scriptedProvider(() => {
    throw new TypeError("Something unexpected");
  });
  using instance = await quietProject(provider, {}, ["de"]);
  const { job } = await instance.service.createJob(SYSTEM, {});
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    await instance.service.alarm();
    const current = await instance.service.getJob(SYSTEM, { id: job!.id });
    expect([current.status, current.error]).toStrictEqual(["running", "Something unexpected"]);
    const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
    expect(nextWakeUp(instance.sql)).toStrictEqual(instance.clock.now + wait);
    instance.clock.advance(wait);
  }
  await instance.service.alarm();
  const failed = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe("The job failed 5 times in a row: Something unexpected");
  expect(nextWakeUp(instance.sql)).toBe(null);
});

test("the monthly budget pauses jobs, and they resume in the next month", async () => {
  const fake = createFakeTranslator();
  // 100 tokens a request: two requests use the budget of 200 up.
  const provider = scriptedProvider(async (request) => ({
    ...(await fake.translate(request)),
    usage: { inputTokens: 80, outputTokens: 20, thinkingTokens: 0 },
  }));
  using instance = await quietProject(provider, { llmConcurrency: 1, monthlyTokenBudget: 200 }, [
    "de",
  ]);
  llmSettings(instance, { batchSize: 1 });
  const { job } = await instance.service.createJob(SYSTEM, {});
  // The run stops as soon as the budget is used up, with the job paused.
  await instance.service.alarm();
  expect(provider.requests.length).toBe(2);
  const paused = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect([paused.status, paused.error]).toStrictEqual(["paused", BUDGET_ERROR]);
  expect(paused.progress.translated).toBe(2);
  const month = nextMonthStart(instance.clock.now);
  expect(nextWakeUp(instance.sql)).toStrictEqual(month);
  await instance.service.alarm();
  expect(provider.requests.length).toBe(2);
  const refused = await instance.service.createJob(SYSTEM, {}).catch((error: unknown) => error);
  assert(refused instanceof ServiceError);
  expect([refused.code, refused.status]).toStrictEqual(["budget_exceeded", 429]);
  const usage = await instance.service.getUsage(SYSTEM, { period: "month" });
  expect(usage.budget.monthlyTokens).toBe(200);
  expect(usage.budget.paused).toBe(true);

  instance.clock.now = month;
  await drain(instance);
  const done = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect(done.status).toBe("done");
  expect(done.error).toBe(null);
  expect(done.progress.translated).toBe(4);
});

test("the budget is checked before every request, so a run stops once it is used up", async () => {
  const provider = scriptedProvider();
  using instance = await startTestService({ provider, monthlyTokenBudget: 1000 });
  llmSettings(instance, {
    autoTranslate: false,
    batchSize: 1,
    context: { ...loadSettings(instance.ctx).llm.context, fileContext: false },
  });
  const lines = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`line${index}`, `Line number ${index + 1}`]),
  );
  await uploadJson(instance.service, { "lines.json": lines }, { languages: ["de"] });
  const { job } = await instance.service.createJob(SYSTEM, {});
  await instance.service.alarm();
  // Only the requests already on their way (LLM_CONCURRENCY = 4), not the whole slice of 12.
  expect(provider.requests.length).toBe(4);
  const paused = await instance.service.getJob(SYSTEM, { id: job!.id });
  expect([paused.status, paused.error]).toStrictEqual(["paused", BUDGET_ERROR]);
  expect(paused.progress.translated).toBe(4);
  expect(count(instance.sql, "job_items"), "the rest is left for next month").toBe(4);
  expect(nextWakeUp(instance.sql)).toStrictEqual(nextMonthStart(instance.clock.now));
  // A retry is a request too: an answer that fails its checks isn't retried past the budget.
  const retrying = scriptedProvider((request) =>
    answered({
      translations: request.batch!.strings.map((string) => ({ id: string.id, text: "" })),
    }),
  );
  using other = await quietProject(retrying, { llmConcurrency: 1, monthlyTokenBudget: 100 }, [
    "de",
  ]);
  llmSettings(other, { batchSize: 1 });
  await other.service.createJob(SYSTEM, {});
  await other.service.alarm();
  expect(retrying.requests.length).toBe(1);
  expect(count(other.sql, "llm_failures"), "not a failure: tried again next month").toStrictEqual(
    0,
  );
  expect((await other.service.listJobs(SYSTEM, {})).jobs[0].status).toBe("paused");
});

test("usage: requests and tokens per day and month, by language and by model", async () => {
  using instance = await quietProject(createFakeTranslator());
  await instance.service.createJob(SYSTEM, {});
  await drain(instance);
  instance.clock.advance(24 * 60 * 60 * 1000);
  instance.sql.run(
    `INSERT INTO llm_requests (provider, model, language, strings, input_tokens, output_tokens,
       thinking_tokens, outcome, created_at) VALUES ('gemini', 'gemini-2.5-pro', 'de', 3, 100, 20, 7, 'failed', ?)`,
    instance.clock.now,
  );
  const days = await instance.service.getUsage(SYSTEM, { period: "day" });
  expect(days.period).toBe("day");
  expect(days.rows.length).toBe(30);
  const [yesterday, today] = days.rows.slice(-2);
  expect([yesterday.period, today.period]).toStrictEqual(["2026-09-24", "2026-09-25"]);
  expect(yesterday.requests).toBe(2);
  expect(yesterday.failures).toBe(0);
  expect(Object.keys(yesterday.byLanguage).sort()).toStrictEqual(["de", "pl"]);
  expect(Object.keys(yesterday.byModel)).toStrictEqual(["fake-translator"]);
  assert(yesterday.inputTokens > 0);
  expect(today).toStrictEqual({
    period: "2026-09-25",
    requests: 1,
    failures: 1,
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 7,
    byLanguage: {
      de: { requests: 1, failures: 1, inputTokens: 100, outputTokens: 20, thinkingTokens: 7 },
    },
    byModel: {
      "gemini-2.5-pro": {
        requests: 1,
        failures: 1,
        inputTokens: 100,
        outputTokens: 20,
        thinkingTokens: 7,
      },
    },
  });
  const months = await instance.service.getUsage(SYSTEM, {
    period: "month",
    from: "2026-08",
    to: "2026-09",
  });
  expect(months.rows.map((row) => [row.period, row.requests])).toStrictEqual([
    ["2026-08", 0],
    ["2026-09", 3],
  ]);
  expect(months.budget).toStrictEqual({
    monthlyTokens: null,
    usedThisMonth:
      months.rows[1].inputTokens + months.rows[1].outputTokens + months.rows[1].thinkingTokens,
    paused: false,
  });
  const range = await instance.service.getUsage(SYSTEM, {
    period: "day",
    from: "2026-09-25",
    to: "2026-09-25",
  });
  expect(range.rows.map((row) => row.period)).toStrictEqual(["2026-09-25"]);
  for (const query of [
    { period: "day", from: "2026-13-01" },
    {
      period: "day",
      from: "2026-09-26",
      to: "2026-09-25",
    },
    { period: "month", from: "1990-01" },
  ] as const) {
    const error = await instance.service.getUsage(SYSTEM, query).catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code, JSON.stringify(query)).toBe("bad_request");
  }
  const anonymous = await instance.service
    .getUsage(ANONYMOUS, { period: "day" })
    .catch((error: unknown) => error);
  assert(anonymous instanceof ServiceError);
  expect(anonymous.code).toBe("unauthorized");
});

test("the fake translator's plural zero forms pass the checks, Latvian's native zero too", async () => {
  using instance = await startTestService({ provider: createFakeTranslator() });
  const coins = { coins_zero: "No coins", coins_one: "One coin", coins_other: "{{count}} coins" };
  await uploadJson(instance.service, { "common.json": coins }, { languages: ["lv", "de"] });
  await drain(instance);
  const [job] = (await instance.service.listJobs(SYSTEM, {})).jobs;
  expect([job.status, job.progress.translated, job.progress.failed]).toStrictEqual(["done", 2, 0]);
  expect(count(instance.sql, "llm_failures")).toBe(0);
  const zero = async (language: string) =>
    (
      (await instance.service.listStrings(ANONYMOUS, { language })).strings[0].translation
        ?.value as Record<string, string>
    ).zero;
  expect(await zero("lv"), "Latvian zero is 0, 10–20, 30, …").toBe("[{{count}} çöíñś]");
  expect(await zero("de")).toBe("[Ñö çöíñś]");
});

test("acceptance test 3: one new string is green in 10 languages well within a minute", async () => {
  const languages = ["de", "fr", "it", "es", "pt", "pl", "tr", "ja", "ko", "zh-Hans"];
  const database = openNodeSqlite(":memory:");
  let service: ReturnType<typeof createService> | null = null;
  const scheduler = new TimerScheduler(() => service!.alarm());
  try {
    service = createService({
      sql: database.sql,
      scheduler,
      secretKey: "k",
      provider: createFakeTranslator({ delayMs: 300 }),
    });
    await service.start();
    await uploadJson(service, { "common.json": { title: "Wayfarer" } }, { languages });
    const settled = async () => {
      for (let i = 0; i < 500; i++) {
        const busy = database.sql.query(
          "SELECT 1 AS found FROM jobs WHERE status IN ('queued', 'running')",
        );
        if (busy.length === 0) return;
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error("The jobs didn't finish");
    };
    await settled();
    const started = performance.now();
    const upload = await uploadJson(service, {
      "common.json": { title: "Wayfarer", newQuest: "A new quest awaits, {{name}}!" },
    });
    assert(upload.job !== null);
    const id = database.sql.query<{ id: number }>(
      "SELECT id FROM strings WHERE display_key = 'newQuest'",
    )[0].id;
    for (;;) {
      const green = database.sql.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM translations WHERE string_id = ? AND colour = 'green'",
        id,
      )[0].n;
      if (green === languages.length) break;
      assert(performance.now() - started < 10_000, "green in every language within 10 seconds");
      await new Promise((done) => setTimeout(done, 20));
    }
    const seconds = (performance.now() - started) / 1000;
    assert(seconds < 10, `${seconds} s`);
    // 10 requests, 4 at a time, 300 ms each: about a second, not 3.
    assert(seconds > 0.5 && seconds < 2.5, `${seconds} s`);
    await settled();
    await new Promise((done) => setTimeout(done, 50));
  } finally {
    scheduler.stop();
    database.close();
  }
});
