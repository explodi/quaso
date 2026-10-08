// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
/**
 * The LLM acceptance tests through the HTTP API (sprint plan, "Acceptance tests"):
 *
 * - 3: with automatic translation on, a new string is green in every language within a
 *   minute. The server as `serve` runs it: local storage, its timers, and the provider the
 *   settings choose (the fake translator in development, 300 ms a request).
 * - 9, the LLM path: a translation that drops `{{count}}` is refused. The refusal goes back
 *   to the model with the reason; a string that fails every retry stays untranslated, with
 *   its failure on the job and on the string. (The person path is in `accounts.test.ts`.)
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { JobInfo, JobsResult, StatusResult, StringsPage, UploadResult } from "@quaso/core";
import {
  createFakeTranslator,
  type ProviderRequest,
  type ProviderResult,
  type Service,
  SYSTEM,
  type TranslationProvider,
} from "@quaso/service";
import type { App } from "./app.ts";
import { createApp } from "./app.ts";
import { startLocalService } from "./local_service.ts";
import { call, memoryLogger, testApp, testConfig } from "./testing/helpers.ts";
import { realService } from "./testing/real_service.ts";

const TEN_LANGUAGES = ["de", "fr", "it", "es", "pt-BR", "pl", "tr", "ja", "ko", "zh-Hans"];

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  assertEquals(answer.status, status, JSON.stringify(body));
  return body;
}

/** Waits until no job is queued or running. */
async function settled(app: App, key: string, timeoutMs = 30_000): Promise<JobInfo[]> {
  const started = performance.now();
  for (;;) {
    const { jobs } = await json<JobsResult>(call(app, "/api/v1/jobs", { key }));
    if (jobs.every((job) => job.status !== "queued" && job.status !== "running")) return jobs;
    assert(performance.now() - started < timeoutMs, "the jobs didn't finish");
    await new Promise((done) => setTimeout(done, 50));
  }
}

test("acceptance test 3 through the API: a new string is green in every language within a minute", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "quaso-acceptance-3-" });
  const config = testConfig({ QUASO_DEV: "1", DATA_DIR: dataDir });
  const log = memoryLogger();
  // What `serve` does: local storage, its timers, and the LLM (the fake translator here).
  const local = await startLocalService(config, log, { llm: true });
  try {
    const app = createApp({ config, service: local.service, log, version: "9.9.9" });
    const { secret: key } = await local.service.createApiToken(SYSTEM, {
      name: "CI",
      scope: "upload",
    });
    const upload = (content: Record<string, string>) =>
      json<UploadResult>(
        call(app, "/api/v1/sources", {
          method: "POST",
          key,
          json: {
            files: [
              { path: "common.json", repoPath: "common.json", content: JSON.stringify(content) },
            ],
            languages: TEN_LANGUAGES,
          },
        }),
      );
    const first = await upload({ title: "Wayfarer" });
    assert(first.job !== null, "automatic translation is on by default");
    await settled(app, key);

    const started = performance.now();
    const second = await upload({ title: "Wayfarer", quest: "A new quest awaits, {{name}}!" });
    assert(second.job !== null);
    let seconds = 0;
    for (;;) {
      const status = await json<StatusResult>(call(app, "/api/v1/status", { key }));
      seconds = (performance.now() - started) / 1000;
      if (status.languages.every((language) => language.green === 2)) break;
      assert(seconds < 60, "green in every language within a minute");
      await new Promise((done) => setTimeout(done, 50));
    }
    // 10 requests, 4 at a time, 300 ms each: about a second.
    assert(seconds < 10, `${seconds} s: well within a minute`);
    const job = await json<JobInfo>(call(app, `/api/v1/jobs/${second.job.id}`, { key }));
    assertEquals(job.status, "done");
    assertEquals(job.progress.translated, TEN_LANGUAGES.length);
    for (const language of ["pl", "ja"]) {
      const page = await json<StringsPage>(
        call(app, `/api/v1/strings?language=${language}&q=quest`),
      );
      const [quest] = page.strings;
      assertEquals(quest.translation?.colour, "green");
      assertStringIncludes(quest.translation?.value as string, "{{name}}");
      assertEquals(quest.translation?.author.type, "llm");
    }
    await settled(app, key);
  } finally {
    local.storage.close();
    await fs.rm(dataDir, { recursive: true });
  }
});

