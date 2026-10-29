// SPDX-License-Identifier: MIT
import { test } from "vitest";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { ICU_CONVERSION_CASES } from "./testing/icu_conversion_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of ICU_CONVERSION_CASES) {
  test(`ICU conversion on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
