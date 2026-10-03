// SPDX-License-Identifier: MIT
/**
 * Wake-ups (design §5.6): the service asks the host's scheduler to wake it up later, and
 * stores the time in the `meta` table, so that `start()` arms it again after a restart.
 * Every wake-up goes through `scheduleWakeUp`; `alarm()` clears it once the due work ran.
 */
import { deleteMeta, getMeta, setMeta } from "./db.ts";
import type { Scheduler, Sql, Statement, SyncSql } from "./ports.ts";
import { withRetries } from "./write.ts";

/** The `meta` key of the next wake-up, in milliseconds since the epoch. */
export const NEXT_ALARM = "next_alarm";

/** The stored wake-up, or null. */
export function nextWakeUp(sql: SyncSql): number | null {
  const value = getMeta(sql, NEXT_ALARM);
  return value === null ? null : Number(value);
}

/**
 * Asks for a wake-up at `at` (or as soon as possible if that is past), unless an earlier
 * one is already set: stores it, then arms the scheduler.
 */
export async function scheduleWakeUp(
  sql: SyncSql,
  scheduler: Scheduler,
  at: number,
): Promise<void> {
  const current = nextWakeUp(sql);
  if (current !== null && current <= at) return;
  setMeta(sql, NEXT_ALARM, String(at));
  await scheduler.schedule(at);
}

/** Cancels the wake-up, stored and armed. */
export async function cancelWakeUp(sql: SyncSql, scheduler: Scheduler): Promise<void> {
  deleteMeta(sql, NEXT_ALARM);
  await scheduler.cancel();
}

/** Scheduler side effects follow guarded commits in the same order within one host. */
export function createAsyncWakeUps(sql: Sql, scheduler: Scheduler, key = NEXT_ALARM) {
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  const snapshot = async () => {
    const [revision, stored, queued] = await sql.read([
      {
        sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
      },
      { sql: "SELECT value FROM meta WHERE key = ?", params: [key] },
      { sql: "SELECT 1 AS found FROM jobs WHERE status = 'queued' LIMIT 1" },
    ]);
    return {
      revision: Number(revision[0].revision),
      state: {
        at: stored.length === 0 ? null : Number(stored[0].value),
        queued: queued.length > 0,
      },
    };
  };
  const storedTime = (at: number | null): Statement[] =>
    at === null
      ? [{ sql: "DELETE FROM meta WHERE key = ?", params: [key] }]
      : [
          {
            sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params: [key, String(at)],
          },
        ];
  const arm = async (at: number | null) => {
    if (at === null) await scheduler.cancel();
    else await scheduler.schedule(at);
  };

  return {
    async next(): Promise<number | null> {
      const [rows] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = ?", params: [key] },
      ]);
      return rows.length === 0 ? null : Number(rows[0].value);
    },
    rearm: () =>
      serialize(async () => {
        const { state } = await snapshot();
        await arm(state.at);
      }),
    schedule: (at: number) =>
      serialize(async () => {
        const next = await withRetries(sql, snapshot, (state) => {
          const next = state.at === null ? at : Math.min(at, state.at);
          return { statements: next === state.at ? [] : storedTime(next), result: next };
        });
        // Re-arm even an unchanged time: a previous scheduler call may have failed.
        await arm(next);
      }),
    cancel: () =>
      serialize(async () => {
        await withRetries(sql, snapshot, (state) => ({
          statements: state.at === null ? [] : storedTime(null),
          result: null,
        }));
        await arm(null);
      }),
    finish: (due: number | null, requested: number | null, now: number) =>
      serialize(async () => {
        const next = await withRetries(sql, snapshot, (state) => {
          let next = requested;
          if (next === null && state.queued) next = now;
          if (next !== null) next = Math.max(next, due === null ? 0 : due + 1);
          const newer = state.at !== null && state.at !== due;
          if (newer) next = next === null ? state.at : Math.min(next, state.at!);
          return { statements: next === state.at ? [] : storedTime(next), result: next };
        });
        await arm(next);
      }),
  };
}
