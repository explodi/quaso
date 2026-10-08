// SPDX-License-Identifier: MIT
/**
 * LLM translation on Durable Object SQLite (S5.8): the demo uploaded with automatic
 * translation, the jobs run by the alarm with the fake translator, every language green,
 * the usage recorded, and the budget pausing jobs. And the data object without a Gemini key.
 */
import { runInDurableObject } from "cloudflare:test";
import {
  ANONYMOUS,
  createFakeTranslator,
  createService,
  type Service,
  SYSTEM,
} from "@quaso/service";
import { describe, expect, it } from "vitest";
import { type LegacyDataEnv, QuasoData, unwrapCall } from "../src/data_object.ts";
import { createDurableObjectSql } from "../src/do_sql.ts";
import { llmOptionsFromEnv } from "../src/llm.ts";
import { env, freshObject } from "./env.ts";
import fixture from "./fixtures/demo.json";
import type { ScenarioInput } from "./scenario.ts";

const input = fixture.input as unknown as ScenarioInput;

/** Runs the alarm until no job is queued or running. */
async function drain(service: Service): Promise<number> {
  for (let runs = 0; runs < 50; runs++) {
    const { jobs } = await service.listJobs(SYSTEM, {});
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return runs;
    await service.alarm();
  }
  throw new Error("The jobs didn't finish");
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("LLM jobs on Durable Object SQLite", () => {
  it("translate the demo into every language, with plural forms and references", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const service = createService({
        sql: createDurableObjectSql(state.storage),
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "llm-test-secret-key-".repeat(4),
        logger: silent,
        provider: createFakeTranslator(),
      });
      await service.start();
      const upload = await service.upload(SYSTEM, input.upload);
      expect(upload.job).not.toBeNull();
      expect(await drain(service)).toBeGreaterThan(0);

      const job = await service.getJob(SYSTEM, { id: upload.job!.id });
      expect(job.status).toBe("done");
      expect(job.progress.failed).toBe(0);
      const status = await service.getStatus(SYSTEM, {});
      for (const language of status.languages) {
        expect(language.untranslated, language.tag).toBe(0);
        expect(language.qa, language.tag).toBe(0);
      }
      const polish = await service.exportFiles(SYSTEM, {
        languages: ["pl"],
        files: ["common.json"],
      });
      const common = JSON.parse(polish.files[0].content);
      expect(common.coins_few).toBe("[{{count}} çöíñś]");
      expect(common.coins_many).toBe("[{{count}} çöíñś]");
      const menus = await service.exportFiles(SYSTEM, { languages: ["de"], files: ["menus.json"] });
      expect(JSON.parse(menus.files[0].content).main.playAgain).toBe("[$t(common:play) áğáíñ]");

      const usage = await service.getUsage(SYSTEM, { period: "day" });
      const today = usage.rows[usage.rows.length - 1];
      expect(today.requests).toBeGreaterThan(0);
      expect(Object.keys(today.byModel)).toEqual(["fake-translator"]);
      expect(Object.keys(today.byLanguage).sort()).toEqual(
        [...(input.upload.languages ?? [])].sort(),
      );
      const page = await service.listStrings(ANONYMOUS, { language: "ja", limit: 500 });
      expect(page.strings.every((string) => string.translation?.colour === "green")).toBe(true);
    });
  });

  it("pause jobs when the monthly budget is used up", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const service = createService({
        sql: createDurableObjectSql(state.storage),
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "llm-test-secret-key-".repeat(4),
        logger: silent,
        provider: createFakeTranslator(),
        monthlyTokenBudget: 1,
        llmConcurrency: 1,
      });
      await service.start();
      await service.upload(SYSTEM, input.upload);
      await service.alarm();
      await service.alarm();
      const [job] = (await service.listJobs(SYSTEM, {})).jobs;
      expect(job.status).toBe("paused");
      expect(job.error).toBe("Monthly token budget reached");
      await expect(service.createJob(SYSTEM, {})).rejects.toMatchObject({
        code: "budget_exceeded",
      });
    });
  });
});

describe("the data object and the LLM", () => {
  it("has no provider without GEMINI_API_KEY, and says so", async () => {
    const data = env.QUASO_DATA.get(env.QUASO_DATA.newUniqueId());
    const project = unwrapCall(await data.call("getProject", ANONYMOUS, {})) as {
      llmAvailable: boolean;
    };
    expect(project.llmAvailable).toBe(false);
    const refused = await data.call("createJob", SYSTEM, {});
    expect(refused).toEqual({
      ok: false,
      status: 503,
      body: {
        error: {
          code: "llm_unavailable",
          message: "LLM translation is off: enter a Gemini API key in Settings.",
        },
      },
    });
    expect(unwrapCall(await data.call("listModels", SYSTEM, {}))).toEqual({ models: [] });
  });

  it("builds Gemini from GEMINI_API_KEY, so LLM translation is on", async () => {
    await runInDurableObject(freshObject(), async (_object, state) => {
      const data = new QuasoData(state, {
        ...env,
        GEMINI_API_KEY: "AIza-test",
      } as unknown as LegacyDataEnv);
      // The migration runs as the object starts: wait for it, as requests would.
      await state.blockConcurrencyWhile(() => Promise.resolve());
      const project = unwrapCall(await data.call("getProject", ANONYMOUS, {})) as {
        llmAvailable: boolean;
      };
      expect(project.llmAvailable).toBe(true);
      // A dry run needs the provider, but calls nothing.
      const dry = unwrapCall(await data.call("createJob", SYSTEM, { dryRun: true })) as {
        job: null;
        estimate: { strings: number };
      };
      expect(dry).toMatchObject({ job: null, estimate: { strings: 0 } });
    });
  });

  it("reads the LLM settings from the Worker's variables", () => {
    const errors: string[] = [];
    const log = { ...silent, error: (message: string) => errors.push(message) };
    const options = llmOptionsFromEnv(
      {
        GEMINI_API_KEY: " AIzaSy-test ",
        LLM_CONCURRENCY: "8",
        LLM_MONTHLY_TOKEN_BUDGET: "5000000",
      },
      log,
    );
    expect(options.provider?.name).toBe("gemini");
    expect(options.llmConcurrency).toBe(8);
    expect(options.monthlyTokenBudget).toBe(5_000_000);
    expect(llmOptionsFromEnv({ LLM_CONCURRENCY: "", LLM_MONTHLY_TOKEN_BUDGET: "" }, log)).toEqual({
      provider: null,
      llmConcurrency: 4,
      monthlyTokenBudget: null,
    });
    expect(llmOptionsFromEnv({ LLM_CONCURRENCY: "many" }, log).llmConcurrency).toBe(4);
    expect(errors).toEqual(["LLM_CONCURRENCY must be a whole number from 1 to 64; it is ignored"]);
  });
});
