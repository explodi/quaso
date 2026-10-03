// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { STRING_DETAIL_CASES } from "./testing/string_detail_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of STRING_DETAIL_CASES) {
  test(`async string detail on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
