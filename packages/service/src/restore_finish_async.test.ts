// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { RESTORE_FINISH_CASES } from "./testing/restore_finish_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of RESTORE_FINISH_CASES) {
  test(`async restore completion on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
