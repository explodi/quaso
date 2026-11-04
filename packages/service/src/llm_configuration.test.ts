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

test("a first Anthropic key selects Claude, preserves other settings and tests independently", async () => {
  using instance = await startTestService({
    providerFactory: (_key, name) => ({
      ...scriptedProvider(),
      name,
      listModels: async () =>
        name === "anthropic" ? ["claude-haiku-5-5"] : ["gemini-flash-latest"],
    }),
  });
  const { service } = instance;
  await service.updateSettings(SYSTEM, { name: "My game", llm: { concurrency: 2 } });
  await service.setSecret(SYSTEM, { name: "anthropic_api_key", value: "anthropic-test-1234" });
  const settings = await service.getSettings(SYSTEM, {});
  expect(settings.settings.llm.model).toStrictEqual("claude-haiku-5-5");
  expect(settings.settings.name).toStrictEqual("My game");
  expect(settings.settings.llm.concurrency).toStrictEqual(2);
  expect(settings.llmAvailable).toStrictEqual(true);
  expect((await service.testLlm(SYSTEM, { provider: "anthropic" })).models).toStrictEqual([
    "claude-haiku-5-5",
  ]);
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "gemini-test-5678" });
  expect((await service.getSettings(SYSTEM, {})).settings.llm.model).toStrictEqual(
    "claude-haiku-5-5",
  );
  expect((await service.listModels(SYSTEM, {})).models).toStrictEqual([
    "claude-haiku-5-5",
    "gemini-flash-latest",
  ]);
});

test("a slow provider does not hide the other provider's models", async () => {
  let finish!: (models: string[]) => void;
  const slow = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  using instance = await startTestService({
    providerFactory: (_key, name) => ({
      ...scriptedProvider(),
      name,
      listModels: () => (name === "anthropic" ? Promise.resolve(["claude-haiku-5-5"]) : slow),
    }),
  });
  const { service } = instance;
  await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "gemini-test-5678" });
  await service.setSecret(SYSTEM, { name: "anthropic_api_key", value: "anthropic-test-1234" });
  expect((await service.getSettings(SYSTEM, {})).models).toStrictEqual(["claude-haiku-5-5"]);
  finish(["gemini-flash-latest"]);
  await slow;
  expect((await service.listModels(SYSTEM, {})).models).toStrictEqual([
    "claude-haiku-5-5",
    "gemini-flash-latest",
  ]);
});

test("entering the first key after restore preserves the project's Gemini model", async () => {
  using instance = await startTestService();
  instance.sql.run(
    "INSERT INTO meta (key, value) VALUES ('configured_secret:gemini_api_key', '1'), ('configured_secret:anthropic_api_key', '1')",
  );
  await instance.service.setSecret(SYSTEM, {
    name: "anthropic_api_key",
    value: "anthropic-test-1234",
  });
  const [stored] = instance.sql.query<{ data: string }>("SELECT data FROM settings WHERE id = 1");
  expect(JSON.parse(stored.data).llm.model).toStrictEqual("gemini-flash-latest");
});
