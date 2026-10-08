// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { migrate, schemaVersion } from "./migrate.ts";
import { DATABASE_VERSION, type Migration } from "./migrations.ts";

const FAKE: Migration[] = [
  {
    version: 1,
    name: "meta and notes",
    sql: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT;`,
  },
  {
    version: 2,
    name: "note authors",
    sql: `ALTER TABLE notes ADD COLUMN author TEXT NOT NULL DEFAULT 'nobody';`,
  },
];

function withDatabase(fn: (sql: ReturnType<typeof openNodeSqlite>["sql"]) => Promise<void>) {
  return async () => {
    const database = openNodeSqlite(":memory:");
    try {
      await fn(database.sql);
    } finally {
      database.close();
    }
  };
}

test(
  "migrate creates a new database at the latest version without beforeMigrate",
  withDatabase(async (sql) => {
    const calls: [number, number][] = [];
    const result = await migrate(sql, {
      migrations: FAKE,
      beforeMigrate: (from, to) => void calls.push([from, to]),
    });
    assertEquals(result, { from: 0, to: 2, created: true });
    assertEquals(calls, []);
    assertEquals(schemaVersion(sql), 2);
    sql.run("INSERT INTO notes (text) VALUES ('hi')");
    assertEquals(sql.query("SELECT text, author FROM notes"), [{ text: "hi", author: "nobody" }]);
  }),
);

test(
  "migrate calls beforeMigrate before migrating an older database, and keeps its data",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: FAKE.slice(0, 1) });
    sql.run("INSERT INTO notes (text) VALUES ('kept')");
    const calls: [number, number, number][] = [];
    const result = await migrate(sql, {
      migrations: FAKE,
      beforeMigrate: (from, to) => void calls.push([from, to, schemaVersion(sql)]),
    });
    assertEquals(result, { from: 1, to: 2, created: false });
    assertEquals(calls, [[1, 2, 1]], "called before migrating");
    assertEquals(sql.query("SELECT text, author FROM notes"), [{ text: "kept", author: "nobody" }]);
  }),
);

test(
  "migrate does nothing on a current database",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: FAKE });
    let called = false;
    const result = await migrate(sql, {
      migrations: FAKE,
      beforeMigrate: () => void (called = true),
    });
    assertEquals(result, { from: 2, to: 2, created: false });
    assertEquals(called, false);
  }),
);

test(
  "migrate refuses a database newer than the code",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: FAKE });
    await assertRejects(
      () => migrate(sql, { migrations: FAKE.slice(0, 1) }),
      Error,
      "schema version 2",
    );
  }),
);

test(
  "a failing migration rolls back and leaves the version as it was",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: FAKE.slice(0, 1) });
    const broken: Migration[] = [
      FAKE[0],
      { version: 2, name: "broken", sql: "CREATE TABLE extra (x INTEGER); SELECT * FROM missing;" },
    ];
    await assertRejects(() => migrate(sql, { migrations: broken }));
    assertEquals(schemaVersion(sql), 1);
    assertEquals(
      sql.query("SELECT name FROM sqlite_master WHERE name = 'extra'"),
      [],
      "the migration's first statement was rolled back",
    );
  }),
);

test(
  "migrate refuses migrations out of order",
  withDatabase(async (sql) => {
    await assertRejects(() => migrate(sql, { migrations: [FAKE[1]] }), Error, "version 2, not 1");
  }),
);

test(
  "the real migrations create the schema",
  withDatabase(async (sql) => {
    const result = await migrate(sql);
    assertEquals(result, { from: 0, to: DATABASE_VERSION, created: true });
    const tables = sql
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    for (const table of ["meta", "settings", "strings", "translations", "history", "api_tokens"]) {
      assertEquals(tables.includes(table), true, table);
    }
  }),
);
