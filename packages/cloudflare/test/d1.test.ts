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

  it("a batch that answers more than a mebibyte is logged with its statement, never its parameters", async () => {
    const { records, log } = recorded();
    const response = await handleD1(batch([{ sql: MEBIBYTE, params: ["label"] }]), database, log);
    expect(response.status).toBe(200);
    expect(records).toStrictEqual([
      {
        level: "warn",
        msg: "A database batch was slow or large",
        ms: expect.any(Number),
        bytes: expect.any(Number),
        statements: 1,
        rowsRead: expect.any(Number),
        sql: MEBIBYTE,
      },
    ]);
  });

  it("a small, quick batch is not logged", async () => {
    const { records, log } = recorded();
    await handleD1(batch([{ sql: "SELECT 1 AS n", params: [] }]), database, log);
    expect(records).toStrictEqual([]);
  });

  it("a failed batch answers unavailable and is logged with its first statement", async () => {
    const { records, log } = recorded();
    const response = await handleD1(
      batch([{ sql: "SELECT * FROM no_such_table", params: [] }]),
      database,
      log,
    );
    expect(response.status).toBe(503);
    expect(records).toStrictEqual([
      {
        level: "error",
        msg: "A database batch failed",
        error: expect.any(Error),
        ms: expect.any(Number),
        statements: 1,
        sql: "SELECT * FROM no_such_table",
      },
    ]);
  });
});

/** 20,000 rows of about 90 bytes each. */
const MEBIBYTE =
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) SELECT printf('%060d', i) AS filler, ? AS label FROM n";

function batch(statements: { sql: string; params: unknown[] }[]): Request {
  return new Request("http://d1.quaso.internal/batch", {
    method: "POST",
    body: JSON.stringify({ statements }),
  });
}

/** A logger that keeps its records. */
function recorded() {
  const records: Record<string, unknown>[] = [];
  const keep =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      records.push({ level, msg, ...fields });
    };
  const log = {
    debug: keep("debug"),
    info: keep("info"),
    warn: keep("warn"),
    error: keep("error"),
  };
  return { records, log };
}
