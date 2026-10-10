// SPDX-License-Identifier: MIT
/**
 * LLM translation on D1 (S5.8): the demo uploaded with automatic
 * translation, the jobs run by the alarm with the fake translator, every language green,
 * the usage recorded, and the budget pausing jobs.
 */
import {
  ANONYMOUS,
  createFakeTranslator,
  createAsyncService,
  type Service,
  SYSTEM,
} from "@quaso/service";
import { beforeEach, describe, expect, it } from "vitest";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { sql } from "./env.ts";
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

describe("LLM jobs on D1", () => {
  beforeEach(() => resetUploadSql(sql));
  it("translate the demo into every language, with plural forms and references", async () => {
    const service = createAsyncService({
      sql,
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

  it("pause jobs when the monthly budget is used up", async () => {
    const service = createAsyncService({
      sql,
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
