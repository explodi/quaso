// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { TRANSLATION_EDIT_CASES } from "./testing/translation_edit_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of TRANSLATION_EDIT_CASES) {
  test(`async translation edits on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
