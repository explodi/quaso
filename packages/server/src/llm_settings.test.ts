// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { SYSTEM } from "@quaso/service";
import { startLocalService } from "./local_service.ts";
import { memoryLogger, testConfig } from "./testing/helpers.ts";

test("local LLM configuration ignores the former environment variables", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  const log = memoryLogger();
  const local = await startLocalService(
    testConfig({
      DATA_DIR: dir,
      GEMINI_API_KEY: "environment-key-should-not-be-used",
      GEMINI_MODEL: "environment-model",
      LLM_CONCURRENCY: "16",
      LLM_MONTHLY_TOKEN_BUDGET: "5",
    }),
    log,
    { llm: true },
  );
  try {
    const result = await local.service.getSettings(SYSTEM, {});
    expect(result.llmAvailable).toBe(false);
    expect(result.settings.llm.model).toBe("gemini-flash-latest");
    expect(result.settings.llm.concurrency).toBe(4);
    expect(result.settings.llm.monthlyTokenBudget).toBe(null);
    await local.service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
    expect((await local.service.getProject(SYSTEM, {})).llmAvailable).toBe(true);
    await local.service.removeSecret(SYSTEM, { name: "gemini_api_key" });
    expect((await local.service.getProject(SYSTEM, {})).llmAvailable).toBe(false);
    expect(JSON.stringify(log.lines).includes("stored-key-1234")).toBe(false);
  } finally {
    local.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});
