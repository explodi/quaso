// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SETUP_WRITES_CASES } from "./testing/setup_writes_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SETUP_WRITES_CASES) {
  test(`async setup on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
