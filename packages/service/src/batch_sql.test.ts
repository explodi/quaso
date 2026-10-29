// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  const error = await withRetries(
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
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(attempts).toBe(4);
  expect(error.status).toBe(503);
});

test("withRetries returns a no-op without committing", async () => {
  let commits = 0;
  const result = await withRetries(
    { read: async () => [], migrate: async () => {}, commit: async () => ++commits },
    async () => ({ revision: 0, state: "unchanged" }),
    (state) => ({ statements: [], result: state }),
  );
  expect(result).toBe("unchanged");
  expect(commits).toBe(0);
});

test("withRetries propagates write failures without retrying", async () => {
  let attempts = 0;
  const failure = new Error("constraint failure");
  const error = await withRetries(
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
  ).catch((error: unknown) => error);
  assert(error instanceof Error);
  expect(error).toStrictEqual(failure);
  expect(attempts).toBe(1);
});
