// SPDX-License-Identifier: MIT
/**
 * The contract of the `SyncSql` port (design §3, §8 Testing), as test cases that run against
 * every implementation: `node:sqlite` here (`sql.test.ts`), and Durable Object SQLite in
 * `workerd` (Sprint 3). They use only the `SyncSql` interface and plain assertions, so this
 * file runs anywhere.
 */
import { type SyncSql, SQL_MAX_PARAMS } from "../ports.ts";
import { check, checkEqual, checkThrows } from "./assert.ts";

export interface SqlCase {
  name: string;
  /** Runs the case against a new, empty database from `makeSql`. */
  run(makeSql: () => SyncSql | Promise<SyncSql>): void | Promise<void>;
}

const TABLE = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, size INTEGER) STRICT";

class Expected extends Error {}

export const SQL_CASES: readonly SqlCase[] = [
  {
    name: "query returns rows as plain objects by column name",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      sql.run("INSERT INTO items (name, size) VALUES (?, ?)", "apple", 3);
      sql.run("INSERT INTO items (name, size) VALUES (?, ?)", "pear", 5);
      const rows = sql.query("SELECT id, name, size FROM items ORDER BY id");
      checkEqual(rows, [
        { id: 1, name: "apple", size: 3 },
        { id: 2, name: "pear", size: 5 },
      ]);
      checkEqual(Object.getPrototypeOf(rows[0]), Object.prototype, "a plain object");
      checkEqual(sql.query("SELECT name AS label FROM items WHERE size > ?", 4), [
        { label: "pear" },
      ]);
    },
  },
  {
    name: "query returns an empty list when nothing matches, and for writes",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      checkEqual(sql.query("SELECT * FROM items"), []);
      checkEqual(sql.query("INSERT INTO items (name) VALUES (?)", "x"), []);
    },
  },
  {
    name: "run writes and ignores rows",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      sql.run("INSERT INTO items (name, size) VALUES (?, ?)", "a", 1);
      sql.run("UPDATE items SET size = size + ? WHERE name = ?", 10, "a");
      checkEqual(sql.query("SELECT size FROM items"), [{ size: 11 }]);
      sql.run("DELETE FROM items");
      checkEqual(sql.query("SELECT COUNT(*) AS n FROM items"), [{ n: 0 }]);
    },
  },
  {
    name: "script runs several statements",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(`
        CREATE TABLE a (x INTEGER) STRICT;
        CREATE TABLE b (y TEXT) STRICT;
        INSERT INTO a (x) VALUES (1), (2);
        INSERT INTO b (y) VALUES ('one');
      `);
      checkEqual(sql.query("SELECT x FROM a ORDER BY x"), [{ x: 1 }, { x: 2 }]);
      checkEqual(sql.query("SELECT y FROM b"), [{ y: "one" }]);
    },
  },
  {
    name: "INSERT … RETURNING gives the new rows' IDs",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      checkEqual(sql.query("INSERT INTO items (name) VALUES (?) RETURNING id", "a"), [{ id: 1 }]);
      const rows = sql.query<{ id: number; name: string }>(
        "INSERT INTO items (name) VALUES (?), (?) RETURNING id, name",
        "b",
        "c",
      );
      checkEqual(rows.map((row) => row.id).sort(), [2, 3]);
      checkEqual(rows.map((row) => row.name).sort(), ["b", "c"]);
    },
  },
  {
    name: "a transaction commits its writes and returns the function's value",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      const value = sql.transaction(() => {
        sql.run("INSERT INTO items (name) VALUES (?)", "a");
        sql.run("INSERT INTO items (name) VALUES (?)", "b");
        return sql.query("SELECT COUNT(*) AS n FROM items")[0].n;
      });
      checkEqual(value, 2);
      checkEqual(sql.query("SELECT COUNT(*) AS n FROM items"), [{ n: 2 }]);
    },
  },
  {
    name: "a transaction rolls back when the function throws, and rethrows the error",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      sql.run("INSERT INTO items (name) VALUES (?)", "kept");
      const thrown = new Expected("stop");
      const error = checkThrows(() =>
        sql.transaction(() => {
          sql.run("INSERT INTO items (name) VALUES (?)", "lost");
          sql.run("UPDATE items SET size = 9");
          throw thrown;
        }),
      );
      check(error === thrown, "the same error");
      checkEqual(sql.query("SELECT name, size FROM items"), [{ name: "kept", size: null }]);
    },
  },
  {
    name: "a failing statement rolls the transaction back",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script("CREATE TABLE u (name TEXT UNIQUE) STRICT");
      checkThrows(() =>
        sql.transaction(() => {
          sql.run("INSERT INTO u (name) VALUES (?)", "a");
          sql.run("INSERT INTO u (name) VALUES (?)", "a");
        }),
      );
      checkEqual(sql.query("SELECT * FROM u"), []);
      sql.transaction(() => sql.run("INSERT INTO u (name) VALUES (?)", "b"));
      checkEqual(sql.query("SELECT * FROM u"), [{ name: "b" }]);
    },
  },
  {
    name: "a nested transaction that throws rolls back only its own writes",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      sql.transaction(() => {
        sql.run("INSERT INTO items (name) VALUES (?)", "outer");
        checkThrows(() =>
          sql.transaction(() => {
            sql.run("INSERT INTO items (name) VALUES (?)", "inner");
            throw new Expected("inner");
          }),
        );
        sql.run("INSERT INTO items (name) VALUES (?)", "after");
      });
      checkEqual(sql.query("SELECT name FROM items ORDER BY id"), [
        { name: "outer" },
        { name: "after" },
      ]);
    },
  },
  {
    name: "nested transactions commit with the outer one, three levels deep",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      const result = sql.transaction(() => {
        sql.run("INSERT INTO items (name) VALUES (?)", "1");
        return sql.transaction(() => {
          sql.run("INSERT INTO items (name) VALUES (?)", "2");
          return sql.transaction(() => {
            sql.run("INSERT INTO items (name) VALUES (?)", "3");
            return "deep";
          });
        });
      });
      checkEqual(result, "deep");
      checkEqual(sql.query("SELECT COUNT(*) AS n FROM items"), [{ n: 3 }]);
    },
  },
  {
    name: "an outer transaction that throws rolls back its nested ones too",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      checkThrows(() =>
        sql.transaction(() => {
          sql.transaction(() => sql.run("INSERT INTO items (name) VALUES (?)", "inner"));
          throw new Expected("outer");
        }),
      );
      checkEqual(sql.query("SELECT COUNT(*) AS n FROM items"), [{ n: 0 }]);
      sql.transaction(() => sql.run("INSERT INTO items (name) VALUES (?)", "later"));
      checkEqual(sql.query("SELECT name FROM items"), [{ name: "later" }]);
    },
  },
  {
    name: `a statement takes ${SQL_MAX_PARAMS} bound parameters`,
    async run(makeSql) {
      const sql = await makeSql();
      sql.script("CREATE TABLE n (v INTEGER) STRICT");
      const values = Array.from({ length: SQL_MAX_PARAMS }, (_, i) => i + 1);
      const marks = values.map(() => "(?)").join(", ");
      sql.run(`INSERT INTO n (v) VALUES ${marks}`, ...values);
      const inList = values.map(() => "?").join(", ");
      const rows = sql.query(`SELECT SUM(v) AS total FROM n WHERE v IN (${inList})`, ...values);
      checkEqual(rows, [{ total: (SQL_MAX_PARAMS * (SQL_MAX_PARAMS + 1)) / 2 }]);
    },
  },
  {
    name: "NULL, integers, reals and text round-trip",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script("CREATE TABLE v (i INTEGER, r REAL, t TEXT, a ANY) STRICT");
      sql.run("INSERT INTO v VALUES (?, ?, ?, ?)", null, null, null, null);
      sql.run("INSERT INTO v VALUES (?, ?, ?, ?)", 0, 0.5, "", 7);
      sql.run("INSERT INTO v VALUES (?, ?, ?, ?)", -42, -1.25, "text", "any");
      sql.run("INSERT INTO v VALUES (?, ?, ?, ?)", Number.MAX_SAFE_INTEGER, 1e300, "0", 2.5);
      checkEqual(sql.query("SELECT i, r, t, a FROM v ORDER BY rowid"), [
        { i: null, r: null, t: null, a: null },
        { i: 0, r: 0.5, t: "", a: 7 },
        { i: -42, r: -1.25, t: "text", a: "any" },
        { i: Number.MAX_SAFE_INTEGER, r: 1e300, t: "0", a: 2.5 },
      ]);
      checkEqual(sql.query("SELECT ? IS NULL AS n", null), [{ n: 1 }]);
    },
  },
  {
    name: "Unicode text round-trips, and compares as bytes",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script("CREATE TABLE s (t TEXT) STRICT");
      const texts = [
        "Zażółć gęślą jaźń",
        "日本語のテキスト",
        "مرحبا بالعالم",
        "é and é",
        "🎮 👩🏽‍💻 🏳️‍🌈",
        "line\nbreak\r\n\ttab",
        "quote ' and \" and \\",
        "  ﻿",
      ];
      for (const text of texts) sql.run("INSERT INTO s (t) VALUES (?)", text);
      checkEqual(
        sql.query("SELECT t FROM s ORDER BY rowid").map((row) => row.t),
        texts,
      );
      checkEqual(sql.query("SELECT t FROM s WHERE t = ?", "🎮 👩🏽‍💻 🏳️‍🌈").length, 1);
      checkEqual(sql.query("SELECT t FROM s WHERE t = ?", "é and é").length, 0);
      checkEqual(sql.query("SELECT length(?) AS n", "日本語"), [{ n: 3 }]);
    },
  },
  {
    name: "blobs come back as Uint8Array",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script("CREATE TABLE b (data BLOB) STRICT");
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      sql.run("INSERT INTO b (data) VALUES (?)", bytes);
      const [row] = sql.query("SELECT data FROM b");
      check(row.data instanceof Uint8Array, "a Uint8Array");
      checkEqual(row.data, bytes);
    },
  },
  {
    name: "LIKE with an ESCAPE clause finds % and _ literally",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(TABLE);
      for (const name of ["100% sure", "100 sure", "a_b", "axb"]) {
        sql.run("INSERT INTO items (name) VALUES (?)", name);
      }
      const like = (pattern: string) =>
        sql
          .query("SELECT name FROM items WHERE name LIKE ? ESCAPE '\\' ORDER BY id", pattern)
          .map((row) => row.name);
      checkEqual(like("%0\\%%"), ["100% sure"]);
      checkEqual(like("%\\_%"), ["a_b"]);
    },
  },
  {
    name: "instr finds a long, non-ASCII substring, with % and _ as themselves",
    async run(makeSql) {
      // Search uses instr(), not LIKE: Durable Objects refuse LIKE and GLOB patterns over
      // 50 bytes, and a search may be 200 characters long.
      const sql = await makeSql();
      sql.script(TABLE);
      const long = "你好，旅行者。".repeat(40);
      for (const name of [long, "100% sure", "a_b\\c"]) {
        sql.run("INSERT INTO items (name) VALUES (?)", name);
      }
      const find = (text: string) =>
        sql
          .query("SELECT id FROM items WHERE instr(name, ?) > 0 ORDER BY id", text)
          .map((row) => row.id);
      checkEqual(find(long.slice(3, 203)), [1]);
      checkEqual(find("%"), [2]);
      checkEqual(find("_b\\"), [3]);
      checkEqual(find("_".repeat(300)), []);
    },
  },
  {
    name: "upserts and foreign keys work",
    async run(makeSql) {
      const sql = await makeSql();
      sql.script(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT;
        CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
      `);
      sql.run("INSERT INTO kv (k, v) VALUES (?, ?)", "a", "1");
      sql.run(
        "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
        "a",
        "2",
      );
      checkEqual(sql.query("SELECT k, v FROM kv"), [{ k: "a", v: "2" }]);
      checkThrows(() => sql.run("INSERT INTO child (parent_id) VALUES (?)", 99), "a foreign key");
    },
  },
];
