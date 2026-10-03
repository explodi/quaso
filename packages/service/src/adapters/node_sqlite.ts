// SPDX-License-Identifier: MIT
/**
 * The `SyncSql` port on `node:sqlite` (local storage, design §3). Not portable: the server
 * imports it from `@quaso/service/node-sqlite`, and the service's tests use it with an
 * in-memory database. The Durable Object has its own adapter in `packages/cloudflare`.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { SyncSql, SqlRow, SqlValue } from "../ports.ts";

export interface NodeSqlite {
  sql: SyncSql;
  /** The underlying database, for the server's snapshots (`VACUUM INTO`) and checkpoints. */
  db: DatabaseSync;
  close(): void;
}

/** Prepared statements kept per database; the oldest go first. */
const STATEMENT_CACHE_SIZE = 500;

/** How long a write waits for another connection's lock, in milliseconds. */
const BUSY_TIMEOUT = 5000;

/**
 * Opens a SQLite database (a file path, or `":memory:"`). Sets WAL mode for files,
 * `foreign_keys = ON` (as Durable Objects always do), `synchronous = NORMAL` and a busy
 * timeout. `transaction()` uses `BEGIN IMMEDIATE` … `COMMIT`, and savepoints when nested.
 * `readOnly` opens a file only to read it (a snapshot), and leaves its journal mode alone.
 */
export function openNodeSqlite(path: string, options: { readOnly?: boolean } = {}): NodeSqlite {
  const readOnly = options.readOnly === true;
  const db = new DatabaseSync(path, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT}`);
  if (!readOnly && path !== ":memory:" && path !== "") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  const statements = new Map<string, Prepared>();
  let depth = 0;

  const prepare = (text: string): Prepared => {
    let prepared = statements.get(text);
    if (prepared === undefined) {
      prepared = prepareRows(db.prepare(text));
      if (statements.size >= STATEMENT_CACHE_SIZE) {
        statements.delete(statements.keys().next().value!);
      }
      statements.set(text, prepared);
    }
    return prepared;
  };

  const sql: SyncSql = {
    query<T extends SqlRow = SqlRow>(text: string, ...params: SqlValue[]): T[] {
      return prepare(text).rows(bind(params)) as T[];
    },
    run(text: string, ...params: SqlValue[]): void {
      prepare(text).statement.run(...bind(params));
    },
    script(text: string): void {
      db.exec(text);
      statements.clear();
    },
    transaction<T>(fn: () => T): T {
      const savepoint = depth === 0 ? undefined : `quaso_${depth}`;
      db.exec(savepoint === undefined ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth++;
      let result: T;
      try {
        result = fn();
        if (isThenable(result)) {
          throw new TypeError("transaction() takes a synchronous function");
        }
      } catch (error) {
        depth--;
        rollback(savepoint);
        throw error;
      }
      depth--;
      try {
        db.exec(savepoint === undefined ? "COMMIT" : `RELEASE ${savepoint}`);
      } catch (error) {
        rollback(savepoint);
        throw error;
      }
      return result;
    },
  };

  /**
   * Undoes a transaction or a savepoint. SQLite may have rolled the transaction back
   * already (after some errors), so a failure here is ignored: the first error matters.
   */
  function rollback(savepoint: string | undefined): void {
    try {
      if (savepoint === undefined) {
        if (db.isTransaction) db.exec("ROLLBACK");
      } else {
        db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
    } catch {
      // Already rolled back.
    }
  }

  return {
    sql,
    db,
    close() {
      statements.clear();
      db.close();
    },
  };
}

/** Whole numbers from 2^53 to 2^63: an INTEGER column stores them, but reads can't return them. */
const INEXACT_INTEGER = 2 ** 63;

/**
 * Parameters for the driver. It binds every number as a REAL, so safe integers go as
 * `bigint`, which it binds as INTEGER: `typeof(?)` and `ANY` columns then see integers.
 * Whole numbers beyond 2^53 that an INTEGER column would take are refused: stored, they
 * would fail every read that returns them.
 */
function bind(params: SqlValue[]): SQLInputValue[] {
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (Number.isSafeInteger(value)) params[i] = BigInt(value);
    else if (Math.abs(value) <= INEXACT_INTEGER) {
      throw new RangeError(`${value} is too large to store exactly; use a bigint`);
    }
  }
  return params as SQLInputValue[];
}

/** A prepared statement, and how to read its rows as plain objects. */
interface Prepared {
  statement: StatementSync;
  rows(params: SQLInputValue[]): SqlRow[];
}

/** Optional array rows, for runtimes that implement `setReturnArrays`. */
type WithArrays = StatementSync & { setReturnArrays?: (enabled: boolean) => void };

/**
 * Reads rows as plain objects, with blobs as `Uint8Array`. The driver's own objects have no
 * prototype, so rows come as arrays and are built into objects by column name, which is
 * also faster than copying them; drivers without arrays get copies. (`script()` empties the
 * statement cache, since a schema change can change a statement's columns.)
 */
function prepareRows(statement: WithArrays): Prepared {
  if (typeof statement.setReturnArrays !== "function") {
    return {
      statement,
      rows: (params) =>
        statement.all(...params).map((row) => plainRow({ ...row } as Record<string, unknown>)),
    };
  }
  statement.setReturnArrays(true);
  let names = statement.columns().map((column) => column.name);
  return {
    statement,
    rows(params) {
      const arrays = statement.all(...params) as unknown as unknown[][];
      if (arrays.length > 0 && arrays[0].length !== names.length) {
        names = statement.columns().map((column) => column.name);
      }
      const out = new Array<SqlRow>(arrays.length);
      for (let i = 0; i < arrays.length; i++) {
        const values = arrays[i];
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) row[names[c]] = values[c];
        out[i] = plainRow(row);
      }
      return out;
    },
  };
}

/** A row with any `Uint8Array` subclass (such as `Buffer`) as a plain `Uint8Array`. */
function plainRow(row: Record<string, unknown>): SqlRow {
  for (const key in row) {
    const value = row[key];
    if (typeof value === "object" && value !== null && value.constructor !== Uint8Array) {
      if (value instanceof Uint8Array) row[key] = new Uint8Array(value);
    }
  }
  return row as SqlRow;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
