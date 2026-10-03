// SPDX-License-Identifier: MIT
import type { BackupDocument } from "@quaso/core";
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { SYSTEM_AUTHOR } from "../actors.ts";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  beginRestoreAsync,
  finishRestoreAsync,
  restoreRowsAsync,
  recordBackupAsync,
  backupJsonStream,
  sqlAsyncBackupReader,
  documentSource,
  restoreBackup,
} from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { resetUploadSql } from "./upload_cases.ts";

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

export const RESTORE_FINISH_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "completion accounts for skipped control metadata and clears marker and setup token",
    async run(sql) {
      await sql.commit(0, [
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'destination')" },
      ]);
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      await restoreRowsAsync(sql, SYSTEM, {
        table: "users",
        rows: [{ id: 1, display_name: "Admin", role: "administrator", created_at: 100 }],
      });
      await restoreRowsAsync(sql, SYSTEM, {
        table: "meta",
        rows: [
          { key: "revision", value: "900" },
          { key: "schema_version", value: "1" },
          { key: "custom", value: "restored" },
        ],
      });
      const result = await finishRestoreAsync(sql, SYSTEM, {
        counts: { users: 1, meta: 3, sessions: 10, email_tokens: 10 },
      });
      checkEqual(result, {
        schemaVersion: { from: DATABASE_VERSION, to: DATABASE_VERSION },
        tables: { users: 1, meta: 1 },
        revision: 5,
        missingSecrets: [],
      });
      const [control] = await sql.read([
        { sql: "SELECT key FROM meta WHERE key IN ('restore', 'setup_token')" },
      ]);
      checkEqual(control, []);
      await sql.commit(5, [
        { sql: "UPDATE users SET display_name = 'After restore' WHERE id = 1" },
      ]);
    },
  },
  {
    name: "setup credentials stay when the restored instance has no active administrator",
    async run(sql) {
      await sql.commit(0, [
        { sql: "INSERT INTO meta (key, value) VALUES ('setup_token', 'destination')" },
      ]);
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      await restoreRowsAsync(sql, SYSTEM, {
        table: "users",
        rows: [
          {
            id: 1,
            display_name: "Deleted admin",
            role: "administrator",
            deleted_at: 100,
            created_at: 100,
          },
        ],
      });
      await finishRestoreAsync(sql, SYSTEM, { counts: { users: 1 } });
      const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'setup_token'" }]);
      checkEqual(rows, [{ value: "destination" }]);
    },
  },
  {
    name: "count failures and unknown tables leave the marker and revision untouched",
    async run(sql) {
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      const [before] = await sql.read([
        { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision') ORDER BY key" },
      ]);
      const incomplete = await rejected(
        () => finishRestoreAsync(sql, SYSTEM, { counts: { users: 1 } }),
        "bad_request",
      );
      check(incomplete.message.includes("users: 0 of 1"));
      await rejected(
        () => finishRestoreAsync(sql, SYSTEM, { counts: { missing: 1 } }),
        "bad_request",
      );
      await rejected(
        () => finishRestoreAsync(sql, SYSTEM, { counts: { revision_guard: 1 } }),
        "bad_request",
      );
      const [after] = await sql.read([
        { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision') ORDER BY key" },
      ]);
      checkEqual(after, before);
    },
  },
  {
    name: "system access and an unchanged live restore are required for completion",
    async run(sql) {
      await rejected(() => finishRestoreAsync(sql, ANONYMOUS, { counts: {} }), "forbidden");
      await rejected(() => finishRestoreAsync(sql, SYSTEM, { counts: {} }), "bad_request");
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      await sql.commit(1, [
        { sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Other write', 100)" },
      ]);
      await rejected(() => finishRestoreAsync(sql, SYSTEM, { counts: { users: 1 } }), "conflict");
    },
  },
  {
    name: "a competing chunk refreshes counts rather than finishing an earlier snapshot",
    async run(sql) {
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      const raced = race(sql, () =>
        restoreRowsAsync(sql, SYSTEM, {
          table: "users",
          rows: [{ id: 1, display_name: "Later chunk", created_at: 100 }],
        }).then(() => {}),
      );
      await rejected(
        () => finishRestoreAsync(raced, SYSTEM, { counts: { users: 0 } }),
        "bad_request",
      );
      checkEqual((await finishRestoreAsync(sql, SYSTEM, { counts: { users: 1 } })).tables, {
        users: 1,
      });
    },
  },
  {
    name: "another completion wins once and the stale finisher does not repeat cleanup",
    async run(sql) {
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      const raced = race(sql, () => finishRestoreAsync(sql, SYSTEM, { counts: {} }).then(() => {}));
      await rejected(() => finishRestoreAsync(raced, SYSTEM, { counts: {} }), "bad_request");
      const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(rows, [{ value: "2" }]);
    },
  },
  {
    name: "whole async backup and restore preserves exported application data",
    async run(sql) {
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        {
          files: [{ path: "menu.json", repoPath: "menu.json", content: '{"title":"Hello"}' }],
          languages: ["de"],
        },
        { model: "test", clock: () => 100, llmAvailable: false },
      );
      const source = (await new Response(
        backupJsonStream(
          sqlAsyncBackupReader(sql, () => 100),
          SYSTEM,
        ),
      ).json()) as BackupDocument;
      await resetUploadSql(sql);
      const result = await restoreBackup(
        asyncWriteMethods({ sql, clock: () => 200 }),
        documentSource(source),
      );
      checkEqual(result.schemaVersion.to, DATABASE_VERSION);
      const restored = (await new Response(
        backupJsonStream(
          sqlAsyncBackupReader(sql, () => 100),
          SYSTEM,
        ),
      ).json()) as BackupDocument;
      checkEqual(
        { ...restored.tables, meta: restored.tables.meta.filter((row) => row.key !== "revision") },
        { ...source.tables, meta: source.tables.meta.filter((row) => row.key !== "revision") },
      );
    },
  },
  {
    name: "validated completion invokes the host callback and logs only after a commit",
    async run(sql) {
      await beginRestoreAsync(sql, SYSTEM, HEADER, 100);
      const logs: unknown[] = [];
      let callbacks = 0;
      const methods = asyncWriteMethods({
        sql,
        afterRestore: async () => {
          callbacks++;
          const [rows] = await sql.read([{ sql: "SELECT key FROM meta WHERE key = 'restore'" }]);
          checkEqual(rows, []);
        },
        logger: {
          debug: () => {},
          info: () => {},
          error: () => {},
          warn: (...args) => logs.push(args),
        },
      });
      await rejected(
        () => methods.finishRestore(SYSTEM, { counts: { users: -1 } }),
        "validation_failed",
      );
      await rejected(() => methods.finishRestore(SYSTEM, { counts: { users: 1 } }), "bad_request");
      checkEqual(callbacks, 0);
      checkEqual(logs, []);
      await methods.finishRestore(SYSTEM, { counts: { users: 0 } });
      checkEqual(callbacks, 1);
      checkEqual(logs, [
        [
          "Restored a backup",
          { schemaVersion: { from: DATABASE_VERSION, to: DATABASE_VERSION }, revision: 2 },
        ],
      ]);
    },
  },
  {
    name: "backup recording is system-only, ignores older and identical records and keeps the newest race",
    async run(sql) {
      await rejected(
        () => recordBackupAsync(sql, ANONYMOUS, { at: 100, file: "backup.json" }),
        "forbidden",
      );
      checkEqual(await recordBackupAsync(sql, SYSTEM, { at: 100, file: "backup.json" }), {
        ok: true,
      });
      await recordBackupAsync(sql, SYSTEM, { at: 50, file: "old.json" });
      await recordBackupAsync(sql, SYSTEM, { at: 100, file: "backup.json" });
      const raced: Sql = {
        ...sql,
        async commit(revision, statements) {
          await recordBackupAsync(sql, SYSTEM, { at: 300, file: "newest.json" });
          return sql.commit(revision, statements);
        },
      };
      await recordBackupAsync(raced, SYSTEM, { at: 200, file: "middle.json" });
      const [rows, revision] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'last_backup'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(rows, [{ value: '{"at":300,"file":"newest.json"}' }]);
      checkEqual(revision, [{ value: "2" }]);
      const methods = asyncWriteMethods({ sql });
      await rejected(
        () => methods.recordBackup(SYSTEM, { at: -1, file: null }),
        "validation_failed",
      );
      checkEqual(await methods.recordBackup(SYSTEM, { at: 400, file: null }), { ok: true });
    },
  },
];
