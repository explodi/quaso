// SPDX-License-Identifier: MIT
import type { Sql } from "../ports.ts";
import { GUARD_STATEMENTS, RevisionConflict, withRetries } from "../write.ts";
import { check, checkEqual } from "./assert.ts";

export async function initializeBatchSql(sql: Sql): Promise<void> {
  await sql.migrate([
    { sql: "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT" },
    ...GUARD_STATEMENTS,
    {
      sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, bytes BLOB) STRICT",
    },
  ]);
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error) => error,
  );
}

export const BATCH_SQL_CASES: {
  name: string;
  run(makeSql: () => Promise<Sql>): Promise<void>;
}[] = [
  {
    name: "batches return parameterized rows and blobs",
    async run(makeSql) {
      const sql = await makeSql();
      checkEqual(
        await sql.commit(0, [
          {
            sql: "INSERT INTO items VALUES (?, ?, ?)",
            params: [1, "apple", new Uint8Array([1, 2])],
          },
        ]),
        1,
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT name, bytes FROM items WHERE id = ?", params: [1] },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ name: "apple", bytes: new Uint8Array([1, 2]) }], [{ value: "1" }]],
      );
    },
  },
  {
    name: "a stale revision rejects the entire batch",
    async run(makeSql) {
      const sql = await makeSql();
      await sql.commit(0, [{ sql: "INSERT INTO items (name) VALUES ('first')" }]);
      check(
        (await rejected(
          sql.commit(0, [{ sql: "INSERT INTO items (name) VALUES ('stale')" }]),
        )) instanceof RevisionConflict,
      );
      checkEqual(await sql.read([{ sql: "SELECT name FROM items" }]), [[{ name: "first" }]]);
    },
  },
  {
    name: "a failing statement rolls back earlier writes and the revision",
    async run(makeSql) {
      const sql = await makeSql();
      await rejected(
        sql.commit(0, [
          { sql: "INSERT INTO items (name) VALUES ('duplicate')" },
          { sql: "INSERT INTO items (name) VALUES ('duplicate')" },
        ]),
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT name FROM items" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[], []],
      );
      checkEqual(await sql.commit(0, [{ sql: "INSERT INTO items (name) VALUES ('valid')" }]), 1);
    },
  },
  {
    name: "overlapping operations retry from fresh state",
    async run(makeSql) {
      const sql = await makeSql();
      const read = async () => {
        const [rows] = await sql.read([
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
        ]);
        return { revision: Number(rows[0].revision), state: Number(rows[0].revision) };
      };
      const first = withRetries(sql, read, (state) => ({
        statements: [{ sql: "INSERT INTO items (name) VALUES (?)", params: [`value-${state}`] }],
        result: state,
      }));
      const second = withRetries(sql, read, (state) => ({
        statements: [{ sql: "INSERT INTO items (name) VALUES (?)", params: [`value-${state}`] }],
        result: state,
      }));
      checkEqual((await Promise.all([first, second])).sort(), [0, 1]);
      checkEqual(await sql.read([{ sql: "SELECT name FROM items ORDER BY id" }]), [
        [{ name: "value-0" }, { name: "value-1" }],
      ]);
    },
  },
  {
    name: "read batches cannot write",
    async run(makeSql) {
      const sql = await makeSql();
      await rejected(sql.read([{ sql: "INSERT INTO items (name) VALUES ('read write')" }]));
      checkEqual(await sql.read([{ sql: "SELECT name FROM items" }]), [[]]);
      await sql.commit(0, [{ sql: "INSERT INTO items (name) VALUES ('commit')" }]);
    },
  },
  {
    name: "a failing migration rolls back its earlier statements",
    async run(makeSql) {
      const sql = await makeSql();
      await rejected(
        sql.migrate([
          { sql: "CREATE TABLE extra (id INTEGER)" },
          { sql: "INSERT INTO missing VALUES (1)" },
        ]),
      );
      checkEqual(await sql.read([{ sql: "SELECT name FROM sqlite_master WHERE name = 'extra'" }]), [
        [],
      ]);
    },
  },
  {
    name: "at most 100 parameters per statement",
    async run(makeSql) {
      const sql = await makeSql();
      const params = Array(100).fill(1);
      checkEqual(
        await sql.read([{ sql: `SELECT ${params.map(() => "?").join(" + ")} AS total`, params }]),
        [[{ total: 100 }]],
      );
      const tooMany = Array(101).fill(1);
      await rejected(
        sql.read([
          { sql: `SELECT ${tooMany.map(() => "?").join(" + ")} AS total`, params: tooMany },
        ]),
      );
    },
  },
];
