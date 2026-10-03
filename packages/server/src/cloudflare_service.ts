// SPDX-License-Identifier: MIT
/** The server owns service logic; private outbound handlers provide only D1 and R2 storage. */
import { type Fetch, VERSION } from "@quaso/core";
import {
  createAsyncService,
  createD1Sql,
  createR2Store,
  createNightlyBackups,
  type AsyncServiceOptions,
  type Logger,
  ServiceError,
  TimerScheduler,
} from "@quaso/service";
import { unfinishedRestoreAsync } from "../../service/src/backup.ts";
import { loadSettingsAsync } from "../../service/src/settings.ts";
import { FALLBACK_MODEL } from "../../service/src/context.ts";
import { ensureInstanceSecrets } from "../../service/src/instance_secrets.ts";

export type CloudflareServiceOptions = Pick<
  AsyncServiceOptions,
  | "secretKey"
  | "provider"
  | "providerFactory"
  | "llmConcurrency"
  | "monthlyTokenBudget"
  | "defaultModel"
  | "dev"
  | "clock"
> & {
  logger: Logger;
  fetch?: Fetch;
  backups?: boolean;
  retentionDays?: () => number | Promise<number>;
};

export async function startCloudflareService(options: CloudflareServiceOptions) {
  const sql = createD1Sql({ fetch: options.fetch });
  const store = createR2Store({ fetch: options.fetch });
  const log = options.logger;
  let backups: ReturnType<typeof createNightlyBackups> | null = null;
  let restoring = false;
  const timerOptions = {
    now: options.clock,
    onError: (error: unknown) => log.error("Cloudflare alarm failed", { error }),
  };
  const serviceTimer = new TimerScheduler(() => base.alarm(), timerOptions);
  const backupTimer = new TimerScheduler(() => backups?.alarm() ?? Promise.resolve(), timerOptions);
  const base = createAsyncService({
    ...options,
    sql,
    store,
    scheduler: serviceTimer,
    setup: "cloudflare",
    version: VERSION,
    background: {
      busy: () => backups?.busy ?? false,
      nextWakeUp: () => backups?.nextWakeUp ?? null,
    },
  });
  async function startBackups() {
    if (!options.backups) return;
    backups = createNightlyBackups(
      {
        ...base,
        async backupInfo(actor, input) {
          if (restoring || (await unfinishedRestoreAsync(sql))?.resumable)
            throw new ServiceError("unavailable", "Finish restoring before taking a backup.");
          return base.backupInfo(actor, input);
        },
      },
      store,
      {
        scheduler: backupTimer,
        clock: options.clock,
        logger: log,
        retentionDays:
          options.retentionDays ??
          (async () =>
            (await loadSettingsAsync(sql, options.defaultModel ?? FALLBACK_MODEL))
              .backupRetentionDays),
      },
    );
    await backups.start();
  }
  const service = {
    ...base,
    async beginRestore(...args: Parameters<typeof base.beginRestore>) {
      if (restoring) throw new ServiceError("conflict", "A restore is already starting.");
      restoring = true;
      try {
        await backups?.stop();
        // A late backup record would change the restore's revision and break resumption.
        await backups
          ?.settled()
          .catch((error) => log.warn("Backup stopped before restore", { error }));
        return await base.beginRestore(...args);
      } catch (error) {
        if (!(await unfinishedRestoreAsync(sql))?.resumable) await startBackups();
        throw error;
      } finally {
        restoring = false;
      }
    },
    async finishRestore(...args: Parameters<typeof base.finishRestore>) {
      const result = await base.finishRestore(...args);
      await startBackups();
      return result;
    },
  };
  function close() {
    serviceTimer.stop();
    void backups?.stop();
    backupTimer.stop();
  }
  try {
    const started = await service.start();
    const secrets = await ensureInstanceSecrets(sql, options.clock?.());
    if (!(await unfinishedRestoreAsync(sql))?.resumable) await startBackups();
    log.info("Using private Cloudflare storage", {
      schemaVersion: started.schemaVersion.to,
      created: started.created,
    });
    return {
      service,
      secretKey: secrets.key,
      store,
      close,
      created: started.created,
      async alarm() {
        await Promise.all([service.alarm(), backups?.alarm()]);
      },
      async snapshot() {
        if (restoring || (await unfinishedRestoreAsync(sql))?.resumable)
          throw new ServiceError("unavailable", "Finish restoring before taking a backup.");
        if (backups === null) throw new Error("Scheduled backups are not enabled.");
        return backups.snapshot();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
