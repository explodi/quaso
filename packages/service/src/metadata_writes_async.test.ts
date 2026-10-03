// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { METADATA_WRITE_CASES } from "./testing/metadata_writes_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of METADATA_WRITE_CASES) {
  test(`async metadata writes on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
