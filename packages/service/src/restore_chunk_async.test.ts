// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { RESTORE_CHUNK_CASES } from "./testing/restore_chunk_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of RESTORE_CHUNK_CASES) {
  test(`async restore chunk on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
