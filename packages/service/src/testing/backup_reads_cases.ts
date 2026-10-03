// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import {
  BACKUP_CHANGED,
  backupInfoAsync,
  backupJsonStream,
  backupTablesAsync,
  sqlAsyncBackupReader,
} from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    {
      sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'private setup'), ('restore', '{}'), ('last_backup', '{}')",
    },
  ]);
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<ServiceError> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
  return failure;
}

export const BACKUP_READ_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "manifest retains schema order, filtered counts and revision state",
    async run(sql) {
      await seed(sql);
      const info = await backupInfoAsync(sql, ADMIN, 123);
      checkEqual(
        [info.format, info.version, info.schemaVersion, info.createdAt, info.revision],
        ["quaso-backup", 1, DATABASE_VERSION, 123, 3],
      );
      checkEqual(
        info.tables
          .filter((table) => ["users", "files", "strings", "translations"].includes(table.name))
          .map((table) => [table.name, table.rows]),
        [
          ["files", 2],
          ["strings", 6],
          ["translations", 2],
          ["users", 2],
        ],
      );
      checkEqual(
        info.tables.some(
          (table) =>
            /^(sqlite_|_cf_)/i.test(table.name) ||
            ["sessions", "email_tokens", "revision_guard"].includes(table.name),
        ),
        false,
      );
      check(info.state.startsWith("revision=3 "));
      const meta = await backupTablesAsync(sql, ADMIN, { table: "meta", state: info.state });
      const keys = meta.rows.map((row) => row[meta.columns.indexOf("key")]);
      checkEqual(
        keys.some((key) => ["setup_token", "restore", "last_backup"].includes(String(key))),
        false,
      );
      checkEqual(info.tables.find((table) => table.name === "meta")?.rows, meta.rows.length);
    },
  },
  {
    name: "rowid paging handles gaps, empty tails and revision metadata",
    async run(sql) {
      await seed(sql);
      const info = await backupInfoAsync(sql, ADMIN, 123);
      const first = await backupTablesAsync(sql, ADMIN, {
        table: "strings",
        limit: 2,
        state: info.state,
      });
      checkEqual([first.rows.length, first.next, first.revision], [2, 2, 3]);
      checkEqual(first.columns.includes("_quaso_rowid"), false);
      const last = await backupTablesAsync(sql, ADMIN, {
        table: "strings",
        after: 4,
        limit: 2,
        state: info.state,
      });
      checkEqual([last.rows.length, last.next], [2, null]);
      const past = await backupTablesAsync(sql, ADMIN, {
        table: "strings",
        after: 99,
        state: info.state,
      });
      checkEqual([past.columns, past.rows, past.next], [[], [], null]);
      await sql.migrate([{ sql: "CREATE TABLE page_rows (id INTEGER PRIMARY KEY)" }]);
      await sql.commit(3, [{ sql: "INSERT INTO page_rows VALUES (1), (3), (5)" }]);
      const gap = await backupTablesAsync(sql, ADMIN, { table: "page_rows", limit: 2 });
      checkEqual(gap.next, 3);
    },
  },
  {
    name: "unknown, private and unsafe table names are refused with permission checks",
    async run(sql) {
      await seed(sql);
      await rejected(() => backupInfoAsync(sql, ANONYMOUS, 123), "unauthorized");
      await rejected(() => backupInfoAsync(sql, { type: "user", userId: 2 }, 123), "forbidden");
      await rejected(
        () => backupTablesAsync(sql, { type: "token", tokenId: 7 }, { table: "files" }),
        "forbidden",
      );
      await rejected(() => backupTablesAsync(sql, ADMIN, { table: "sessions" }), "not_found");
      await rejected(() => backupTablesAsync(sql, ADMIN, { table: "email_tokens" }), "not_found");
      await rejected(() => backupTablesAsync(sql, ADMIN, { table: "sqlite_master" }), "not_found");
      await rejected(
        () => backupTablesAsync(sql, ADMIN, { table: "files; DROP TABLE users" }),
        "not_found",
      );
    },
  },
  {
    name: "a committed edit after the manifest rejects subsequent chunks",
    async run(sql) {
      await seed(sql);
      const info = await backupInfoAsync(sql, ADMIN, 123);
      await sql.commit(3, [{ sql: "UPDATE users SET display_name = 'Changed' WHERE id = 2" }]);
      const failure = await rejected(
        () => backupTablesAsync(sql, ADMIN, { table: "users", state: info.state }),
        "conflict",
      );
      checkEqual(failure.message, BACKUP_CHANGED);
    },
  },
  {
    name: "the final manifest snapshot includes writes between schema planning and data reads",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [
              {
                sql: "INSERT INTO users (id, display_name, created_at) VALUES (3, 'New user', 100)",
              },
            ]);
          return rows;
        },
      };
      const info = await backupInfoAsync(changing, ADMIN, 123);
      checkEqual(
        [reads, info.revision, info.tables.find((table) => table.name === "users")?.rows],
        [2, 4, 3],
      );
      check(info.state.includes("users=3"));
    },
  },
  {
    name: "a demotion between schema planning and reading refuses private backup data",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => backupTablesAsync(changing, ADMIN, { table: "users" }), "forbidden");
      checkEqual(reads, 2);
    },
  },
  {
    name: "blobs and WITHOUT ROWID tables stream through the private snapshot reader",
    async run(sql) {
      await seed(sql);
      await sql.migrate([
        { sql: "CREATE TABLE binary_data (id INTEGER PRIMARY KEY, body BLOB) STRICT" },
        { sql: "CREATE TABLE codes (code TEXT PRIMARY KEY) WITHOUT ROWID" },
      ]);
      await sql.commit(3, [
        {
          sql: "INSERT INTO binary_data (body) VALUES (?)",
          params: [new Uint8Array([0, 1, 254, 255])],
        },
        { sql: "INSERT INTO codes VALUES ('a'), ('b'), ('c')" },
      ]);
      const first = await backupTablesAsync(sql, ADMIN, { table: "codes", limit: 2 });
      checkEqual([first.rows, first.next], [[["a"], ["b"]], 2]);
      const last = await backupTablesAsync(sql, ADMIN, { table: "codes", after: 2, limit: 2 });
      checkEqual([last.rows, last.next], [[["c"]], null]);
      const blob = await backupTablesAsync(sql, ADMIN, { table: "binary_data" });
      checkEqual(blob.rows, [[1, { $base64: "AAH+/w==" }]]);
      const document = (await new Response(
        backupJsonStream(
          sqlAsyncBackupReader(sql, () => 123),
          SYSTEM,
          { chunk: 2 },
        ),
      ).json()) as { tables: Record<string, Record<string, unknown>[]> };
      checkEqual(document.tables.binary_data, [{ id: 1, body: { $base64: "AAH+/w==" } }]);
      checkEqual(document.tables.codes, [{ code: "a" }, { code: "b" }, { code: "c" }]);
    },
  },
  {
    name: "a new row without a project revision still invalidates the backup state",
    async run(sql) {
      await seed(sql);
      const info = await backupInfoAsync(sql, ADMIN, 123);
      await sql.migrate([
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (3, 'New user', 100)" },
      ]);
      await rejected(
        () => backupTablesAsync(sql, ADMIN, { table: "users", state: info.state }),
        "conflict",
      );
    },
  },
  {
    name: "continuous schema changes stop after four attempts",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          reads++;
          await sql.migrate([{ sql: `CREATE TABLE changing_${reads} (id INTEGER PRIMARY KEY)` }]);
          return rows;
        },
      };
      await rejected(() => backupInfoAsync(changing, ADMIN, 123), "unavailable");
      checkEqual(reads, 8);
    },
  },
  {
    name: "a concurrent new table replans schema before returning the manifest",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.migrate([{ sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY)" }]);
          return rows;
        },
      };
      const info = await backupInfoAsync(changing, ADMIN, 123);
      checkEqual(
        [reads, info.tables.find((table) => table.name === "extra")],
        [4, { name: "extra", rows: 0 }],
      );
    },
  },
];
