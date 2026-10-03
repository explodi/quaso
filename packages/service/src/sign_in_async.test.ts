// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { SIGN_IN_CASES } from "./testing/sign_in_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of SIGN_IN_CASES) {
  test(`async sign-in on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
