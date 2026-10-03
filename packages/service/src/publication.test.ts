// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { PUBLICATION_CASES } from "./testing/publication_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of PUBLICATION_CASES) {
  test(`publication lifecycle on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
