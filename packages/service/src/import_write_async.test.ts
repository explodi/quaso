// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { IMPORT_WRITE_CASES } from "./testing/import_write_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of IMPORT_WRITE_CASES) {
  test(`async translation import on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
