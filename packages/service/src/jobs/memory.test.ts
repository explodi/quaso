// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { openAsyncSqlite } from "../adapters/node_async_sqlite.ts";
import { SYSTEM } from "../api.ts";
import { createAsyncService } from "../service_async.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { startTestService } from "../test_helpers.ts";
import type { Service } from "../service.ts";

async function reuseScenario(service: Service) {
  await service.updateSettings(SYSTEM, { llm: { autoTranslate: false, translationMemory: true } });
  await service.upload(SYSTEM, {
    files: [{ path: "menu.json", repoPath: "menu.json", content: '{"first":"Pick for me"}' }],
    languages: ["de"],
  });
  await service.importTranslations(SYSTEM, {
    language: "de",
    as: "green",
    files: [{ path: "menu.json", content: '{"first":"Wähl für mich"}' }],
  });
  await service.upload(SYSTEM, {
    files: [
      {
        path: "menu.json",
        repoPath: "menu.json",
        content: '{"first":"Pick for me","second":"Pick for me"}',
      },
    ],
  });
  const strings = (await service.listStrings(SYSTEM, { language: "de" })).strings;
  const created = await service.createJob(SYSTEM, { strings: [strings[1].id] });
  await service.alarm();
  const job = await service.getJob(SYSTEM, { id: created.job!.id });
  assertEquals(job.progress.reused, 1);
  assertEquals(job.progress.translated, 0);
  assertEquals(job.status, "done");
  assertEquals(job.tokens, { input: 0, output: 0, thinking: 0 });
  const second = await service.getString(SYSTEM, { id: strings[1].id, language: "de" });
  assertEquals(second.translation?.value, "Wähl für mich");
  assertEquals(second.translation?.colour, "green");
  assertEquals(second.identicalSources, [{ id: strings[0].id, file: "menu.json", key: "first" }]);
  const history = await service.getHistory(SYSTEM, { id: strings[1].id, language: "de" });
  assertEquals(history.entries[0].event, "translation_reused");
  assertEquals(history.entries[0].detail?.fromStringId, strings[0].id);
  assertEquals(
    (await service.getString(SYSTEM, { id: strings[0].id, language: "de" })).translation?.value,
    "Wähl für mich",
  );
}

test("async translation memory copies green matches with history and no provider requests", async () => {
  const opened = openAsyncSqlite(":memory:");
  let requests = 0;
  const provider = {
    ...createFakeTranslator(),
    async translate(): Promise<never> {
      requests++;
      throw new Error("Memory must not request translation or file context");
    },
  };
  try {
    const service = createAsyncService({
      sql: opened.sql,
      provider,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await reuseScenario(service);
    assertEquals(requests, 0);
  } finally {
    opened.close();
  }
});

test("the synchronous service reuses translations with the same job and history behavior", async () => {
  using instance = await startTestService({ provider: createFakeTranslator() });
  await reuseScenario(instance.service);
});

test("consistency warnings expose differing renderings across files and clear when corrected", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    const service = createAsyncService({
      sql: opened.sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.upload(SYSTEM, {
      languages: ["de"],
      files: [
        { path: "a.json", repoPath: "a.json", content: '{"pick":"Pick for me"}' },
        { path: "b.json", repoPath: "b.json", content: '{"random":"Pick for me"}' },
      ],
    });
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "green",
      files: [
        { path: "a.json", content: '{"pick":"Wähl für mich"}' },
        { path: "b.json", content: '{"random":"Such mir etwas aus"}' },
      ],
    });
    const qa = await service.listStrings(SYSTEM, { language: "de", state: "qa" });
    assertEquals(qa.total, 2);
    assertEquals(
      (await service.getString(SYSTEM, { id: qa.strings[0].id, language: "de" })).checks[0].check,
      "consistency",
    );
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "green",
      files: [{ path: "b.json", content: '{"random":"Wähl für mich"}' }],
    });
    assertEquals((await service.listStrings(SYSTEM, { language: "de", state: "qa" })).total, 0);
  } finally {
    opened.close();
  }
});
