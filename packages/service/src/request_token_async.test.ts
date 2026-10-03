// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { REQUEST_TOKEN_CASES } from "./testing/request_token_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of REQUEST_TOKEN_CASES) {
  test(`async language requests and keys on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
