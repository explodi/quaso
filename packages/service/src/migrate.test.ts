// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { migrate, schemaVersion } from "./migrate.ts";
import { DATABASE_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";

const FAKE: Migration[] = [
  {
    version: 1,
    name: "meta and notes",
    sql: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          INSERT INTO meta (key, value) VALUES ('schema_generation', 'beta-2');
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
    expect(result).toStrictEqual({ from: 0, to: 2, created: true });
    expect(calls).toStrictEqual([]);
    expect(schemaVersion(sql)).toBe(2);
    sql.run("INSERT INTO notes (text) VALUES ('hi')");
    expect(sql.query("SELECT text, author FROM notes")).toStrictEqual([
      { text: "hi", author: "nobody" },
    ]);
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
    expect(result).toStrictEqual({ from: 1, to: 2, created: false });
    expect(calls, "called before migrating").toStrictEqual([[1, 2, 1]]);
    expect(sql.query("SELECT text, author FROM notes")).toStrictEqual([
      { text: "kept", author: "nobody" },
    ]);
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
    expect(result).toStrictEqual({ from: 2, to: 2, created: false });
    expect(called).toBe(false);
  }),
);

test(
  "migrate refuses a database newer than the code",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: FAKE });
    await expect(migrate(sql, { migrations: FAKE.slice(0, 1) })).rejects.toThrow(
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
    await expect(migrate(sql, { migrations: broken })).rejects.toThrow();
    expect(schemaVersion(sql)).toBe(1);
    expect(
      sql.query("SELECT name FROM sqlite_master WHERE name = 'extra'"),
      "the migration's first statement was rolled back",
    ).toStrictEqual([]);
  }),
);

test(
  "migrate refuses migrations out of order",
  withDatabase(async (sql) => {
    await expect(migrate(sql, { migrations: [FAKE[1]] })).rejects.toThrow("version 2, not 1");
  }),
);

test(
  "the real migrations create the schema",
  withDatabase(async (sql) => {
    const result = await migrate(sql);
    expect(result).toStrictEqual({ from: 0, to: DATABASE_VERSION, created: true });
    const tables = sql
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    for (const table of ["meta", "settings", "strings", "translations", "history", "api_tokens"]) {
      expect(tables.includes(table), table).toBe(true);
    }
  }),
);

test(
  "migration 6 keeps a version 5 project's files and adds folder context",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: MIGRATIONS.slice(0, 5) });
    sql.run(
      `INSERT INTO files (path, repo_path, format, context, created_at, updated_at)
       VALUES ('text/menus.json', 'text/menus.json', '{}', 'Menus', 100, 100)`,
    );
    const result = await migrate(sql, { migrations: MIGRATIONS.slice(0, 6) });
    expect(result).toStrictEqual({ from: 5, to: 6, created: false });
    expect(sql.query("SELECT path, context FROM files")).toStrictEqual([
      { path: "text/menus.json", context: "Menus" },
    ]);
    sql.run("INSERT INTO folders (path, context, updated_at) VALUES ('text', 'Game text', 200)");
    expect(sql.query("SELECT path, context FROM folders")).toStrictEqual([
      { path: "text", context: "Game text" },
    ]);
  }),
);

test(
  "migration 7 keeps a version 6 project's strings, which receive no arguments yet",
  withDatabase(async (sql) => {
    await migrate(sql, { migrations: MIGRATIONS.slice(0, 6) });
    sql.run(
      `INSERT INTO files (id, path, repo_path, format, created_at, updated_at)
       VALUES (1, 'feed.json', 'feed.json', '{}', 100, 100)`,
    );
    sql.run(
      `INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash,
       search_text, position, created_at, updated_at)
       VALUES (1, 1, '["posts","joined"]', '["posts","joined"]', 'posts.joined', 'text',
       '"Excited to join {company}!"', 'h', '', 0, 100, 100)`,
    );
    const result = await migrate(sql, { migrations: MIGRATIONS.slice(0, 7) });
    expect(result).toStrictEqual({ from: 6, to: 7, created: false });
    expect(sql.query("SELECT display_key, arguments FROM strings")).toStrictEqual([
      { display_key: "posts.joined", arguments: null },
    ]);
  }),
);
