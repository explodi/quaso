// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { STARTUP_CASES } from "./testing/startup_cases.ts";

for (const testCase of STARTUP_CASES) {
  test(`async database startup on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
