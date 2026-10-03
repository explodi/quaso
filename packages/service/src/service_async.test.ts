// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { ASYNC_SERVICE_CASES } from "./testing/service_async_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of ASYNC_SERVICE_CASES) {
  test(`async service on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
