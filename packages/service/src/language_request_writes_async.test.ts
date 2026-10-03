// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { LANGUAGE_REQUEST_WRITE_CASES } from "./testing/language_request_writes_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of LANGUAGE_REQUEST_WRITE_CASES) {
  test(`async language request writes on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
