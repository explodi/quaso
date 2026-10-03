// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { MIGRATION_CASES } from "./testing/migration_cases.ts";

for (const testCase of MIGRATION_CASES) {
  test(`async migrations on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}
