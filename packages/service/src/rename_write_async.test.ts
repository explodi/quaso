// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { RENAME_WRITE_CASES } from "./testing/rename_write_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of RENAME_WRITE_CASES) {
  test(`async key rename on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
