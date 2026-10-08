// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { SYSTEM } from "./api.ts";
import { scriptedProvider } from "./jobs/testing.ts";
import { startTestService } from "./test_helpers.ts";

test("synchronous service reads stored keys, limits and changed model lists", async () => {
  const created: string[] = [];
  using instance = await startTestService({
    providerFactory(key) {
      created.push(key);
      return {
        ...scriptedProvider(),
        listModels: async () => (key === "first-key-1234" ? ["model-a"] : ["model-b"]),
      };
    },
  });
  const { service } = instance;
  assertEquals((await service.getSettings(SYSTEM, {})).llmAvailable, false);
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "first-key-1234" });
  assertEquals((await service.getSettings(SYSTEM, {})).models, ["model-a"]);
  const status = (await service.listSecrets(SYSTEM, {})).secrets[0];
  assertEquals(await service.testLlm(SYSTEM, {}), {
    ok: true,
    models: ["model-a"],
    keyUpdatedAt: status.updatedAt,
  });
  await service.updateSettings(SYSTEM, { llm: { concurrency: 2, monthlyTokenBudget: 100 } });
  assertEquals((await service.getUsage(SYSTEM, { period: "month" })).budget.monthlyTokens, 100);
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "second-key-5678" });
  assertEquals((await service.listModels(SYSTEM, {})).models, ["model-b"]);
  assertEquals(created, ["first-key-1234", "first-key-1234", "second-key-5678"]);
  await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
  assertEquals((await service.getSettings(SYSTEM, {})).llmAvailable, false);
});
