// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect((await service.getSettings(SYSTEM, {})).llmAvailable).toBe(false);
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "first-key-1234" });
  expect((await service.getSettings(SYSTEM, {})).models).toStrictEqual(["model-a"]);
  const status = (await service.listSecrets(SYSTEM, {})).secrets[0];
  expect(await service.testLlm(SYSTEM, {})).toStrictEqual({
    ok: true,
    models: ["model-a"],
    keyUpdatedAt: status.updatedAt,
  });
  await service.updateSettings(SYSTEM, { llm: { concurrency: 2, monthlyTokenBudget: 100 } });
  expect((await service.getUsage(SYSTEM, { period: "month" })).budget.monthlyTokens).toStrictEqual(
    100,
  );
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "second-key-5678" });
  expect((await service.listModels(SYSTEM, {})).models).toStrictEqual(["model-b"]);
  expect(created).toStrictEqual(["first-key-1234", "first-key-1234", "second-key-5678"]);
  await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
  expect((await service.getSettings(SYSTEM, {})).llmAvailable).toBe(false);
});
