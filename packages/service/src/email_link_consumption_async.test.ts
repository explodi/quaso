// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { EMAIL_LINK_CONSUMPTION_CASES } from "./testing/email_link_consumption_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of EMAIL_LINK_CONSUMPTION_CASES) {
  test(`async email link consumption on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
