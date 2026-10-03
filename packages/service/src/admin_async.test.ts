// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { getAdminInfoAsync } from "./admin.ts";
import { SYSTEM } from "./api.ts";
import { check } from "./testing/assert.ts";
import { ADMIN_CASES } from "./testing/admin_cases.ts";
import { initializeUploadSql } from "./testing/upload_cases.ts";

for (const testCase of ADMIN_CASES) {
  test(`async admin on SQLite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeUploadSql(opened.sql);
      await testCase.run(opened.sql);
    } finally {
      opened.close();
    }
  });
}

test("async admin falls back to SQLite page size when the host cannot report it", async () => {
  const opened = openAsyncSqlite(":memory:");
  try {
    await initializeUploadSql(opened.sql);
    const info = await getAdminInfoAsync(
      opened.sql,
      SYSTEM,
      {
        version: "test",
        setup: "local",
        startedAt: 0,
        provider: null,
        databaseSize() {
          throw new Error("Unknown size");
        },
      },
      "test",
      0,
    );
    check(info.database.sizeBytes !== null && info.database.sizeBytes > 0);
  } finally {
    opened.close();
  }
});
