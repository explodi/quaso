// SPDX-License-Identifier: MIT
/** Portable nightly exports for a sleeping host; completed store objects survive restarts. */
import { SYSTEM, type ServiceApi } from "./api.ts";
import { backupJsonStream, type BackupReader, withBackupRetries } from "./backup.ts";
import { DAY_MS } from "./file_retention.ts";
import { silentLogger, type Clock, type Logger, type Scheduler, type Store } from "./ports.ts";
import { backupKey, DEFAULT_BACKUP_DAYS, HOUR_MS, listStoredBackups } from "./stored_backups.ts";
import { StoreConflict } from "./store.ts";

export function nextNightlyBackup(now: number): number {
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3);
  return today > now ? today : today + DAY_MS;
}

async function gzipBackup(service: BackupReader): Promise<Uint8Array> {
  return withBackupRetries(async () => {
    // Compression can replace the read error; keep revision conflicts so they retry.
    let failure: unknown;
    const reader: BackupReader = {
      backupInfo: (actor, input) => service.backupInfo(actor, input),
      backupTables: (actor, input) =>
        service.backupTables(actor, input).catch((error) => {
          failure = error;
          throw error;
        }),
    };
    const gzip = new CompressionStream("gzip");
    const stream = backupJsonStream(reader, SYSTEM).pipeThrough({
      writable: gzip.writable as WritableStream<Uint8Array>,
      readable: gzip.readable,
    });
    try {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      throw failure ?? error;
    }
  });
}

export function createNightlyBackups(
  service: Pick<ServiceApi, "backupInfo" | "backupTables" | "recordBackup">,
  store: Store,
  options: {
    scheduler: Scheduler;
    retentionDays?: () => number | Promise<number>;
    clock?: Clock;
    logger?: Logger;
  },
) {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  let next: number | null = null;
  let stopped = false;
  let running: Promise<string> | null = null;
  let alarming: Promise<void> | null = null;

  async function arm(at: number) {
    if (stopped) return;
    next = at;
    await options.scheduler.schedule(at);
  }
  async function record(at: number, file: string) {
    await service.recordBackup(SYSTEM, { at, file });
  }
  async function take() {
    const days = (await options.retentionDays?.()) ?? DEFAULT_BACKUP_DAYS;
    if (!Number.isSafeInteger(days) || days < 1)
      throw new Error("Nightly backup retention must be a positive number of days.");
    const at = Math.floor(clock() / 1000) * 1000;
    const key = backupKey(at, "json.gz");
    if ((await store.read(key)) === null) {
      const bytes = await gzipBackup(service);
      try {
        await store.write(key, bytes, { ifMatch: "absent" });
      } catch (error) {
        if (!(error instanceof StoreConflict) || (await store.read(key)) === null) throw error;
      }
    }
    // Never discard recovery copies until the replacement is durable and recorded.
    await record(at, key);
    const cutoff = clock() - days * DAY_MS;
    const expired = (await listStoredBackups(store))
      .filter((backup) => backup.key.endsWith(".json.gz") && backup.at < cutoff)
      .map((backup) => backup.key);
    if (expired.length > 0) await store.delete(expired);
    logger.info("Nightly backup written", { key, deleted: expired });
    return key;
  }
  function snapshot(): Promise<string> {
    if (running !== null) return running;
    running = take().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    get busy() {
      return running !== null || alarming !== null;
    },
    get nextWakeUp() {
      return next;
    },
    snapshot,
    /** After stop(), wait for the export before starting an operation that changes its database. */
    async settled() {
      await Promise.all([running, alarming]);
    },
    async start() {
      const last = (await listStoredBackups(store)).find((backup) =>
        backup.key.endsWith(".json.gz"),
      );
      if (last !== undefined) await record(last.at, last.key);
      const due = nextNightlyBackup(last?.at ?? clock());
      await arm(Math.max(due, clock() + 60_000));
    },
    alarm(): Promise<void> {
      if (alarming !== null) return alarming;
      if (stopped || next === null || next > clock()) return Promise.resolve();
      alarming = (async () => {
        try {
          await snapshot();
        } catch (error) {
          await arm(clock() + HOUR_MS);
          throw error;
        }
        await arm(nextNightlyBackup(clock()));
      })().finally(() => {
        alarming = null;
      });
      return alarming;
    },
    stop() {
      stopped = true;
      next = null;
      return options.scheduler.cancel();
    },
  };
}
