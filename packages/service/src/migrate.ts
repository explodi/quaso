// SPDX-License-Identifier: MIT
/**
 * The migration runner (design §5.3): the database knows its schema version (`meta`
 * `schema_version`) and migrates itself forward when the service starts.
 */
import { getMeta, setMeta } from "./db.ts";
import { type BatchMigration, BATCH_MIGRATIONS, type Migration, MIGRATIONS } from "./migrations.ts";
import type { Sql, SyncSql } from "./ports.ts";

export interface MigrateOptions {
  /** Called before migrating an existing database, so the host can take a snapshot. */
  beforeMigrate?: (from: number, to: number) => void | Promise<void>;
  /** The migrations, in version order. Default: `MIGRATIONS`; tests pass their own. */
  migrations?: readonly Migration[];
}

export interface MigrateResult {
  from: number;
  to: number;
  /** The database was empty: a new instance. */
  created: boolean;
}

/**
 * Brings the database to the latest schema version. A new database gets every migration
 * without `beforeMigrate`; an older one calls `beforeMigrate(from, to)` first. Each
 * migration runs in a transaction of its own, which also records its version. A database
 * newer than the code fails, so an older release never runs on newer data.
 */
export async function migrate(sql: SyncSql, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  checkOrder(migrations);
  const latest = migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
  const from = schemaVersion(sql);
  if (from > 0) requireDatabaseGeneration(getMeta(sql, "schema_generation"));
  if (from > latest) {
    throw new Error(
      `The database has schema version ${from}, but this version of Quaso only knows versions up to ${latest}. Upgrade Quaso to open it.`,
    );
  }
  const created = from === 0;
  if (!created && from < latest) await options.beforeMigrate?.(from, latest);
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    sql.transaction(() => {
      sql.script(migration.sql);
      setMeta(sql, "schema_version", String(migration.version));
    });
  }
  return { from, to: Math.max(from, latest), created };
}

/**
 * Beta 2 restarted the schema at version 1, so a Beta 1 database's version number means
 * nothing here; only the `schema_generation` row tells them apart.
 */
function requireDatabaseGeneration(generation: unknown): void {
  if (generation === "beta-2") return;
  throw new Error(
    "This database is from Beta 1 (1.0.0-rc.1), which this version of Quaso can't open. " +
      "Start a fresh instance with an empty data folder and import your translation files instead.",
  );
}

/** The database's schema version: 0 when it has no `meta` table yet. */
export function schemaVersion(sql: SyncSql): number {
  const tables = sql.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (tables.length === 0) return 0;
  return Number(getMeta(sql, "schema_version") ?? 0);
}

/** Each batch records its version atomically with its schema changes. */
export async function migrateAsync(
  sql: Sql,
  options: {
    beforeMigrate?: MigrateOptions["beforeMigrate"];
    migrations?: readonly BatchMigration[];
  } = {},
): Promise<MigrateResult> {
  const migrations = options.migrations ?? BATCH_MIGRATIONS;
  checkOrder(migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  const from = await schemaVersionAsync(sql);
  if (from > 0) {
    const [rows] = await sql.read([
      { sql: "SELECT value FROM meta WHERE key = 'schema_generation'" },
    ]);
    requireDatabaseGeneration(rows[0]?.value);
  }
  if (from > latest) {
    throw new Error(
      `The database has schema version ${from}, but this version of Quaso only knows versions up to ${latest}. Upgrade Quaso to open it.`,
    );
  }
  const created = from === 0;
  if (!created && from < latest) await options.beforeMigrate?.(from, latest);
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    await sql.migrate([
      ...migration.statements,
      {
        sql: "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: [String(migration.version)],
      },
    ]);
  }
  return { from, to: Math.max(from, latest), created };
}

export async function schemaVersionAsync(sql: Sql): Promise<number> {
  const [tables] = await sql.read([
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'" },
  ]);
  if (tables.length === 0) return 0;
  const [rows] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'schema_version'" }]);
  return Number(rows[0]?.value ?? 0);
}

function checkOrder(migrations: readonly { version: number; name: string }[]): void {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new Error(`Migration ${migration.name} has version ${migration.version}, not ${i + 1}`);
    }
  });
}
