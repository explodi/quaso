// SPDX-License-Identifier: MIT
/**
 * The ports (design §3): the only ways the service reaches its runtime. Each has two
 * implementations, one in the Deno server (local storage) and one in the Durable Object
 * (Cloudflare storage), and the same test cases run against both.
 */

/** A value SQLite can bind or return. Blobs come back as `Uint8Array`. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A row, by column name. */
export type SqlRow = Record<string, SqlValue>;

/**
 * Synchronous port for service operations awaiting the batch conversion (B2.4–B2.6).
 *
 * Rules for SQL the service writes, so that both implementations accept it (design §5.3):
 * - no `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`: use `transaction()`;
 * - no PRAGMAs (the adapters set what they need);
 * - at most `SQL_MAX_PARAMS` bound parameters per statement, so bulk writes go in chunks
 *   (see `chunks()` in `db.ts`);
 * - to get an inserted row's ID, use `INSERT … RETURNING id` with `query()`;
 * - no `LIKE` or `GLOB` with a pattern built from input: Durable Objects refuse patterns
 *   over 50 bytes ("LIKE or GLOB pattern too complex"). Search normalized text with
 *   `instr(column, ?) > 0` instead;
 * - don't depend on the SQL type of a bound number: Durable Objects bind every number as a
 *   REAL (STRICT `INTEGER` columns still store whole numbers as integers, but `typeof(?)`,
 *   `ANY` columns and `? || ''` see `7.0`), while `node:sqlite` binds integers as INTEGER.
 */
export interface SyncSql {
  /** Runs one statement and returns its rows (none for a write without `RETURNING`). */
  query<T extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): T[];
  /** Runs one statement and ignores its rows. */
  run(sql: string, ...params: SqlValue[]): void;
  /** Runs several statements without parameters, such as a migration. */
  script(sql: string): void;
  /**
   * Runs `fn` as one synchronous transaction: all of its writes happen, or none if it
   * throws. Nested calls join the outer transaction as a savepoint: an error that
   * escapes a nested call rolls back only its writes, if the outer call catches it.
   */
  transaction<T>(fn: () => T): T;
}

/** A statement and its bound values, shared by both batch adapters. */
export interface Statement {
  sql: string;
  params?: SqlValue[];
}

/** Consistent reads and revision-guarded atomic writes on SQLite and D1. */
export interface Sql {
  /** Read-only statements, run in one consistent snapshot. */
  read(statements: Statement[]): Promise<SqlRow[][]>;
  /** Applies all statements and raises the revision, or throws RevisionConflict. */
  commit(revision: number, statements: Statement[]): Promise<number>;
  /** Applies a migration atomically; the migration runner tracks completed versions. */
  migrate(statements: Statement[]): Promise<void>;
}

export type StoredObject = { key: string; size: number; version: string };

/** Private objects for published versions and backups; versions are opaque. */
export interface Store {
  read(key: string): Promise<Uint8Array | null>;
  /** A stale condition throws StoreConflict; "absent" creates only a new key. */
  write(
    key: string,
    bytes: Uint8Array,
    options?: { ifMatch?: string | "absent" },
  ): Promise<{ version: string }>;
  list(prefix: string): AsyncIterable<StoredObject>;
  delete(keys: string[]): Promise<void>;
}

/** The Durable Object limit on bound parameters per statement. */
export const SQL_MAX_PARAMS = 100;

/**
 * Wakes the service up later (design §5.6): a timer in the server, whose next wake-up is
 * stored in the database, or a Durable Object alarm. When the time comes, the host calls
 * `service.alarm()`.
 */
export interface Scheduler {
  /**
   * Asks for a wake-up at `at` (milliseconds since the epoch), or as soon as possible if
   * that is in the past. Replaces any wake-up already set.
   */
  schedule(at: number): void | Promise<void>;
  /** Cancels the wake-up, if any. */
  cancel(): void | Promise<void>;
}

/** Structured logs. The server writes them as JSON lines; the Durable Object to Workers Logs. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A logger that writes nothing, for tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** The time, in milliseconds since the epoch. Tests replace it. */
export type Clock = () => number;
