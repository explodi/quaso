// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
import { INSTANCE_SECRETS_CASES } from "./testing/instance_secrets_cases.ts";
for (const testCase of INSTANCE_SECRETS_CASES) {
  test(`instance credentials on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
