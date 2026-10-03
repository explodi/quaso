// SPDX-License-Identifier: MIT
import { SYSTEM, ANONYMOUS } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { ProviderError } from "../llm/provider.ts";
import { createAsyncService } from "../service_async.ts";
import { scriptedProvider } from "../jobs/testing.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
  checkEqual(JSON.stringify(failure.toBody()).includes("stored-key-1234"), false);
  return failure;
}

export const LLM_CONFIGURATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "Gemini tests reject a key with no translation models",
    async run(sql) {
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        providerFactory: () => ({ ...scriptedProvider(), listModels: async () => [] }),
      });
      await service.start();
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      const failure = await rejected(() => service.testLlm(SYSTEM, {}), "bad_request");
      checkEqual(failure.message, "This Gemini key has no available translation models.");
    },
  },
  {
    name: "Gemini testing bypasses cached models, needs a stored key and leaves project state unchanged",
    async run(sql) {
      let calls = 0;
      const keys: string[] = [];
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        clock: () => 200,
        providerFactory(key) {
          keys.push(key);
          return {
            ...scriptedProvider(),
            listModels: async () => {
              calls++;
              return calls === 1 ? ["old-model"] : ["model-z", "model-a", "model-z"];
            },
          };
        },
      });
      await service.start();
      await rejected(() => service.testLlm(ANONYMOUS, {}), "unauthorized");
      await rejected(() => service.testLlm(SYSTEM, {}), "bad_request");
      checkEqual(calls, 0);
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      await service.listModels(SYSTEM, {});
      const before = (await service.getProject(SYSTEM, {})).revision;
      checkEqual(await service.testLlm(SYSTEM, {}), {
        ok: true,
        models: ["model-a", "model-z"],
        keyUpdatedAt: 200,
      });
      checkEqual(calls, 2);
      checkEqual(keys, ["stored-key-1234", "stored-key-1234"]);
      checkEqual((await service.getProject(SYSTEM, {})).revision, before);
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "new-key-1234" });
      checkEqual((await service.testLlm(SYSTEM, {})).keyUpdatedAt, 201);
    },
  },
  {
    name: "Gemini test errors never disclose provider diagnostics or credential values",
    async run(sql) {
      let kind: "auth" | "network" = "auth";
      const logs: unknown[] = [];
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        logger: {
          debug: (...args) => logs.push(args),
          info: (...args) => logs.push(args),
          warn: (...args) => logs.push(args),
          error: (...args) => logs.push(args),
        },
        providerFactory: () => ({
          ...scriptedProvider(),
          listModels: async () => {
            throw new ProviderError(kind, "provider echoed stored-key-1234");
          },
        }),
      });
      await service.start();
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      checkEqual(
        (await rejected(() => service.testLlm(SYSTEM, {}), "bad_request")).message,
        "Gemini refused this API key. Replace it and try again.",
      );
      kind = "network";
      await rejected(() => service.testLlm(SYSTEM, {}), "unavailable");
      checkEqual(JSON.stringify(logs).includes("stored-key-1234"), false);
    },
  },
  {
    name: "Gemini tests recheck administrator access after the provider answers",
    async run(sql) {
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        providerFactory: () => ({
          ...scriptedProvider(),
          listModels: async () => {
            const [revision] = await sql.read([
              { sql: "SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'" },
            ]);
            await sql.commit(Number(revision[0].n), [
              { sql: "UPDATE users SET role = 'manager' WHERE id = 1" },
            ]);
            return ["model-a"];
          },
        }),
      });
      await service.start();
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Admin', 'administrator', 100)",
        },
      ]);
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      await rejected(() => service.testLlm({ type: "user", userId: 1 }, {}), "forbidden");
    },
  },
  {
    name: "key rotation during a request affects the next slice without switching an active slice",
    async run(sql) {
      const used: string[] = [];
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        providerFactory(key) {
          return scriptedProvider(async () => {
            used.push(key);
            if (used.length === 1)
              await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "second-key-5678" });
            return undefined;
          });
        },
      });
      await service.start();
      await service.updateSettings(SYSTEM, {
        llm: {
          autoTranslate: false,
          batchSize: 1,
          concurrency: 1,
          context: { fileContext: false },
        },
      });
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "first-key-1234" });
      await service.upload(SYSTEM, {
        files: [
          {
            path: "common.json",
            repoPath: "common.json",
            content: '{"a":"A","b":"B","c":"C","d":"D"}',
          },
        ],
        languages: ["de"],
      });
      await service.createJob(SYSTEM, { languages: ["de"] });
      await service.alarm();
      checkEqual(used, ["first-key-1234", "first-key-1234", "first-key-1234"]);
      await service.alarm();
      checkEqual(used, ["first-key-1234", "first-key-1234", "first-key-1234", "second-key-5678"]);
    },
  },
  {
    name: "stored keys change availability and invalidate the model cache without restarting",
    async run(sql) {
      const created: string[] = [];
      let lists = 0;
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        providerFactory(key) {
          created.push(key);
          return {
            ...scriptedProvider(),
            listModels: async () => {
              lists++;
              return key === "first-key-1234" ? ["first-model"] : ["second-model"];
            },
          };
        },
      });
      await service.start();
      checkEqual((await service.getProject(SYSTEM, {})).llmAvailable, false);
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "first-key-1234" });
      checkEqual((await service.getProject(SYSTEM, {})).llmAvailable, true);
      checkEqual(await service.listModels(SYSTEM, {}), { models: ["first-model"] });
      checkEqual(await service.listModels(SYSTEM, {}), { models: ["first-model"] });
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "second-key-5678" });
      checkEqual((await service.getSettings(SYSTEM, {})).models, ["second-model"]);
      checkEqual(created, ["first-key-1234", "second-key-5678"]);
      checkEqual(lists, 2);
      await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
      checkEqual((await service.getSettings(SYSTEM, {})).llmAvailable, false);
      checkEqual(await service.listModels(SYSTEM, {}), { models: [] });
    },
  },
  {
    name: "stored limits apply to alarm slices and budget changes resume paused work",
    async run(sql) {
      const provider = scriptedProvider();
      const service = createAsyncService({
        sql,
        secretKey: "test",
        scheduler: { schedule() {}, cancel() {} },
        providerFactory: () => provider,
      });
      await service.start();
      await service.updateSettings(SYSTEM, {
        llm: {
          autoTranslate: false,
          batchSize: 1,
          concurrency: 1,
          context: { fileContext: false },
        },
      });
      await service.upload(SYSTEM, {
        files: [
          {
            path: "common.json",
            repoPath: "common.json",
            content: '{"a":"A","b":"B","c":"C","d":"D","e":"E","f":"F","g":"G","h":"H"}',
          },
        ],
        languages: ["de"],
      });
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      const waiting = await service.createJob(SYSTEM, { languages: ["de"] });
      await service.removeSecret(SYSTEM, { name: "gemini_api_key" });
      await service.alarm();
      checkEqual((await service.getJob(SYSTEM, { id: waiting.job!.id })).status, "paused");
      await service.setSecret(SYSTEM, { name: "gemini_api_key", value: "stored-key-1234" });
      await service.alarm();
      checkEqual(provider.requests.length, 3);
      await service.updateSettings(SYSTEM, { llm: { concurrency: 3, monthlyTokenBudget: 1 } });
      await service.alarm();
      checkEqual(provider.requests.length, 3);
      checkEqual((await service.getJob(SYSTEM, { id: waiting.job!.id })).status, "paused");
      await service.updateSettings(SYSTEM, { llm: { monthlyTokenBudget: null } });
      await service.alarm();
      checkEqual(provider.requests.length, 8);
      checkEqual((await service.getJob(SYSTEM, { id: waiting.job!.id })).status, "done");
    },
  },
];
