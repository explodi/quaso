// SPDX-License-Identifier: MIT
/**
 * The `SyncSql` port on Durable Object SQLite (`ctx.storage.sql`, design §3). The service's
 * shared test cases (`@quaso/service/sql-cases`) run against it in `workerd`.
 *
 * - `query` reads the cursor into plain objects by column name, with blobs (which the
 *   runtime returns as `ArrayBuffer`) as `Uint8Array`.
 * - `run` and `script` read their cursors to the end, so every statement has run when they
 *   return. The runtime accepts several statements without bindings in one `exec`.
 * - `transaction` is `ctx.storage.transactionSync`, which nests: a nested call is a
 *   savepoint in the outer transaction, so an error that escapes it rolls back only its own
 *   writes (the shared cases check it).
 *
 * Durable Objects allow at most 100 bound parameters and 100 KB per statement; the service
 * already writes in chunks (`SQL_MAX_PARAMS`). They also refuse `LIKE` and `GLOB` patterns
 * over 50 bytes, so the service searches with `instr()` (the rules are in `ports.ts`).
 */
import type { SyncSql, SqlRow, SqlValue } from "@quaso/service";

/** What the adapter needs from `ctx.storage`. */
export type SqlStorageHost = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** The `SyncSql` port on a Durable Object's storage. */
export function createDurableObjectSql(storage: SqlStorageHost): SyncSql {
  const exec = (text: string, params: SqlValue[]) => storage.sql.exec(text, ...bind(params));
  return {
    query<T extends SqlRow = SqlRow>(text: string, ...params: SqlValue[]): T[] {
      return readRows(exec(text, params)) as T[];
    },
    run(text: string, ...params: SqlValue[]): void {
      drain(exec(text, params));
    },
    script(text: string): void {
      drain(storage.sql.exec(text));
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(() => {
        const result = fn();
        if (isThenable(result)) {
          throw new TypeError("transaction() takes a synchronous function");
        }
        return result;
      });
    },
  };
}

/**
 * Parameters for the runtime, which binds numbers, strings, `null` and `ArrayBuffer`s.
 * A `bigint` goes as a number when it is exact; a `Uint8Array`, as a copy of its bytes.
 */
function bind(params: SqlValue[]): (string | number | null | ArrayBuffer)[] {
  return params.map((value) => {
    if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        throw new RangeError(`${value} is too large for Durable Object SQLite`);
      }
      return number;
    }
    if (value instanceof Uint8Array) {
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer;
    }
    return value;
  });
}

/** Plain objects by column name, with blobs as `Uint8Array`. */
function readRows(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): SqlRow[] {
  const names = cursor.columnNames;
  const rows: SqlRow[] = [];
  for (const values of cursor.raw()) {
    const row: SqlRow = {};
    for (let c = 0; c < names.length; c++) {
      const value = values[c];
      row[names[c]] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    }
    rows.push(row);
  }
  return rows;
}

/** Reads a cursor to its end, so that its statement has run completely. */
function drain(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
  for (const _ of cursor.raw()) {
    // Nothing to keep.
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
