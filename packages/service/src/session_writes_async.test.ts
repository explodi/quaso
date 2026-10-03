// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SESSION_WRITE_CASES } from "./testing/session_writes_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SESSION_WRITE_CASES) {
  test(`async session writes on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
