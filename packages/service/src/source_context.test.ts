// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { SourceFilesResult } from "@quaso/core";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SYSTEM } from "./api.ts";
import { createAsyncService } from "./service_async.ts";
import { createFakeTranslator } from "./llm/fake.ts";

test("upload attaches repository descriptions, reports unknown keys and updates metadata without losing translations", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    const service = createAsyncService({
      sql: opened.sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    const file = {
      path: "a.json",
      repoPath: "a.json",
      content: '{"bridge":"Across the canal"}',
      descriptions: '{"bridge":"Spans the canal","unknown":"Missing key"}',
    };
    const uploaded = await service.upload(SYSTEM, { files: [file], languages: ["de"] });
    expect(uploaded.warnings[0]).toContain("no source string");
    const id = (await service.listStrings(SYSTEM, { language: "de" })).strings[0].id;
    expect((await service.getString(SYSTEM, { id, language: "de" })).description).toStrictEqual(
      "Spans the canal",
    );
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      files: [{ path: "a.json", content: '{"bridge":"Über den Kanal"}' }],
    });
    const revised = { ...file, descriptions: '{"bridge":"A bridge spanning the water"}' };
    await service.upload(SYSTEM, { files: [revised], dryRun: true });
    expect((await service.getString(SYSTEM, { id, language: "de" })).description).toStrictEqual(
      "Spans the canal",
    );
    await service.upload(SYSTEM, { files: [revised] });
    const detail = await service.getString(SYSTEM, { id, language: "de" });
    expect(detail.description).toBe("A bridge spanning the water");
    expect(detail.translation?.value).toBe("Über den Kanal");
    expect(detail.translation?.colour).toBe("blue");
    expect(detail.translation?.outdated).toBe(false);
  } finally {
    opened.close();
  }
});

test("inline description suffixes stay out of source strings and downloaded game files", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    const service = createAsyncService({
      sql: opened.sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.upload(SYSTEM, {
      descriptionSuffix: "@description",
      languages: ["de"],
      files: [
        {
          path: "a.json",
          repoPath: "a.json",
          content: '{"bridge":"Across the canal","bridge@description":"Spans it"}',
        },
      ],
    });
    const page = await service.listStrings(SYSTEM, { language: "de" });
    expect(page.total).toBe(1);
    expect(page.strings[0].description).toBe("Spans it");
    expect(JSON.parse((await service.exportFiles(SYSTEM, {})).files[0].content)).toStrictEqual({
      bridge: "Across the canal",
    });
  } finally {
    opened.close();
  }
});

test("model ambiguity notes reach job results and the needs-description list, which descriptions resolve", async () => {
  const opened = openAsyncSqlite(":memory:");
  const fake = createFakeTranslator();
  const provider = {
    ...fake,
    async translate(request: Parameters<typeof fake.translate>[0]) {
      const result = await fake.translate(request);
      const answer = result.answer as { translations: { ambiguous?: string }[] };
      answer.translations[0].ambiguous = "Across can mean spans or on the far side; I chose spans.";
      return result;
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
    await service.updateSettings(SYSTEM, {
      llm: { autoTranslate: false, context: { fileContext: false } },
    });
    await service.upload(SYSTEM, {
      languages: ["de"],
      files: [{ path: "a.json", repoPath: "a.json", content: '{"bridge":"Across the canal"}' }],
    });
    const id = (await service.listStrings(SYSTEM, { language: "de" })).strings[0].id;
    const created = await service.createJob(SYSTEM, { strings: [id] });
    await service.alarm();
    expect((await service.getJob(SYSTEM, { id: created.job!.id })).notes?.[0].kind).toStrictEqual(
      "ambiguous",
    );
    expect((await service.getString(SYSTEM, { id, language: "de" })).sourceWarnings?.[0].kind).toBe(
      "ambiguous",
    );
    const sources = (await service.listFiles(SYSTEM, {})) as SourceFilesResult;
    expect(sources.ambiguities?.[0].id).toStrictEqual(id);
    expect(sources.ambiguities![0].message).toContain("I chose spans");
    await service.updateString(SYSTEM, { id, description: "The bridge spans the canal." });
    expect(((await service.listFiles(SYSTEM, {})) as SourceFilesResult).ambiguities).toStrictEqual(
      undefined,
    );
  } finally {
    opened.close();
  }
});
