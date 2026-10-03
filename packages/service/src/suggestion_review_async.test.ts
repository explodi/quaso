// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SUGGESTION_REVIEW_CASES } from "./testing/suggestion_review_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SUGGESTION_REVIEW_CASES) {
  test(`async suggestion review on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
