// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { IDENTITY_SIGN_IN_CASES } from "./testing/identity_sign_in_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of IDENTITY_SIGN_IN_CASES) {
  test(`async provider sign-in on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
