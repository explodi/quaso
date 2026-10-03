// SPDX-License-Identifier: MIT
import { migrateAsync, schemaVersionAsync } from "../migrate.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { initializeDatabase } from "../startup.ts";
import { RevisionConflict, GUARD_STATEMENTS } from "../write.ts";
import { SYSTEM } from "../api.ts";
import { backupInfoAsync, restoreTokenValidAsync } from "../backup.ts";
import { check, checkEqual } from "./assert.ts";

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}

async function settings(sql: Sql): Promise<{ name: string; llm: { model: string } }> {
  const [rows] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
  return JSON.parse(rows[0].data as string);
}

export const STARTUP_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "new databases install defaults and a working revision guard without a snapshot",
    async run(sql) {
      checkEqual(
        await initializeDatabase(sql, {
          defaultModel: "runtime-model",
          beforeMigrate() {
            throw new Error("No snapshot for an empty database");
          },
        }),
        { from: 0, to: DATABASE_VERSION, created: true },
      );
      const stored = await settings(sql);
      checkEqual([stored.name, stored.llm.model], ["Untitled project", "runtime-model"]);
      checkEqual(
        await sql.commit(0, [{ sql: "INSERT INTO meta (key, value) VALUES ('test', 'saved')" }]),
        1,
      );
      check(
        (await failure(() =>
          sql.commit(0, [{ sql: "UPDATE meta SET value = 'stale' WHERE key = 'test'" }]),
        )) instanceof RevisionConflict,
      );
      const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'test'" }]);
      checkEqual(rows, [{ value: "saved" }]);
    },
  },
  {
    name: "restarts preserve settings and revision while installing no duplicate guard rows",
    async run(sql) {
      await initializeDatabase(sql);
      await sql.commit(0, [
        { sql: 'UPDATE settings SET data = \'{"name":"Kept","llm":{"model":"saved-model"}}\'' },
      ]);
      checkEqual(await initializeDatabase(sql, { defaultModel: "other-model" }), {
        from: DATABASE_VERSION,
        to: DATABASE_VERSION,
        created: false,
      });
      checkEqual(await settings(sql), { name: "Kept", llm: { model: "saved-model" } });
      const [guards, revision] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM revision_guard" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual([guards[0].n, revision[0].value], [1, "1"]);
      checkEqual(
        await sql.commit(1, [{ sql: 'UPDATE settings SET data = \'{"name":"Next"}\'' }]),
        2,
      );
    },
  },
  {
    name: "a concurrent settings write wins over bootstrap defaults",
    async run(sql) {
      const changing: Sql = {
        ...sql,
        async migrate(statements) {
          if (statements.some((statement) => statement.sql.startsWith("INSERT INTO settings"))) {
            await sql.migrate(GUARD_STATEMENTS);
            await sql.commit(0, [
              { sql: 'INSERT INTO settings (id, data) VALUES (1, \'{"name":"Concurrent"}\')' },
            ]);
          }
          await sql.migrate(statements);
        },
      };
      await initializeDatabase(changing);
      checkEqual(await settings(sql), { name: "Concurrent" });
    },
  },
  {
    name: "startup preserves an unfinished restore without adding default project data",
    async run(sql) {
      await migrateAsync(sql);
      const info = await backupInfoAsync(sql, SYSTEM, 100);
      await sql.migrate([
        {
          sql: "INSERT INTO meta (key, value) VALUES ('restore', ?), ('setup_token', 'restore-token')",
          params: [
            JSON.stringify({ schemaVersion: DATABASE_VERSION, startedAt: 100, state: info.state }),
          ],
        },
      ]);
      await initializeDatabase(sql);
      const [stored] = await sql.read([{ sql: "SELECT data FROM settings" }]);
      checkEqual(stored, []);
      checkEqual(await restoreTokenValidAsync(sql, SYSTEM, "restore-token"), true);
      await sql.migrate([{ sql: "DELETE FROM meta WHERE key = 'restore'" }]);
      await initializeDatabase(sql);
      checkEqual((await settings(sql)).name, "Untitled project");
    },
  },
  {
    name: "failed default settings leave the initial schema usable for a restart",
    async run(sql) {
      const broken: Sql = {
        ...sql,
        async migrate(statements) {
          const initializing = statements.some((statement) =>
            statement.sql.startsWith("INSERT INTO settings"),
          );
          await sql.migrate(
            initializing
              ? [...statements, { sql: "INSERT INTO missing_bootstrap_table VALUES (1)" }]
              : statements,
          );
        },
      };
      await failure(() => initializeDatabase(broken));
      checkEqual(await schemaVersionAsync(sql), DATABASE_VERSION);
      const [stored, guards] = await sql.read([
        { sql: "SELECT data FROM settings" },
        { sql: "SELECT name FROM sqlite_master WHERE name = 'revision_guard'" },
      ]);
      checkEqual([stored, guards], [[], [{ name: "revision_guard" }]]);
      await initializeDatabase(sql);
      checkEqual((await settings(sql)).name, "Untitled project");
      checkEqual(
        await sql.commit(0, [{ sql: "INSERT INTO meta (key, value) VALUES ('test', 'saved')" }]),
        1,
      );
    },
  },
];
