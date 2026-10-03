// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { RESTORE_START_CASES } from "./testing/restore_start_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of RESTORE_START_CASES) {
  test(`async restore startup on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
