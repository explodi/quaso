// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { SQL_CASES } from "./testing/sql_cases.ts";

for (const testCase of SQL_CASES) {
  test(`SyncSql on node:sqlite: ${testCase.name}`, async () => {
    const opened: { close(): void }[] = [];
    try {
      await testCase.run(() => {
        const database = openNodeSqlite(":memory:");
        opened.push(database);
        return database.sql;
      });
    } finally {
      for (const database of opened) database.close();
    }
  });
}

test("SyncSql on node:sqlite refuses an asynchronous transaction function", () => {
  const { sql, close } = openNodeSqlite(":memory:");
  try {
    sql.script("CREATE TABLE t (x INTEGER) STRICT");
    expect(() =>
      sql.transaction(() => Promise.resolve(sql.run("INSERT INTO t VALUES (1)"))),
    ).toThrow(
      expect.objectContaining({
        constructor: TypeError,
        message: expect.stringContaining("synchronous"),
      }),
    );
    expect(sql.query("SELECT COUNT(*) AS n FROM t")).toStrictEqual([{ n: 0 }]);
  } finally {
    close();
  }
});

test("SyncSql on node:sqlite binds integers as INTEGER and other numbers as REAL", () => {
  const { sql, close } = openNodeSqlite(":memory:");
  try {
    expect(
      sql.query("SELECT typeof(?) AS a, typeof(?) AS b, typeof(?) AS c", 1, 1.5, 2n),
    ).toStrictEqual([{ a: "integer", b: "real", c: "integer" }]);
  } finally {
    close();
  }
});

test("SyncSql on node:sqlite refuses whole numbers too large to read back", () => {
  const { sql, close } = openNodeSqlite(":memory:");
  try {
    sql.script("CREATE TABLE t (a INTEGER) STRICT");
    for (const value of [2 ** 53, 9007199254740993, 1e18, -(2 ** 53), 2 ** 63]) {
      expect(() => sql.run("INSERT INTO t VALUES (?)", value)).toThrow(
        expect.objectContaining({
          constructor: RangeError,
          message: expect.stringContaining("too large"),
        }),
      );
    }
    sql.run("INSERT INTO t VALUES (?)", Number.MAX_SAFE_INTEGER);
    expect(sql.query("SELECT a FROM t")).toStrictEqual([{ a: Number.MAX_SAFE_INTEGER }]);
  } finally {
    close();
  }
});

test("SyncSql on node:sqlite sees a table's new columns after a script changes it", () => {
  const { sql, close } = openNodeSqlite(":memory:");
  try {
    sql.script("CREATE TABLE t (a INTEGER) STRICT; INSERT INTO t VALUES (1)");
    expect(sql.query("SELECT * FROM t")).toStrictEqual([{ a: 1 }]);
    sql.script("ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT 'x'");
    expect(sql.query("SELECT * FROM t")).toStrictEqual([{ a: 1, b: "x" }]);
  } finally {
    close();
  }
});

test("SyncSql on node:sqlite uses WAL mode and foreign keys for files", async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  const { sql, close } = openNodeSqlite(`${folder}/test.sqlite`);
  try {
    expect(sql.query("PRAGMA journal_mode")).toStrictEqual([{ journal_mode: "wal" }]);
    expect(sql.query("PRAGMA foreign_keys")).toStrictEqual([{ foreign_keys: 1 }]);
  } finally {
    close();
    await fs.rm(folder, { recursive: true });
  }
});
