// SPDX-License-Identifier: MIT
/**
 * The lock file (design §3, §5.12): one server per data folder. The server holds an
 * exclusive lock on `quaso.lock` for as long as it runs; the operating system releases it
 * when the process ends, even after a crash.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Thrown when another process holds the lock. */
export class LockBusyError extends Error {
  constructor(readonly dir: string) {
    super(`Another Quaso server is using ${dir}.`);
    this.name = "LockBusyError";
  }
}

export interface DataLock {
  release(): void;
}

/**
 * Takes the lock on `dir/quaso.lock`, waiting at most `timeoutMs` (default 2 seconds) for
 * another process to release it, then throws a `LockBusyError`.
 */
export async function acquireLock(dir: string, timeoutMs = 2000): Promise<DataLock> {
  const db = new DatabaseSync(join(dir, "quaso.lock"));
  const deadline = Date.now() + timeoutMs;
  db.exec("PRAGMA busy_timeout = 0");
  try {
    for (;;) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("locked")) throw error;
        if (Date.now() >= deadline) throw new LockBusyError(dir);
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}
