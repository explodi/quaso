// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SUGGESTION_SUBMISSION_CASES } from "./testing/suggestion_submission_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SUGGESTION_SUBMISSION_CASES) {
  test(`async suggestion submission on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
