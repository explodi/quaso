// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(job.progress.reused).toBe(1);
  expect(job.progress.translated).toBe(0);
  expect(job.status).toBe("done");
  expect(job.tokens).toStrictEqual({ input: 0, output: 0, thinking: 0 });
  const second = await service.getString(SYSTEM, { id: strings[1].id, language: "de" });
  expect(second.translation?.value).toBe("Wähl für mich");
  expect(second.translation?.colour).toBe("green");
  expect(second.identicalSources).toStrictEqual([
    { id: strings[0].id, file: "menu.json", key: "first" },
  ]);
  const history = await service.getHistory(SYSTEM, { id: strings[1].id, language: "de" });
  expect(history.entries[0].event).toBe("translation_reused");
  expect(history.entries[0].detail?.fromStringId).toStrictEqual(strings[0].id);
  expect(
    (await service.getString(SYSTEM, { id: strings[0].id, language: "de" })).translation?.value,
  ).toBe("Wähl für mich");
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
    expect(requests).toBe(0);
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
    expect(qa.total).toBe(2);
    expect(
      (await service.getString(SYSTEM, { id: qa.strings[0].id, language: "de" })).checks[0].check,
    ).toBe("consistency");
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "green",
      files: [{ path: "b.json", content: '{"random":"Wähl für mich"}' }],
    });
    expect((await service.listStrings(SYSTEM, { language: "de", state: "qa" })).total).toBe(0);
  } finally {
    opened.close();
  }
});
