// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { LLM_LIFECYCLE_CASES } from "./testing/llm_lifecycle_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of LLM_LIFECYCLE_CASES) {
  test(`async LLM lifecycle on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
