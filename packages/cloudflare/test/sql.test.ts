// SPDX-License-Identifier: MIT
/**
 * The `SyncSql` port's shared cases (the same ones `node:sqlite` passes in Bun) against
 * Durable Object SQLite, each in a new object; then what the service relies on beyond them.
 */
import { runInDurableObject } from "cloudflare:test";
import { SQL_CASES } from "@quaso/service/sql-cases";
import { describe, expect, it } from "vitest";
import { createDurableObjectSql } from "../src/do_sql.ts";
import { freshObject } from "./env.ts";

describe("the SyncSql port's shared cases", () => {
  for (const testCase of SQL_CASES) {
    it(testCase.name, async () => {
      await runInDurableObject(freshObject(), async (_object, state) => {
        await testCase.run(() => createDurableObjectSql(state.storage));
      });
    });
  }
});

describe("Durable Object SQLite, beyond the shared cases", () => {
  it("reads sqlite_master, as the migration runner does", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      sql.script("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
      expect(
        sql.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"),
      ).toEqual([{ name: "meta" }]);
    });
  });

  it("has total_changes(), which rises with every write, as the status cache needs", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      sql.script("CREATE TABLE t (x INTEGER) STRICT");
      const changes = () => sql.query<{ n: number }>("SELECT total_changes() AS n")[0].n;
      const before = changes();
      sql.run("INSERT INTO t (x) VALUES (?)", 1);
      expect(changes()).toBe(before + 1);
      expect(() =>
        sql.transaction(() => {
          sql.run("INSERT INTO t (x) VALUES (?)", 2);
          throw new Error("roll back");
        }),
      ).toThrow("roll back");
      expect(changes()).toBe(before + 2);
      expect(sql.query("SELECT x FROM t")).toEqual([{ x: 1 }]);
    });
  });

  it("refuses LIKE and GLOB patterns over 50 bytes, which is why search uses instr()", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      expect(sql.query("SELECT 'xyz' LIKE ? AS m", "%".repeat(50))).toEqual([{ m: 1 }]);
      expect(() => sql.query("SELECT 'xyz' LIKE ?", "%".repeat(51))).toThrow(/too complex/);
      expect(() => sql.query("SELECT 'xyz' GLOB ?", "*".repeat(51))).toThrow(/too complex/);
      expect(
        sql.query("SELECT instr(?, ?) AS at", "ab" + "你".repeat(300), "你".repeat(200)),
      ).toEqual([{ at: 3 }]);
    });
  });

  it("binds numbers as REAL, which STRICT INTEGER columns store as integers", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      sql.script("CREATE TABLE t (i INTEGER, a ANY) STRICT");
      sql.run("INSERT INTO t (i, a) VALUES (?, ?)", 7, 7);
      expect(sql.query("SELECT typeof(i) AS i, typeof(a) AS a FROM t")).toEqual([
        { i: "integer", a: "real" },
      ]);
      // So SQL must not depend on a bound number's type (design §5.3): here it shows.
      expect(sql.query("SELECT ? || '' AS text", 7)).toEqual([{ text: "7.0" }]);
    });
  });

  it("takes exact bigints as numbers, and refuses others", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      expect(sql.query("SELECT ? + 1 AS n", 41n)).toEqual([{ n: 42 }]);
      expect(() => sql.query("SELECT ?", 2n ** 60n)).toThrow(RangeError);
    });
  });

  it("binds a Uint8Array view as its own bytes", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      const whole = new Uint8Array([9, 1, 2, 3, 9]);
      const [row] = sql.query("SELECT ? AS b", whole.subarray(1, 4));
      expect(row.b).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  it("refuses an async function in a transaction", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      expect(() => sql.transaction(() => Promise.resolve(1))).toThrow(TypeError);
    });
  });

  it("refuses BEGIN and SAVEPOINT, which the service never writes", async () => {
    await runInDurableObject(freshObject(), (_object, state) => {
      const sql = createDurableObjectSql(state.storage);
      expect(() => sql.run("BEGIN")).toThrow();
      expect(() => sql.run("SAVEPOINT x")).toThrow();
    });
  });
});
