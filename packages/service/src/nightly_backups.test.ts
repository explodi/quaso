// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { createMemoryStore } from "./adapters/memory_store.ts";
import { NIGHTLY_BACKUP_CASES } from "./testing/nightly_backup_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of NIGHTLY_BACKUP_CASES) {
  test(`nightly backups on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql, createMemoryStore());
    } finally {
      opened.close();
    }
  });
}
