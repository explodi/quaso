// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM } from "../api.ts";
import {
  backupStatePlan,
  restoreRowsAsync,
  unfinishedRestoreFromState,
  type SchemaObject,
} from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

async function marker(sql: Sql) {
  const [objects] = await sql.read([
    {
      sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
    },
  ]);
  const plan = backupStatePlan(objects as SchemaObject[]);
  const [revision, ...rows] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    ...plan.statements,
  ]);
  const state = [...plan.decode(rows, Number(revision[0].revision))]
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  await sql.migrate([
    {
      sql: "INSERT INTO meta (key, value) VALUES ('restore', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      params: [JSON.stringify({ schemaVersion: DATABASE_VERSION, startedAt: 100, state })],
    },
  ]);
}

async function restoreState(sql: Sql) {
  const [objects] = await sql.read([
    {
      sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
    },
  ]);
  const plan = backupStatePlan(objects as SchemaObject[]);
  const [metadata, ...rows] = await sql.read([
    { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision')" },
    ...plan.statements,
  ]);
  const meta = new Map(metadata.map((row) => [String(row.key), String(row.value)]));
  return unfinishedRestoreFromState(
    meta.get("restore") ?? null,
    plan.decode(rows, Number(meta.get("revision") ?? 0)),
  );
}

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

function race(sql: Sql, update: () => Promise<void>): Sql {
  let reads = 0;
  return {
    ...sql,
    async read(statements) {
      const rows = await sql.read(statements);
      if (++reads === 2) await update();
      return rows;
    },
  };
}

export const RESTORE_CHUNK_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "a chunk inserts rows and the exact post-commit resume state atomically",
    async run(sql) {
      await marker(sql);
      checkEqual(
        await restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [
            { id: 1, display_name: "Ada", created_at: 100 },
            { id: 2, display_name: "Bob", created_at: 100 },
          ],
        }),
        { inserted: 2, skipped: 0 },
      );
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
      checkEqual(
        await restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [{ id: 3, display_name: "Cam", created_at: 100 }],
        }),
        { inserted: 1, skipped: 0 },
      );
      const [users, revision] = await sql.read([
        { sql: "SELECT display_name FROM users ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(users, [
        { display_name: "Ada" },
        { display_name: "Bob" },
        { display_name: "Cam" },
      ]);
      checkEqual(revision, [{ value: "2" }]);
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
    },
  },
  {
    name: "metadata preserves destination revision, schema and private values and counts skips",
    async run(sql) {
      await sql.migrate([
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'destination')" },
      ]);
      await marker(sql);
      const result = await restoreRowsAsync(sql, SYSTEM, {
        table: "meta",
        rows: [
          { key: "revision", value: "900" },
          { key: "schema_version", value: "1" },
          { key: "setup_token", value: "source" },
          { key: "restore", value: "wrong" },
          { key: "last_backup", value: "wrong" },
          { key: "custom", value: "restored" },
        ],
      });
      checkEqual(result, { inserted: 1, skipped: 5 });
      const [metadata] = await sql.read([
        {
          sql: "SELECT key, value FROM meta WHERE key IN ('revision', 'schema_version', 'setup_token', 'custom', 'restore')",
        },
      ]);
      const values = new Map(metadata.map((row) => [row.key, row.value]));
      checkEqual(values.get("revision"), "1");
      checkEqual(values.get("schema_version"), String(DATABASE_VERSION));
      checkEqual(values.get("setup_token"), "destination");
      checkEqual(values.get("custom"), "restored");
      checkEqual(JSON.parse(String(values.get("restore"))).skipped, { meta: 5 });
      await restoreRowsAsync(sql, SYSTEM, {
        table: "meta",
        rows: [{ key: "revision", value: "0" }],
      });
      const [markerRows] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'restore'" },
      ]);
      checkEqual(JSON.parse(String(markerRows[0].value)).skipped, { meta: 6 });
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
    },
  },
  {
    name: "secret tables and empty chunks skip commits",
    async run(sql) {
      await marker(sql);
      const noCommit: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(
        await restoreRowsAsync(noCommit, SYSTEM, {
          table: "sessions",
          rows: [{ secret_hash: "secret" }],
        }),
        { inserted: 0, skipped: 1 },
      );
      checkEqual(
        await restoreRowsAsync(noCommit, SYSTEM, {
          table: "email_tokens",
          rows: [{ secret_hash: "secret" }],
        }),
        { inserted: 0, skipped: 1 },
      );
      checkEqual(await restoreRowsAsync(noCommit, SYSTEM, { table: "users", rows: [] }), {
        inserted: 0,
        skipped: 0,
      });
    },
  },
  {
    name: "heterogeneous columns and large chunks stay within the SQL parameter limit",
    async run(sql) {
      await marker(sql);
      const statements: number[] = [];
      const bounded: Sql = {
        ...sql,
        commit: async (revision, batch) => {
          statements.push(...batch.map((statement) => statement.params?.length ?? 0));
          return sql.commit(revision, batch);
        },
      };
      const rows = [
        { id: 1, display_name: "First", created_at: 100 },
        ...Array.from({ length: 101 }, (_, i) => ({
          id: i + 2,
          display_name: `User ${i}`,
          created_at: 100,
          email: null,
        })),
      ];
      checkEqual(await restoreRowsAsync(bounded, SYSTEM, { table: "users", rows }), {
        inserted: 102,
        skipped: 0,
      });
      checkEqual(Math.max(...statements), 100);
      const [counts] = await sql.read([{ sql: "SELECT COUNT(*) AS count FROM users" }]);
      checkEqual(counts, [{ count: 102 }]);
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
    },
  },
  {
    name: "blob rows and WITHOUT ROWID tables retain resumability",
    async run(sql) {
      await sql.migrate([
        { sql: "CREATE TABLE restore_payload (id TEXT PRIMARY KEY, data BLOB) WITHOUT ROWID" },
      ]);
      await marker(sql);
      checkEqual(
        await restoreRowsAsync(sql, SYSTEM, {
          table: "restore_payload",
          rows: [{ id: "blob", data: { $base64: "AAH/" } }],
        }),
        { inserted: 1, skipped: 0 },
      );
      const [rows] = await sql.read([{ sql: "SELECT data FROM restore_payload" }]);
      checkEqual(Array.from(rows[0].data as Uint8Array), [0, 1, 255]);
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
      await sql.migrate([{ sql: "DROP TABLE restore_payload" }]);
    },
  },
  {
    name: "only the system may restore, and a live unchanged restore is required",
    async run(sql) {
      await rejected(
        () => restoreRowsAsync(sql, ANONYMOUS, { table: "users", rows: [] }),
        "forbidden",
      );
      await rejected(
        () => restoreRowsAsync(sql, { type: "user", userId: 1 }, { table: "users", rows: [] }),
        "forbidden",
      );
      await rejected(
        () => restoreRowsAsync(sql, SYSTEM, { table: "users", rows: [] }),
        "bad_request",
      );
      await marker(sql);
      await sql.commit(0, [
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Other write', 100)" },
      ]);
      await rejected(() => restoreRowsAsync(sql, SYSTEM, { table: "users", rows: [] }), "conflict");
    },
  },
  {
    name: "unknown and control tables, empty rows and unsupported values are refused",
    async run(sql) {
      await marker(sql);
      await rejected(
        () => restoreRowsAsync(sql, SYSTEM, { table: "missing", rows: [] }),
        "bad_request",
      );
      await rejected(
        () => restoreRowsAsync(sql, SYSTEM, { table: "revision_guard", rows: [] }),
        "bad_request",
      );
      await rejected(
        () => restoreRowsAsync(sql, SYSTEM, { table: "users", rows: [{}] }),
        "bad_request",
      );
      await rejected(
        () =>
          restoreRowsAsync(sql, SYSTEM, {
            table: "users",
            rows: [{ display_name: { nested: true } }],
          }),
        "bad_request",
      );
      const [users] = await sql.read([{ sql: "SELECT id FROM users" }]);
      checkEqual(users, []);
    },
  },
  {
    name: "another restore chunk can win a conflict and the next chunk refreshes its marker",
    async run(sql) {
      await marker(sql);
      const raced = race(sql, () =>
        restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "First", created_at: 100 }],
        }).then(() => {}),
      );
      checkEqual(
        await restoreRowsAsync(raced, SYSTEM, {
          table: "users",
          rows: [{ id: 2, display_name: "Second", created_at: 100 }],
        }),
        { inserted: 1, skipped: 0 },
      );
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
      const [users, revision] = await sql.read([
        { sql: "SELECT id FROM users ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(users, [{ id: 1 }, { id: 2 }]);
      checkEqual(revision, [{ value: "2" }]);
    },
  },
  {
    name: "an unrelated write during the commit race prevents continuing the restore",
    async run(sql) {
      await marker(sql);
      const raced = race(sql, () =>
        sql
          .commit(0, [
            { sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Other', 100)" },
          ])
          .then(() => {}),
      );
      await rejected(
        () =>
          restoreRowsAsync(raced, SYSTEM, {
            table: "users",
            rows: [{ id: 2, display_name: "Restored", created_at: 100 }],
          }),
        "conflict",
      );
      const [users] = await sql.read([{ sql: "SELECT id FROM users" }]);
      checkEqual(users, [{ id: 1 }]);
    },
  },
  {
    name: "failed commits roll back inserted rows and leave the old marker resumable",
    async run(sql) {
      await marker(sql);
      const [before] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'restore'" }]);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await restoreRowsAsync(broken, SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "Ada", created_at: 100 }],
        });
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [users, after, revision] = await sql.read([
        { sql: "SELECT id FROM users" },
        { sql: "SELECT value FROM meta WHERE key = 'restore'" },
        { sql: "SELECT COALESCE((SELECT value FROM meta WHERE key = 'revision'), '0') AS value" },
      ]);
      checkEqual(users, []);
      checkEqual(after, before);
      checkEqual(revision, [{ value: "0" }]);
      checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
    },
  },
  {
    name: "schema preparation is retried when the table inventory changes",
    async run(sql) {
      await marker(sql);
      let reads = 0;
      const changed: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.migrate([{ sql: "CREATE TABLE restore_extra (id INTEGER PRIMARY KEY)" }]);
          return rows;
        },
      };
      try {
        checkEqual(
          await restoreRowsAsync(changed, SYSTEM, {
            table: "users",
            rows: [{ id: 1, display_name: "Ada", created_at: 100 }],
          }),
          { inserted: 1, skipped: 0 },
        );
        checkEqual(reads, 4);
        checkEqual(await restoreState(sql), { startedAt: 100, resumable: true });
      } finally {
        await sql.migrate([{ sql: "DROP TABLE restore_extra" }]);
      }
    },
  },
  {
    name: "validated restore chunks reject malformed rows and retain system-only access",
    async run(sql) {
      await marker(sql);
      const methods = asyncWriteMethods({ sql });
      await rejected(
        () => methods.restoreRows(SYSTEM, { table: "users", rows: [null] } as never),
        "validation_failed",
      );
      await rejected(
        () => methods.restoreRows(ANONYMOUS, { table: "users", rows: [] }),
        "forbidden",
      );
      checkEqual(
        await methods.restoreRows(SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "Ada", created_at: 100 }],
        }),
        { inserted: 1, skipped: 0 },
      );
    },
  },
];
