// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { ACCOUNT_UPDATE_CASES } from "./testing/account_update_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of ACCOUNT_UPDATE_CASES) {
  test(`async account updates on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
