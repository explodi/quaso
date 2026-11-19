// SPDX-License-Identifier: MIT
/**
 * The `SyncSql` port on `node:sqlite` (local storage, design §3). Not portable: the server
 * imports it from `@quaso/service/node-sqlite`, and the service's tests use it with an
 * in-memory database. Cloudflare storage uses the D1 batch adapter.
 */
import { DatabaseSync } from "node:sqlite";
import { type NodeSqlite, sqlOnDatabase } from "./node_sqlite_database.ts";

export type { NodeSqlite };

/** How long a write waits for another connection's lock, in milliseconds. */
const BUSY_TIMEOUT = 5000;

/**
 * Opens a SQLite database (a file path, or `":memory:"`). Sets WAL mode for files and a busy
 * timeout; `sqlOnDatabase` sets the rest. `readOnly` opens a file only to read it (a
 * snapshot), and leaves its journal mode alone.
 */
export function openNodeSqlite(path: string, options: { readOnly?: boolean } = {}): NodeSqlite {
  const readOnly = options.readOnly === true;
  const db = new DatabaseSync(path, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT}`);
  if (!readOnly && path !== ":memory:" && path !== "") db.exec("PRAGMA journal_mode = WAL");
  return sqlOnDatabase(db);
}
