// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SUGGESTION_WITHDRAWAL_CASES } from "./testing/suggestion_withdrawal_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SUGGESTION_WITHDRAWAL_CASES) {
  test(`async suggestion withdrawal on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
