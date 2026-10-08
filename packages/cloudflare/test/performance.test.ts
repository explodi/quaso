// SPDX-License-Identifier: MIT
/** OPS-1: a 3,000-string, ten-language project stays responsive on D1, as deployed. */
import { env } from "cloudflare:test";
import { createAsyncService, SYSTEM } from "@quaso/service";
import { expect, it } from "vitest";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";

const database = (env as unknown as { TEST_D1: D1Database }).TEST_D1;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), database) });

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
  await resetUploadSql(sql);
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "performance-test",
  });
  await service.start();
  const timings: Record<string, number> = {};
  // Every D1 call is I/O, which advances workerd's request clock.
  async function measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const result = await operation();
    timings[name] = Date.now() - start;
    return result;
  }
  const uploaded = await measure("upload", () =>
    service.upload(SYSTEM, { files: files(), languages: LANGUAGES }),
  );
  expect(uploaded.added).toHaveLength(3000);
  await sql.migrate([
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
      revision, search_text, created_at, updated_at)
      SELECT s.id, l.tag, s.source, 'green', s.source_hash, 'system', 1, s.search_text, 0, 0
      FROM strings s CROSS JOIN languages l WHERE s.kind = 'text'`,
    },
  ]);
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
  console.log("D1 3,000 × 10 timings (ms):", timings);
  for (const [operation, ms] of Object.entries(timings)) {
    expect(ms, operation).toBeLessThan(30_000);
  }
}, 120_000);
