// SPDX-License-Identifier: MIT
/** OPS-1: a 3,000-string, ten-language project stays responsive on real Durable Object SQLite. */
import { runInDurableObject } from "cloudflare:test";
import { createService, SYSTEM } from "@quaso/service";
import { expect, it } from "vitest";
import { createDurableObjectSql } from "../src/do_sql.ts";
import { freshObject } from "./env.ts";

const LANGUAGES = ["de", "fr", "es", "it", "pt-BR", "pl", "ru", "ja", "ko", "zh-Hans"];
function files(changed = false) {
  return Array.from({ length: 10 }, (_, file) => ({
    path: `file${file}.json`,
    repoPath: `file${file}.json`,
    content: JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 300 }, (_, key) => [
          `key${key}`,
          `The quick brown fox ${key} welcomes {{name}}${
            changed && key % 10 === 0 ? " again" : ""
          }.`,
        ]),
      ),
    ),
  }));
}

it("3,000 strings in ten languages: upload, recheck, export and browse each finish within 30 seconds", async () => {
  const results = await runInDurableObject(freshObject(), async (_object, state) => {
    const sql = createDurableObjectSql(state.storage);
    const service = createService({
      sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "performance-test",
    });
    await service.start();
    const timings: Record<string, number> = {};
    async function measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const start = Date.now();
      const result = await operation();
      // The host boundary updates workerd's request clock without counting an arbitrary sleep.
      await state.storage.sync();
      timings[name] = Date.now() - start;
      return result;
    }
    const uploaded = await measure("upload", () =>
      service.upload(SYSTEM, { files: files(), languages: LANGUAGES }),
    );
    expect(uploaded.added).toHaveLength(3000);
    sql.run(
      `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
      revision, search_text, created_at, updated_at)
      SELECT s.id, l.tag, s.source, 'green', s.source_hash, 'system', 1, s.search_text, 0, 0
      FROM strings s CROSS JOIN languages l WHERE s.kind = 'text'`,
    );
    const updated = await measure("changedUpload", () =>
      service.upload(SYSTEM, { files: files(true) }),
    );
    expect(updated.changed).toHaveLength(300);
    const unchanged = await measure("unchangedUpload", () =>
      service.upload(SYSTEM, { files: files(true) }),
    );
    expect(unchanged.uploadId).toBeNull();
    const exported = await measure("export", () => service.exportFiles(SYSTEM, {}));
    expect(exported.files).toHaveLength(100);
    await measure("status", () => service.getStatus(SYSTEM, {}));
    await measure("project", () => service.getProject(SYSTEM, {}));
    const strings = await measure("search", () =>
      service.listStrings(SYSTEM, {
        language: "de",
        state: "outdated",
        q: "fox",
      }),
    );
    expect(strings.total).toBe(300);
    return timings;
  });
  console.log("Durable Object SQLite 3,000 × 10 timings (ms):", results);
  for (const [operation, ms] of Object.entries(results)) {
    expect(ms, operation).toBeLessThan(30_000);
  }
}, 120_000);
