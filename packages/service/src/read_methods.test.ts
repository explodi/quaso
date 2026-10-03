// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { READ_METHOD_CASES } from "./testing/read_methods_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of READ_METHOD_CASES) {
  test(`async read methods on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
