// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
import { EMAIL_CONFIGURATION_CASES } from "./testing/email_configuration_cases.ts";
for (const testCase of EMAIL_CONFIGURATION_CASES) {
  test(`stored email configuration on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
