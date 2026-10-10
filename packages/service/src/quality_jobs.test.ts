// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { createAsyncService } from "./service_async.ts";
import type { TranslationProvider } from "./llm/provider.ts";

function provider() {
  const requests: string[] = [];
  const value: TranslationProvider = {
    ...createFakeTranslator(),
    name: "fake",
    async listModels() {
      return ["small"];
    },
    async translate(request) {
      requests.push(request.prompt);
      const input = JSON.parse(request.prompt).comparisons;
      return {
        answer: {
          comparisons: [
            {
              id: input[0].id,
              ok: false,
              notes: [
                {
                  kind: "changed",
                  source: "Two tracks",
                  translation: "Dos estaciones",
                  explanation: "Tracks were translated as stations.",
                },
              ],
            },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 4, thinkingTokens: 0 },
        durationMs: 1,
        model: "small",
      };
    },
  };
  return { value, requests };
}

test("meaning jobs flag divergences as nonblocking warnings and preserve proofread text", async () => {
  const opened = openAsyncSqlite(":memory:");
  const model = provider();
  try {
    const service = createAsyncService({
      sql: opened.sql,
      provider: model.value,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
    await service.upload(SYSTEM, {
      languages: ["es"],
      files: [
        { path: "a.json", repoPath: "a.json", content: '{"tracks":"Two tracks and a siding"}' },
      ],
    });
    await service.importTranslations(SYSTEM, {
      language: "es",
      as: "blue",
      files: [{ path: "a.json", content: '{"tracks":"Dos estaciones y una vía auxiliar"}' }],
    });
    const string = (await service.listStrings(SYSTEM, { language: "es" })).strings[0];
    const job = await service.createQualityJob(SYSTEM, {
      kind: "meaning",
      languages: ["es"],
      files: ["a.json"],
    });
    assertEquals(
      (await service.getString(SYSTEM, { id: string.id, language: "es" })).meaningJobId,
      job.id,
    );
    await service.alarm();
    const finished = await service.getQualityJob(SYSTEM, { id: job.id });
    assertEquals(finished.status, "done");
    assertEquals([finished.done, finished.flagged], [1, 1]);
    const detail = await service.getString(SYSTEM, { id: string.id, language: "es" });
    assertEquals(detail.checks[0].check, "meaning");
    assertEquals(detail.checks[0].severity, "warning");
    assertEquals(detail.translation?.value, "Dos estaciones y una vía auxiliar");
    assertEquals(detail.translation?.colour, "blue");
    assertEquals(detail.translation?.revision, string.translation?.revision);
    assertEquals((await service.listStrings(SYSTEM, { language: "es", state: "qa" })).total, 1);
    assertEquals(model.requests.length, 1);
  } finally {
    opened.close();
  }
});

test("automatic blue save checks run after save; budget-exempt checks remain in usage", async () => {
  const opened = openAsyncSqlite(":memory:");
  const model = provider();
  try {
    const service = createAsyncService({
      sql: opened.sql,
      provider: model.value,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.updateSettings(SYSTEM, {
      llm: {
        autoTranslate: false,
        monthlyTokenBudget: 1,
        meaningCheck: {
          enabled: true,
          colours: "blue",
          onSave: true,
          onApproval: true,
          model: "small",
          countsAgainstBudget: false,
        },
      },
    });
    await service.upload(SYSTEM, {
      languages: ["es"],
      files: [{ path: "a.json", repoPath: "a.json", content: '{"tracks":"Two tracks"}' }],
    });
    const id = (await service.listStrings(SYSTEM, { language: "es" })).strings[0].id;
    await service.saveTranslation(SYSTEM, {
      id,
      language: "es",
      value: "Dos estaciones",
      baseRevision: 0,
    });
    assertEquals(model.requests.length, 0);
    assertEquals((await service.listQualityJobs(SYSTEM, {})).jobs.length, 1);
    await service.alarm();
    assertEquals((await service.listQualityJobs(SYSTEM, {})).jobs[0].status, "done");
    const usage = await service.getUsage(SYSTEM, { period: "day" });
    assertEquals(usage.budget.usedThisMonth, 0);
    assertEquals(usage.rows.at(-1)?.requests, 1);
    await assertRejects(() =>
      service.createQualityJob(ANONYMOUS, { kind: "meaning", languages: ["es"] }),
    );
    assertEquals(model.requests.length, 1);
  } finally {
    opened.close();
  }
});
