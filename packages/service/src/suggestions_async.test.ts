// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SUGGESTION_LIST_CASES } from "./testing/suggestions_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SUGGESTION_LIST_CASES) {
  test(`async suggestions on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
