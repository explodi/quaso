// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { SYSTEM_AUTHOR } from "../actors.ts";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  beginRestoreAsync,
  backupInfoAsync,
  restoreRowsAsync,
  restoreTokenValidAsync,
} from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const HEADER = { format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: DATABASE_VERSION };

async function rejected(run: () => Promise<unknown>, code: string) {
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

export const RESTORE_START_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "startup replaces the schema and marker while preserving setup credentials and the guard",
    async run(sql) {
      await sql.commit(0, [
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Visitor', 100)" },
        {
          sql: "INSERT INTO identities (user_id, provider, subject, created_at) VALUES (1, 'github', 'visitor', 100)",
        },
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'destination')" },
        { sql: "CREATE VIEW restore_visitors AS SELECT display_name FROM users" },
      ]);
      const result = await beginRestoreAsync(sql, SYSTEM, HEADER, 200);
      checkEqual(result.schemaVersion, DATABASE_VERSION);
      check(result.tables.includes("users"));
      check(!result.tables.includes("sessions"));
      check(!result.tables.includes("revision_guard"));
      const [users, identities, views, meta] = await sql.read([
        { sql: "SELECT id FROM users" },
        { sql: "SELECT id FROM identities" },
        { sql: "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'restore_visitors'" },
        { sql: "SELECT key, value FROM meta WHERE key IN ('revision', 'setup_token', 'restore')" },
      ]);
      checkEqual(users, []);
      checkEqual(identities, []);
      checkEqual(views, []);
      const values = new Map(meta.map((row) => [row.key, row.value]));
      checkEqual(values.get("revision"), "2");
      checkEqual(values.get("setup_token"), "destination");
      checkEqual(JSON.parse(String(values.get("restore"))).startedAt, 200);
      check(await restoreTokenValidAsync(sql, SYSTEM, "destination"));
      checkEqual(
        await restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "Restored", role: "administrator", created_at: 100 }],
        }),
        { inserted: 1, skipped: 0 },
      );
      check(await restoreTokenValidAsync(sql, SYSTEM, "destination"));
    },
  },
  {
    name: "only the system starts restores and invalid headers never reach the database",
    async run(sql) {
      const untouched: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      await rejected(() => beginRestoreAsync(untouched, ANONYMOUS, HEADER, 200), "forbidden");
      await rejected(
        () => beginRestoreAsync(untouched, SYSTEM, { ...HEADER, format: "other" }, 200),
        "bad_request",
      );
      await rejected(
        () => beginRestoreAsync(untouched, SYSTEM, { ...HEADER, version: 999 }, 200),
        "bad_request",
      );
      await rejected(
        () => beginRestoreAsync(untouched, SYSTEM, { ...HEADER, schemaVersion: 0 }, 200),
        "bad_request",
      );
      await rejected(
        () =>
          beginRestoreAsync(
            untouched,
            SYSTEM,
            { ...HEADER, schemaVersion: DATABASE_VERSION + 1 },
            200,
          ),
        "bad_request",
      );
    },
  },
  {
    name: "strings or people with roles prevent replacing a used instance",
    async run(sql) {
      await sql.commit(0, [
        {
          sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Admin', 'administrator', 100)",
        },
      ]);
      const people = await rejected(() => beginRestoreAsync(sql, SYSTEM, HEADER, 200), "conflict");
      check(people.message.includes("people with roles"));
      await sql.commit(1, [{ sql: "UPDATE users SET deleted_at = 150 WHERE id = 1" }]);
      await beginRestoreAsync(sql, SYSTEM, HEADER, 200);
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [{ path: "menu.json", repoPath: "menu.json", content: '{"title":"Hello"}' }] },
        { model: "test", clock: () => 200, llmAvailable: false },
      );
      const strings = await rejected(() => beginRestoreAsync(sql, SYSTEM, HEADER, 250), "conflict");
      check(strings.message.includes("it has strings"));
      check(strings.message.includes("instance has been used since"));
    },
  },
  {
    name: "a competing privileged account prevents the stale empty-instance decision",
    async run(sql) {
      const raced = race(sql, () =>
        sql
          .commit(0, [
            {
              sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Winner', 'administrator', 100)",
            },
          ])
          .then(() => {}),
      );
      await rejected(() => beginRestoreAsync(raced, SYSTEM, HEADER, 200), "conflict");
      const [users, marker] = await sql.read([
        { sql: "SELECT display_name FROM users" },
        { sql: "SELECT value FROM meta WHERE key = 'restore'" },
      ]);
      checkEqual(users, [{ display_name: "Winner" }]);
      checkEqual(marker, []);
    },
  },
  {
    name: "a competing restore start is reread and a resumable restore can restart safely",
    async run(sql) {
      const raced = race(sql, () => beginRestoreAsync(sql, SYSTEM, HEADER, 150).then(() => {}));
      const result = await beginRestoreAsync(raced, SYSTEM, HEADER, 200);
      checkEqual(result.schemaVersion, DATABASE_VERSION);
      const [rows] = await sql.read([
        { sql: "SELECT key, value FROM meta WHERE key IN ('revision', 'restore')" },
      ]);
      const values = new Map(rows.map((row) => [row.key, row.value]));
      checkEqual(values.get("revision"), "2");
      checkEqual(JSON.parse(String(values.get("restore"))).startedAt, 200);
      checkEqual(
        await restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "Restored", created_at: 100 }],
        }),
        { inserted: 1, skipped: 0 },
      );
    },
  },
  {
    name: "schema replacement failure rolls back the old schema, data, setup token and revision",
    async run(sql) {
      await sql.commit(0, [
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Visitor', 100)" },
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'destination')" },
      ]);
      const before = await backupInfoAsync(sql, SYSTEM, 100);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await beginRestoreAsync(broken, SYSTEM, { ...HEADER, schemaVersion: 1 }, 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const after = await backupInfoAsync(sql, SYSTEM, 100);
      checkEqual(after, before);
      const [users, meta] = await sql.read([
        { sql: "SELECT display_name FROM users" },
        {
          sql: "SELECT key, value FROM meta WHERE key IN ('revision', 'setup_token', 'restore') ORDER BY key",
        },
      ]);
      checkEqual(users, [{ display_name: "Visitor" }]);
      checkEqual(meta, [
        { key: "revision", value: "1" },
        { key: "setup_token", value: "destination" },
      ]);
    },
  },
  {
    name: "validated startup logs only a committed schema version",
    async run(sql) {
      const logs: unknown[] = [];
      const methods = asyncWriteMethods({
        sql,
        clock: () => 200,
        logger: {
          debug: () => {},
          info: () => {},
          error: () => {},
          warn: (...args) => logs.push(args),
        },
      });
      await rejected(
        () => methods.beginRestore(SYSTEM, { ...HEADER, schemaVersion: 0 }),
        "validation_failed",
      );
      await rejected(() => methods.beginRestore(ANONYMOUS, HEADER), "forbidden");
      checkEqual(logs, []);
      checkEqual((await methods.beginRestore(SYSTEM, HEADER)).schemaVersion, DATABASE_VERSION);
      checkEqual(logs, [["Restoring a backup", { schemaVersion: DATABASE_VERSION }]]);
    },
  },
];
