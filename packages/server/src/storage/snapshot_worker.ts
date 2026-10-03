// SPDX-License-Identifier: MIT
/**
 * Takes a snapshot on its own connection, in a worker, so the server's connection and its
 * requests go on meanwhile (design §8). The copy is one step of SQLite's backup API, so it
 * sees one consistent state of the database. `bun build --compile` includes this file
 * (scripts/build_server.ts).
 */
import { parentPort } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";

/** What the worker is asked: copy the database file `source` into the new file `target`. */
export interface SnapshotJob {
  source: string;
  target: string;
}

/** What it answers. */
export type SnapshotResult = { ok: true } | { ok: false; message: string };

/** Every page in one step: a copy made in several steps starts again after each write. */
const ALL_PAGES = 2 ** 31 - 1;

/**
 * Copies an open database into the new file `target`. The copy keeps the database's WAL
 * mode, which a reader can only open where it may write the `-wal` and `-shm` files next
 * to it (not from a read-only mount); so it is switched to a rollback journal, and is then
 * one file that opens anywhere.
 */
export async function copyDatabase(db: DatabaseSync, target: string): Promise<void> {
  await backup(db, target, { rate: ALL_PAGES });
  const copy = new DatabaseSync(target);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
  } finally {
    copy.close();
  }
}

if (parentPort) {
  parentPort.on("message", async (data: SnapshotJob) => {
    let result: SnapshotResult;
    try {
      const db = new DatabaseSync(data.source, { readOnly: true });
      try {
        await copyDatabase(db, data.target);
      } finally {
        db.close();
      }
      result = { ok: true };
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    parentPort!.postMessage(result);
  });
}
