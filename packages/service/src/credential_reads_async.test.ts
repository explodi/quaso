// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { CREDENTIAL_READ_CASES } from "./testing/credential_reads_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of CREDENTIAL_READ_CASES) {
  test(`async credential reads on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
