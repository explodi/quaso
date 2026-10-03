// SPDX-License-Identifier: MIT
/** Scheduled immutable backups and hourly/daily retention in the instance's store. */
import { DAY_MS } from "./file_retention.ts";
import { silentLogger, type Clock, type Logger, type Scheduler, type Store } from "./ports.ts";
import { StoreConflict } from "./store.ts";

export const HOUR_MS = 3_600_000;
export const DEFAULT_BACKUP_DAYS = 30;
type Backup = { key: string; at: number };
type Extension = "sqlite" | "json.gz";

export function backupKey(at: number, extension: Extension): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `backups/quaso-${stamp}.${extension}`;
}
function backupTime(key: string): number | null {
  const match =
    /^backups\/quaso-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.(?:sqlite|json\.gz)$/.exec(key);
  if (match === null) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) && new Date(at).toISOString() === iso ? at : null;
}
export async function listStoredBackups(store: Store): Promise<Backup[]> {
  const backups: Backup[] = [];
  for await (const object of store.list("backups/")) {
    const at = backupTime(object.key);
    if (at !== null) backups.push({ key: object.key, at });
  }
  return backups.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}
/** Recent copies all survive; older days keep their newest copy, independent of restart order. */
export async function pruneStoredBackups(
  store: Store,
  now: number,
  days = DEFAULT_BACKUP_DAYS,
): Promise<string[]> {
  if (!Number.isSafeInteger(days) || days < 0)
    throw new Error("Backup retention days must be a non-negative integer.");
  const backups = await listStoredBackups(store);
  const daily = new Set<number>();
  const removed: string[] = [];
  for (const backup of backups) {
    if (backup.at >= now - 48 * HOUR_MS) continue;
    const day = Math.floor(backup.at / DAY_MS);
    const inWindow = backup.at >= now - days * DAY_MS;
    if (inWindow && !daily.has(day)) daily.add(day);
    else removed.push(backup.key);
  }
  if (removed.length > 0) await store.delete(removed);
  return removed;
}

export function createStoredBackups(
  store: Store,
  options: {
    capture: () => Promise<Uint8Array>;
    scheduler: Scheduler;
    extension: Extension;
    intervalMs?: number;
    retentionDays?: () => number | Promise<number>;
    clock?: Clock;
    logger?: Logger;
    minimumDelayMs?: number;
    onSnapshot?: (backup: Backup) => void | Promise<void>;
  },
) {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const interval = options.intervalMs ?? HOUR_MS;
  if (!Number.isFinite(interval) || interval <= 0)
    throw new Error("Backup interval must be positive.");
  let last: Backup | null = null;
  let next: number | null = null;
  let stopped = false;
  let running: Promise<string> | null = null;
  let alarming: Promise<void> | null = null;

  async function tell(backup: Backup) {
    try {
      await options.onSnapshot?.(backup);
    } catch (error) {
      logger.warn("Couldn't record the last backup", { error });
    }
  }
  async function arm(at: number) {
    if (stopped) return;
    next = at;
    await options.scheduler.schedule(at);
  }
  async function take() {
    const at = Math.floor(clock() / 1000) * 1000;
    const key = backupKey(at, options.extension);
    const existing = await store.read(key);
    if (existing === null) {
      const bytes = await options.capture();
      try {
        await store.write(key, bytes, { ifMatch: "absent" });
      } catch (error) {
        // Another request may have saved this second's complete copy already.
        if (!(error instanceof StoreConflict) || (await store.read(key)) === null) throw error;
      }
    }
    last = { key, at };
    const pruned = await pruneStoredBackups(
      store,
      clock(),
      (await options.retentionDays?.()) ?? DEFAULT_BACKUP_DAYS,
    );
    logger.info("Snapshot written", { file: key, pruned });
    await tell(last);
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
    get last() {
      return last;
    },
    get busy() {
      return running !== null || alarming !== null;
    },
    get nextWakeUp() {
      return next;
    },
    snapshot,
    async start() {
      last =
        (await listStoredBackups(store)).find((backup) =>
          backup.key.endsWith(`.${options.extension}`),
        ) ?? null;
      if (last !== null) await tell(last);
      const due = last === null ? clock() : last.at + interval;
      await arm(Math.max(due, clock() + (options.minimumDelayMs ?? 60_000)));
    },
    alarm(): Promise<void> {
      if (alarming !== null) return alarming;
      if (stopped || next === null || next > clock()) return Promise.resolve();
      alarming = (async () => {
        try {
          await snapshot();
        } catch (error) {
          await arm(clock() + Math.min(interval, HOUR_MS));
          throw error;
        }
        await arm(clock() + interval);
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
