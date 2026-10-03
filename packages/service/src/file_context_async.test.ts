// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { FILE_CONTEXT_CASES } from "./testing/file_context_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of FILE_CONTEXT_CASES) {
  test(`async file context on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
