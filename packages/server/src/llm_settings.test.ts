// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { SYSTEM } from "@quaso/service";
import { startLocalService } from "./local_service.ts";
import { memoryLogger, testConfig } from "./testing/helpers.ts";

test("local LLM configuration ignores the former environment variables", async () => {
  const dir = await Deno.makeTempDir();
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
    assertEquals(result.llmAvailable, false);
    assertEquals(result.settings.llm.model, "gemini-flash-latest");
    assertEquals(result.settings.llm.concurrency, 4);
    assertEquals(result.settings.llm.monthlyTokenBudget, null);
    await local.service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
    assertEquals((await local.service.getProject(SYSTEM, {})).llmAvailable, true);
    await local.service.removeSecret(SYSTEM, { name: "gemini_api_key" });
    assertEquals((await local.service.getProject(SYSTEM, {})).llmAvailable, false);
    assertEquals(JSON.stringify(log.lines).includes("stored-key-1234"), false);
  } finally {
    local.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});
