// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { EMAIL_TOKEN_CREATION_CASES } from "./testing/email_token_creation_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of EMAIL_TOKEN_CREATION_CASES) {
  test(`async email token creation on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
