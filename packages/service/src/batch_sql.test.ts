// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@quaso/runtime/assert";
import { openAsyncSqlite } from "./adapters/node_async_sqlite.ts";
import { BATCH_SQL_CASES, initializeBatchSql } from "./testing/batch_sql_cases.ts";
import { RevisionConflict, withRetries } from "./write.ts";
import { ServiceError } from "./errors.ts";

for (const testCase of BATCH_SQL_CASES) {
  test(`Sql on node:sqlite: ${testCase.name}`, async () => {
    const opened = openAsyncSqlite(":memory:");
    try {
      await initializeBatchSql(opened.sql);
      await testCase.run(async () => opened.sql);
    } finally {
      opened.close();
    }
  });
}

test("withRetries stops after four conflicts and reports 503", async () => {
  let attempts = 0;
  const error = await assertRejects(
    () =>
      withRetries(
        {
          read: async () => [],
          migrate: async () => {},
          commit: async () => {
            attempts++;
            throw new RevisionConflict();
          },
        },
        async () => ({ revision: 0, state: null }),
        () => ({ statements: [{ sql: "unused" }], result: null }),
      ),
    ServiceError,
  );
  assertEquals(attempts, 4);
  assertEquals(error.status, 503);
});

test("withRetries returns a no-op without committing", async () => {
  let commits = 0;
  const result = await withRetries(
    { read: async () => [], migrate: async () => {}, commit: async () => ++commits },
    async () => ({ revision: 0, state: "unchanged" }),
    (state) => ({ statements: [], result: state }),
  );
  assertEquals(result, "unchanged");
  assertEquals(commits, 0);
});

test("withRetries propagates write failures without retrying", async () => {
  let attempts = 0;
  const failure = new Error("constraint failure");
  const error = await assertRejects(
    () =>
      withRetries(
        {
          read: async () => [],
          migrate: async () => {},
          commit: async () => {
            attempts++;
            throw failure;
          },
        },
        async () => ({ revision: 0, state: null }),
        () => ({ statements: [{ sql: "unused" }], result: null }),
      ),
    Error,
  );
  assertEquals(error, failure);
  assertEquals(attempts, 1);
});