/**
 * A provider that answers like the fake translator, except for the Polish plural's `few`
 * form, which drops `{{count}}` while `failures` lasts.
 */
function droppingCount(failures: number): TranslationProvider & { requests: ProviderRequest[] } {
  const fake = createFakeTranslator();
  const requests: ProviderRequest[] = [];
  return {
    name: "fake",
    requests,
    async translate(request): Promise<ProviderResult> {
      requests.push(request);
      const result = await fake.translate(request);
      if (requests.length > failures) return result;
      const answer = result.answer as {
        translations: { id: string; forms?: Record<string, string> }[];
      };
      for (const item of answer.translations) {
        if (item.forms?.few !== undefined) item.forms.few = "kilka monet";
      }
      return result;
    },
    generateText: (request) => fake.generateText(request),
    listModels: () => fake.listModels(),
  };
}

/** A project with a Polish plural, uploaded through the API; the upload queues the job. */
async function withPolish(
  provider: TranslationProvider,
  fn: (setup: { app: App; service: Service; key: string; job: number }) => Promise<void>,
): Promise<void> {
  const real = await realService({ provider });
  try {
    const { secret: key } = await real.service.createApiToken(SYSTEM, {
      name: "CI",
      scope: "upload",
    });
    const { app } = testApp(real.service);
    const content = { coins_one: "{{count}} coin", coins_other: "{{count}} coins", play: "Play" };
    const upload = await json<UploadResult>(
      call(app, "/api/v1/sources", {
        method: "POST",
        key,
        json: {
          files: [
            { path: "common.json", repoPath: "common.json", content: JSON.stringify(content) },
          ],
          languages: ["pl"],
        },
      }),
    );
    assert(upload.job !== null);
    // The alarm, as the storage's timers would call it.
    for (let runs = 0; runs < 20; runs++) {
      const { jobs } = await json<JobsResult>(call(app, "/api/v1/jobs", { key }));
      if (jobs.every((job) => job.status === "done")) break;
      await real.service.alarm();
    }
    await fn({ app, service: real.service, key, job: upload.job.id });
  } finally {
    real.close();
  }
}

test("acceptance test 9 through the API, the LLM path: an answer that drops {{count}} is retried with the reason", async () => {
  const provider = droppingCount(1);
  await withPolish(provider, async ({ app, key, job }) => {
    assertEquals(provider.requests.length, 2, "the first answer, then the retry");
    assertStringIncludes(
      provider.requests[1].prompt,
      "Placeholder {{count}} is missing from the few form.",
    );
    const info = await json<JobInfo>(call(app, `/api/v1/jobs/${job}`, { key }));
    assertEquals([info.status, info.progress.translated, info.progress.failed], ["done", 2, 0]);
    const page = await json<StringsPage>(call(app, "/api/v1/strings?language=pl&q=coin"));
    const [coins] = page.strings;
    assertEquals(coins.translation?.colour, "green");
    assertStringIncludes((coins.translation?.value as Record<string, string>).few, "{{count}}");
    assertEquals(coins.llmFailure, null);
  });
});

test("acceptance test 9 through the API, the LLM path: a string that keeps dropping {{count}} stays untranslated", async () => {
  const provider = droppingCount(Infinity);
  await withPolish(provider, async ({ app, key, job }) => {
    assertEquals(provider.requests.length, 3, "the first try and 2 retries");
    const info = await json<JobInfo>(call(app, `/api/v1/jobs/${job}`, { key }));
    assertEquals([info.status, info.progress.translated, info.progress.failed], ["done", 1, 1]);
    assertEquals(
      info.failures.map((failure) => [failure.key, failure.language]),
      [["coins", "pl"]],
    );
    assertStringIncludes(info.failures[0].reason, "{{count}}");
    const page = await json<StringsPage>(call(app, "/api/v1/strings?language=pl&q=coin"));
    const [coins] = page.strings;
    assertEquals(coins.translation, null, "refused: nothing is written");
    assertStringIncludes(coins.llmFailure ?? "", "{{count}}");
    // The download has the English for it (acceptance test 5), never the refused text.
    const exported = await json<{ files: { language: string; content: string }[] }>(
      call(app, "/api/v1/export?languages=pl", { key }),
    );
    const [polish] = exported.files;
    assertEquals(polish.language, "pl");
    assertEquals(JSON.parse(polish.content).coins_few, "{{count}} coins");
    assert(!polish.content.includes("kilka monet"), polish.content);
  });
});
