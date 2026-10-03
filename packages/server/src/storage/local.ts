// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Local storage (design §3, §5.12): the data folder with the lock file, the SQLite database `quaso.sqlite`, snapshots in the store, and the
 * timers that wake the service up.
 */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  type Logger,
  type Sql,
  type SyncSql,
  type Store,
  TimerScheduler,
  createStoredBackups,
  DEFAULT_BACKUP_DAYS,
} from "@quaso/service";
import { openNodeSqlite } from "@quaso/service/node-sqlite";
import { createAsyncSqlite } from "@quaso/service/node-async-sqlite";
import { acquireLock } from "./lock.ts";
import { copyInto, preMigrationName, snapshotInWorker } from "./snapshots.ts";
import { createFolderStore } from "./folder_store.ts";
import { loadSettings } from "../../../service/src/settings.ts";
import { FALLBACK_MODEL } from "../../../service/src/context.ts";

export const DATABASE_FILE = "quaso.sqlite";

/** The data folder's folder for temporary files. */
export const TEMP_DIR = "tmp";

export interface LocalStorageOptions {
  dataDir: string;
  log: Logger;
  /** How long to wait for another server to release the lock. Default: 2 seconds. */
  lockTimeoutMs?: number;
  now?: () => number;
}

export interface LocalStorage {
  dataDir: string;
  sql: SyncSql;
  /** Guarded service batches on the connection used for snapshots and checkpoints. */
  batchSql: Sql;
  /** For snapshots and checkpoints. */
  db: DatabaseSync;
  store: Store;
  backupStatus: { busy(): boolean; nextWakeUp(): number | null };
  /** Pass it to the service; `onAlarm` receives its wake-ups. */
  scheduler: TimerScheduler;
  /** What the scheduler calls: the host sets it to `service.alarm()`. */
  onAlarm: (() => Promise<void>) | null;
  /** Pass it to the service: a snapshot before a migration. */
  beforeMigrate(from: number, to: number): Promise<void>;
  /** Starts the scheduled snapshots. */
  startBackups(): Promise<void>;
  /** Takes a snapshot now. Returns its name below the store's `backups/` prefix. */
  snapshot(): Promise<string>;
  /** Writes a consistent copy of the database to any path (a backup download). */
  snapshotTo(path: string): Promise<void>;
  /** Told of the newest scheduled snapshot: the host records it with the service. */
  onSnapshot: ((snapshot: { at: number; file: string }) => void | Promise<void>) | null;
  /** A folder for temporary files, such as backup downloads: emptied when opened. */
  tempDir: string;
  /** The newest snapshot, if any. */
  lastBackup(): { at: number; file: string } | null;
  /** Stops the timers, checkpoints and closes the database, and releases the lock. */
  close(): void;
}

/** Opens the data folder, creating it if needed. Throws `LockBusyError` if it's in use. */
export async function openLocalStorage(options: LocalStorageOptions): Promise<LocalStorage> {
  const { dataDir, log } = options;
  const now = options.now ?? Date.now;
  await fs.mkdir(join(dataDir, "store"), { recursive: true });
  const lock = await acquireLock(dataDir, options.lockTimeoutMs);
  try {
    // Temporary files a server that stopped abruptly left behind go.
    const tempDir = join(dataDir, TEMP_DIR);
    await fs.rm(tempDir, { recursive: true }).catch(() => {});
    await fs.mkdir(tempDir, { recursive: true });
    const databasePath = join(dataDir, DATABASE_FILE);
    const database = openNodeSqlite(databasePath);
    const copy = async (path: string) => {
      try {
        await snapshotInWorker(databasePath, path);
      } catch (error) {
        log.warn("The snapshot in a worker failed; taking it on the server's connection", {
          error,
        });
        await copyInto(database.db, path);
      }
    };
    const store = createFolderStore(join(dataDir, "store"));
    const capture = async () => {
      const path = join(tempDir, `snapshot-${crypto.randomUUID()}.sqlite`);
      try {
        await copy(path);
        return new Uint8Array(await fs.readFile(path));
      } finally {
        await fs.rm(path, { force: true });
      }
    };
    const backupTimer = new TimerScheduler(() => backups.alarm(), {
      now,
      onError: (error) => log.error("Snapshot failed", { error }),
    });
    const backups = createStoredBackups(store, {
      capture,
      scheduler: backupTimer,
      extension: "sqlite",
      clock: now,
      logger: log,
      retentionDays: () => {
        const exists =
          database.sql.query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
          ).length > 0;
        if (!exists) return DEFAULT_BACKUP_DAYS;
        return loadSettings({ sql: database.sql, defaultModel: FALLBACK_MODEL })
          .backupRetentionDays;
      },
      onSnapshot: ({ at, key }) => storage.onSnapshot?.({ at, file: key.slice("backups/".length) }),
    });
    let closed = false;
    const storage: LocalStorage = {
      dataDir,
      sql: database.sql,
      batchSql: createAsyncSqlite(database),
      db: database.db,
      store,
      backupStatus: { busy: () => backups.busy, nextWakeUp: () => backups.nextWakeUp },
      scheduler: new TimerScheduler(() => storage.onAlarm?.() ?? Promise.resolve(), {
        now,
        onError: (error) => log.error("The service's alarm failed", { error }),
      }),
      onAlarm: null,
      async beforeMigrate(from, to) {
        const file = preMigrationName(from, to, now());
        const key = `backups/${file}`;
        if ((await store.read(key)) === null)
          await store.write(key, await capture(), { ifMatch: "absent" });
        log.info("Snapshot before migrating", { file: key, from, to });
      },
      async startBackups() {
        await backups.start();
      },
      snapshot: async () => (await backups.snapshot()).slice("backups/".length),
      snapshotTo: (path) => copy(path),
      onSnapshot: null,
      tempDir,
      lastBackup: () =>
        backups.last === null
          ? null
          : { at: backups.last.at, file: backups.last.key.slice("backups/".length) },
      close() {
        if (closed) return;
        closed = true;
        storage.scheduler.stop();
        backups.stop();
        backupTimer.stop();
        try {
          database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          log.warn("Checkpoint failed", { error });
        }
        database.close();
        lock.release();
      },
    };
    return storage;
  } catch (error) {
    lock.release();
    throw error;
  }
}
