// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { JOB_RESULT_CASES } from "./testing/job_result_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";
for (const testCase of JOB_RESULT_CASES) {
  test(`async job results on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
