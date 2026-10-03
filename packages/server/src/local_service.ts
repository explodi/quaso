// SPDX-License-Identifier: MIT
/**
 * The service with local storage (design §3): the data folder, then the service on its
 * SQLite file, started (migrated after a snapshot) and woken up by the storage's timers.
 */
import { createAsyncService, type Logger, type Service, SYSTEM } from "@quaso/service";
import type { Config } from "./config.ts";
import { type LocalStorage, openLocalStorage } from "./storage/local.ts";
import { VERSION } from "./version.ts";
import { ensureInstanceSecrets } from "../../service/src/instance_secrets.ts";

export interface LocalService {
  service: Service;
  storage: LocalStorage;
  /** The database was new: this is a new instance. */
  created: boolean;
  secretKey: string;
}

/**
 * Opens the data folder and starts the service. With `backups`, also the scheduled
 * snapshots, and with `llm`, the LLM provider and the wake-ups that run jobs (the server
 * wants both; one-off commands, such as the development seed, `token create` and
 * `restore`, don't: they never run jobs). Close `storage` when done.
 */
export async function startLocalService(
  config: Config,
  log: Logger,
  options: { backups?: boolean; lockTimeoutMs?: number; llm?: boolean } = {},
): Promise<LocalService> {
  const storage = await openLocalStorage({
    dataDir: config.dataDir,
    log,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  try {
    const service = createAsyncService({
      sql: storage.batchSql,
      store: storage.store,
      background: storage.backupStatus,
      scheduler: storage.scheduler,
      logger: log,
      version: VERSION,
      setup: "local",
      dev: config.dev,
      beforeMigrate: storage.beforeMigrate,
    });
    // The due work is LLM jobs: only the server runs them. A one-off command leaves the
    // stored wake-up for the server's next start rather than pausing jobs it can't run.
    if (options.llm) storage.onAlarm = () => service.alarm();
    // The admin page shows the last backup.
    storage.onSnapshot = async (snapshot) => {
      await service.recordBackup(SYSTEM, { at: snapshot.at, file: `backups/${snapshot.file}` });
    };
    const started = await service.start();
    const secrets = await ensureInstanceSecrets(storage.batchSql);
    log.info("Database ready", {
      dataDir: config.dataDir,
      schemaVersion: started.schemaVersion.to,
      migratedFrom:
        started.schemaVersion.from === started.schemaVersion.to
          ? undefined
          : started.schemaVersion.from,
      created: started.created,
    });
    if (options.backups) {
      await storage.startBackups();
    }
    return { service, storage, created: started.created, secretKey: secrets.key };
  } catch (error) {
    storage.close();
    throw error;
  }
}
