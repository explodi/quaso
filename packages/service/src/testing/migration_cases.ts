// SPDX-License-Identifier: MIT
import { migrateAsync, schemaVersionAsync } from "../migrate.ts";
import { BATCH_MIGRATIONS, DATABASE_VERSION, type BatchMigration } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

const INITIAL: BatchMigration = {
  version: 1,
  name: "initial",
  statements: [
    { sql: "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT" },
    { sql: "INSERT INTO meta (key, value) VALUES ('schema_generation', 'beta-2')" },
    { sql: "CREATE TABLE migration_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT" },
    { sql: "INSERT INTO migration_items VALUES (1, 'original')" },
  ],
};
const SECOND: BatchMigration = {
  version: 2,
  name: "second",
  statements: [{ sql: "INSERT INTO migration_items VALUES (2, 'second; value')" }],
};

export async function resetMigrationSql(sql: Sql): Promise<void> {
  const tables = BATCH_MIGRATIONS.flatMap((migration) =>
    migration.statements.flatMap((statement) => {
      const name = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/.exec(statement.sql)?.[1];
      return name === undefined ? [] : [name];
    }),
  );
  await sql.migrate([
    { sql: "PRAGMA defer_foreign_keys = ON" },
    { sql: "DROP TABLE IF EXISTS revision_guard" },
    { sql: "DROP TABLE IF EXISTS migration_items" },
    { sql: "DROP TABLE IF EXISTS future_notes" },
    ...tables.reverse().map((table) => ({ sql: `DROP TABLE IF EXISTS ${table}` })),
  ]);
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected migration to fail");
}

export const MIGRATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "a hypothetical second migration extends the fresh Beta 2 schema",
    async run(sql) {
      await migrateAsync(sql);
      const future: BatchMigration = {
        version: 2,
        name: "future notes",
        statements: [
          { sql: "CREATE TABLE future_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT" },
        ],
      };
      checkEqual(await migrateAsync(sql, { migrations: [...BATCH_MIGRATIONS, future] }), {
        from: 1,
        to: 2,
        created: false,
      });
      const [generation, guards] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'schema_generation'" },
        { sql: "SELECT id FROM revision_guard" },
      ]);
      checkEqual([generation, guards], [[{ value: "beta-2" }], [{ id: 1 }]]);
      await sql.commit(0, [{ sql: "INSERT INTO future_notes VALUES (1, 'saved')" }]);
    },
  },
  {
    name: "new databases install the complete schema without a snapshot",
    async run(sql) {
      checkEqual(await schemaVersionAsync(sql), 0);
      const result = await migrateAsync(sql, {
        beforeMigrate: () => {
          throw new Error("A new database needs no snapshot");
        },
      });
      checkEqual(result, { from: 0, to: DATABASE_VERSION, created: true });
      checkEqual(await schemaVersionAsync(sql), DATABASE_VERSION);
      const [rows] = await sql.read([
        {
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('strings', 'users', 'jobs', 'language_requests') ORDER BY name",
        },
      ]);
      checkEqual(rows, [
        { name: "jobs" },
        { name: "language_requests" },
        { name: "strings" },
        { name: "users" },
      ]);
    },
  },
  {
    name: "an upgrade awaits its snapshot before changing the schema",
    async run(sql) {
      await migrateAsync(sql, { migrations: [INITIAL] });
      const snapshots: number[][] = [];
      checkEqual(
        await migrateAsync(sql, {
          migrations: [INITIAL, SECOND],
          beforeMigrate: async (from, to) => {
            checkEqual(await schemaVersionAsync(sql), 1);
            checkEqual(await sql.read([{ sql: "SELECT count(*) AS n FROM migration_items" }]), [
              [{ n: 1 }],
            ]);
            snapshots.push([from, to]);
          },
        }),
        { from: 1, to: 2, created: false },
      );
      checkEqual(snapshots, [[1, 2]]);
      checkEqual(await sql.read([{ sql: "SELECT value FROM migration_items WHERE id = 2" }]), [
        [{ value: "second; value" }],
      ]);
    },
  },
  {
    name: "an unchanged schema performs no migration or snapshot",
    async run(sql) {
      await migrateAsync(sql, { migrations: [INITIAL] });
      checkEqual(
        await migrateAsync(
          {
            ...sql,
            migrate: async () => {
              throw new Error("No migration expected");
            },
          },
          {
            migrations: [INITIAL],
            beforeMigrate: () => {
              throw new Error("No snapshot expected");
            },
          },
        ),
        { from: 1, to: 1, created: false },
      );
    },
  },
  {
    name: "failed migration rolls back its data and version and can resume",
    async run(sql) {
      const error = await rejected(() =>
        migrateAsync(sql, {
          migrations: [
            INITIAL,
            {
              ...SECOND,
              statements: [
                ...SECOND.statements,
                { sql: "INSERT INTO migration_items VALUES (1, 'duplicate')" },
              ],
            },
          ],
        }),
      );
      check(error instanceof Error);
      checkEqual(await schemaVersionAsync(sql), 1);
      checkEqual(await sql.read([{ sql: "SELECT * FROM migration_items" }]), [
        [{ id: 1, value: "original" }],
      ]);
      await migrateAsync(sql, { migrations: [INITIAL, SECOND] });
      checkEqual(await schemaVersionAsync(sql), 2);
    },
  },
  {
    name: "a failed snapshot leaves the existing database unchanged",
    async run(sql) {
      await migrateAsync(sql, { migrations: [INITIAL] });
      const failure = new Error("snapshot failed");
      checkEqual(
        await rejected(() =>
          migrateAsync(sql, {
            migrations: [INITIAL, SECOND],
            beforeMigrate: async () => {
              throw failure;
            },
          }),
        ),
        failure,
      );
      checkEqual(await schemaVersionAsync(sql), 1);
      checkEqual(await sql.read([{ sql: "SELECT count(*) AS n FROM migration_items" }]), [
        [{ n: 1 }],
      ]);
    },
  },
  {
    name: "newer databases and nonconsecutive migrations are refused",
    async run(sql) {
      await migrateAsync(sql, { migrations: [INITIAL, SECOND] });
      const newer = await rejected(() => migrateAsync(sql, { migrations: [INITIAL] }));
      check(newer instanceof Error && newer.message.includes("Upgrade Quaso"));
      const unordered = await rejected(() => migrateAsync(sql, { migrations: [SECOND] }));
      check(unordered instanceof Error && unordered.message.includes("not 1"));
      checkEqual(await schemaVersionAsync(sql), 2);
    },
  },
];
