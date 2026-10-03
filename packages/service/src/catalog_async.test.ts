// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { CATALOG_CASES } from "./testing/catalog_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of CATALOG_CASES) {
  test(`async glossary and export on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
