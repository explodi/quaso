// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@std/assert";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SYSTEM } from "./api.ts";
import { createAsyncService } from "./service_async.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import type { TranslationProvider } from "./llm/provider.ts";

test("terminology bootstrap verifies recurring terms, counts variants, accepts edits and dismisses rows", async () => {
  const opened = openAsyncSqlite(":memory:");
  const fake = createFakeTranslator();
  const model = {
    ...fake,
    async translate(request: Parameters<TranslationProvider["translate"]>[0]) {
      const input = JSON.parse(request.prompt);
      return {
        answer: {
          terms: [
            {
              term: "tram stop",
              note: "Use the same transport noun",
              occurrences: [
                { id: input.corpus[0].id, rendering: "Haltestelle" },
                { id: input.corpus[1].id, rendering: "Haltestelle" },
                { id: input.corpus[2].id, rendering: "Straßenbahnhaltestelle" },
              ],
            },
            {
              term: "invented term",
              occurrences: [{ id: input.corpus[0].id, rendering: "invented" }],
            },
          ],
        },
        usage: { inputTokens: 20, outputTokens: 10, thinkingTokens: 0 },
        durationMs: 1,
      };
    },
  };
  try {
    const service = createAsyncService({
      sql: opened.sql,
      provider: model,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
    await service.upload(SYSTEM, {
      languages: ["de"],
      files: [
        {
          path: "a.json",
          repoPath: "a.json",
          content: '{"first":"Go to the tram stop","second":"Build a tram stop"}',
        },
        { path: "b.json", repoPath: "b.json", content: '{"third":"Choose the tram stop"}' },
      ],
    });
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "green",
      files: [
        {
          path: "a.json",
          content: '{"first":"Gehe zur Haltestelle","second":"Baue eine Haltestelle"}',
        },
        { path: "b.json", content: '{"third":"Straßenbahnhaltestelle wählen"}' },
      ],
    });
    const created = await service.createQualityJob(SYSTEM, {
      kind: "terminology",
      languages: ["de"],
    });
    await service.alarm();
    const report = await service.getQualityJob(SYSTEM, { id: created.id });
    assert(report.kind === "terminology");
    assertEquals(report.status, "done");
    assertEquals(report.result.length, 1);
    assertEquals(report.result[0].preferred, "Haltestelle");
    assertEquals(report.result[0].renderings, [
      { translation: "Haltestelle", count: 2 },
      { translation: "Straßenbahnhaltestelle", count: 1 },
    ]);
    assertEquals([report.result[0].count, report.result[0].files, report.flagged], [3, 2, 1]);
    await service.reviewTerminology(SYSTEM, {
      id: report.id,
      index: 0,
      action: "accept",
      translation: "Tramhaltestelle",
    });
    assertEquals(
      (await service.listGlossary(SYSTEM, { language: "de" })).terms[0].translation,
      "Tramhaltestelle",
    );
    const accepted = await service.getQualityJob(SYSTEM, { id: report.id });
    assert(accepted.kind === "terminology");
    assertEquals(accepted.result[0].status, "accepted");
    await service.reviewTerminology(SYSTEM, { id: report.id, index: 0, action: "dismiss" });
    const dismissed = await service.getQualityJob(SYSTEM, { id: report.id });
    assert(dismissed.kind === "terminology");
    assertEquals(dismissed.result[0].status, "dismissed");
    assertEquals((await service.listGlossary(SYSTEM, { language: "de" })).terms.length, 1);
  } finally {
    opened.close();
  }
});

test("style drafts sample proofread text and require an explicit language-instructions save", async () => {
  const opened = openAsyncSqlite(":memory:");
  const fake = createFakeTranslator();
  const seen: unknown[] = [];
  const model = {
    ...fake,
    async translate(request: Parameters<TranslationProvider["translate"]>[0]) {
      seen.push(JSON.parse(request.prompt).corpus);
      return {
        answer: {
          instructions:
            "Use du, German regional vocabulary and source punctuation. Keep placeholder spacing.",
        },
        usage: { inputTokens: 20, outputTokens: 10, thinkingTokens: 0 },
        durationMs: 1,
      };
    },
  };
  try {
    const service = createAsyncService({
      sql: opened.sql,
      provider: model,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test",
    });
    await service.start();
    await service.updateSettings(SYSTEM, { llm: { autoTranslate: false } });
    await service.upload(SYSTEM, {
      languages: ["de"],
      files: [
        {
          path: "a.json",
          repoPath: "a.json",
          content: '{"green":"New game","blue":"Quit the game"}',
        },
      ],
    });
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "green",
      files: [{ path: "a.json", content: '{"green":"Neues Spiel"}' }],
    });
    await service.importTranslations(SYSTEM, {
      language: "de",
      as: "blue",
      files: [{ path: "a.json", content: '{"blue":"Verlasse das Spiel"}' }],
    });
    const created = await service.createQualityJob(SYSTEM, {
      kind: "style_guide",
      languages: ["de"],
    });
    await service.alarm();
    const job = await service.getQualityJob(SYSTEM, { id: created.id });
    assert(job.kind === "style_guide");
    assertEquals(job.result[0].samples, 1);
    assertEquals((seen[0] as { colour: string }[])[0].colour, "blue");
    assertEquals((await service.getSettings(SYSTEM, {})).languages[0].instructions, "");
    await service.updateLanguage(SYSTEM, { tag: "de", instructions: job.result[0].instructions });
    assertEquals(
      (await service.getSettings(SYSTEM, {})).languages[0].instructions,
      job.result[0].instructions,
    );
  } finally {
    opened.close();
  }
});
