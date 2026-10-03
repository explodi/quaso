// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { ACCESS_CASES } from "./testing/access_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of ACCESS_CASES) {
  test(`async permissions and comments on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
