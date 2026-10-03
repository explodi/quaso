// SPDX-License-Identifier: MIT
/**
 * The real Gemini provider in workerd, with the runtime's own `fetch` (no fetch is
 * injected), against the fake Gemini API that vitest.config.ts makes the Worker's outbound
 * service (test/gemini_stub.ts). workerd refuses some `fetch` options that Bun and Node
 * accept (`redirect: "error"`), so only a test here shows that the Durable Object can reach
 * the API at all.
 */
import { runInDurableObject } from "cloudflare:test";
import {
  createGeminiProvider,
  createService,
  ProviderError,
  type Service,
  SYSTEM,
} from "@quaso/service";
import { describe, expect, it } from "vitest";
import { createDurableObjectSql } from "../src/do_sql.ts";
import { freshObject } from "./env.ts";
import { GEMINI_STUB_KEY, GEMINI_STUB_URL } from "./gemini_stub.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function stubbedGemini(apiKey = GEMINI_STUB_KEY) {
  return createGeminiProvider({ apiKey, baseUrl: GEMINI_STUB_URL, maxAttempts: 1 });
}

const REQUEST = {
  model: "gemini-stub",
  system: "You are a translator.",
  prompt: 'Translate:\n{"id":"s1","key":"play","english":"Play"}',
  responseSchema: { type: "object" },
  safety: "permissive" as const,
};

/** Runs the alarm until no job is queued or running. */
async function drain(service: Service): Promise<number> {
  for (let runs = 0; runs < 20; runs++) {
    const { jobs } = await service.listJobs(SYSTEM, {});
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return runs;
    await service.alarm();
  }
  throw new Error("The jobs didn't finish");
}

describe("the Gemini provider in workerd", () => {
  it("reaches the API with the runtime's fetch: models, and a parsed answer", async () => {
    const gemini = stubbedGemini();
    expect(await gemini.listModels()).toEqual(["gemini-stub"]);
    const result = await gemini.translate(REQUEST);
    expect(result.answer).toEqual({ translations: [{ id: "s1", text: "[Gemini] Play" }] });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, thinkingTokens: 10 });
  });

  it("refuses a redirect instead of following it (the key would go with it)", async () => {
    const error = await stubbedGemini()
      .translate({ ...REQUEST, model: "moved" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "invalid_request", status: 302 });
    expect((error as Error).message).toContain("redirect");
  });

  it("reports a refused key as an auth error", async () => {
    await expect(stubbedGemini("AIza-wrong-key").translate(REQUEST)).rejects.toMatchObject({
      kind: "auth",
      status: 400,
    });
  });

  it("translates a project in the Durable Object, run by the alarm", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const service = createService({
        sql: createDurableObjectSql(state.storage),
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "gemini-test-secret-key-".repeat(3),
        logger: silent,
        provider: stubbedGemini(),
      });
      await service.start();
      const upload = await service.upload(SYSTEM, {
        files: [
          {
            path: "menus.json",
            repoPath: "menus.json",
            content: JSON.stringify({
              play: "Play",
              quit: "Quit the game",
              lives_one: "{{count}} life",
              lives_other: "{{count}} lives",
            }),
          },
        ],
        languages: ["de"],
      });
      expect(upload.job).not.toBeNull();
      await drain(service);
      const job = await service.getJob(SYSTEM, { id: upload.job!.id });
      expect(job.status).toBe("done");
      expect(job.progress).toMatchObject({ translated: 3, failed: 0 });
      const exported = await service.exportFiles(SYSTEM, { languages: ["de"] });
      expect(JSON.parse(exported.files[0].content)).toEqual({
        play: "[Gemini] Play",
        quit: "[Gemini] Quit the game",
        lives_one: "[Gemini] {{count}} lives",
        lives_other: "[Gemini] {{count}} lives",
      });
      const usage = await service.getUsage(SYSTEM, { period: "day" });
      const today = usage.rows[usage.rows.length - 1];
      // The file's context, then the batch.
      expect(today.requests).toBe(2);
      expect(today.failures).toBe(0);
    });
  });
});
