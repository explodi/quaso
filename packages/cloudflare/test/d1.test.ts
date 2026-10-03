// SPDX-License-Identifier: MIT
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { BATCH_SQL_CASES, initializeBatchSql } from "../../service/src/testing/batch_sql_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";

const database = (env as unknown as { TEST_D1: D1Database }).TEST_D1;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), database) });

describe("D1 private handler and SQL contract", () => {
  beforeEach(async () => {
    await sql.migrate([
      { sql: "DROP TABLE IF EXISTS items" },
      { sql: "DROP TABLE IF EXISTS revision_guard" },
      { sql: "DROP TABLE IF EXISTS meta" },
      { sql: "DROP TABLE IF EXISTS extra" },
    ]);
    await initializeBatchSql(sql);
  });
  for (const testCase of BATCH_SQL_CASES) {
    it(testCase.name, () => testCase.run(async () => sql));
  }

  it("accepts CTE reads and refuses attempts to change query_only", async () => {
    expect(await sql.read([{ sql: "WITH n AS (SELECT 3 AS value) SELECT value FROM n;" }])).toEqual(
      [[{ value: 3 }]],
    );
    await expect(sql.read([{ sql: "PRAGMA query_only = OFF" }])).rejects.toThrow();
  });

  it("binds exact bigints and Uint8Array views", async () => {
    expect(
      await sql.read([
        {
          sql: "SELECT ? + 1 AS n, ? AS bytes",
          params: [41n, new Uint8Array([9, 1, 2, 9]).subarray(1, 3)],
        },
      ]),
    ).toEqual([[{ n: 42, bytes: new Uint8Array([1, 2]) }]]);
  });

  it("the handler has no GET or public path", async () => {
    expect((await handleD1(new Request("http://d1.quaso.internal/batch"), database)).status).toBe(
      404,
    );
    expect(
      (await handleD1(new Request("http://d1.quaso.internal/", { method: "POST" }), database))
        .status,
    ).toBe(404);
  });

  it("malformed batches are rejected", async () => {
    const response = await handleD1(
      new Request("http://d1.quaso.internal/batch", {
        method: "POST",
        body: '{"statements":[null]}',
      }),
      database,
    );
    expect(response.status).toBe(400);
  });
});
