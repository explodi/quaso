// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { JOB_CREATION_CASES } from "./testing/job_creation_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of JOB_CREATION_CASES) {
  test(`async job creation on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
