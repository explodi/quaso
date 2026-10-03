// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { JOB_TRANSITION_CASES } from "./testing/job_transition_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of JOB_TRANSITION_CASES) {
  test(`async job transitions on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
