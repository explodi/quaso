// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SETTINGS_WRITE_CASES } from "./testing/settings_writes_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SETTINGS_WRITE_CASES) {
  test(`async settings writes on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
