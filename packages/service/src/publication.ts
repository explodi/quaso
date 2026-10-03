// SPDX-License-Identifier: MIT
/** Durable publication debounce and one host timer shared with LLM deadlines. */
import { createPublisher } from "./publisher.ts";
import { DAY_MS } from "./file_retention.ts";
import type { Clock, Logger, Scheduler, Sql, Statement, Store } from "./ports.ts";
import { NEXT_ALARM } from "./wakeups.ts";
import { withRetries } from "./write.ts";

export const LLM_ALARM = "llm_alarm";
export const PUBLISH_PENDING = "publish_pending";
export const FILE_SWEEP = "file_sweep";
export const PUBLISH_QUIET_MS = 5_000;
export const PUBLISH_MAX_WAIT_MS = 60_000;
const DOWNLOAD_WRITE =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?\b(files|strings|translations|languages|settings)\b/i;
type Pending = { first: number; last: number; due: number; revision: number };
const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export function createPublication(
  sql: Sql,
  store: Store,
  host: Scheduler,
  options: { clock: Clock; model: string; logger: Logger },
) {
  const publisher = createPublisher(sql, store, options);
  let publishing: Promise<void> | null = null;
  let arming: Promise<unknown> = Promise.resolve();
  async function state() {
    const [revision, metadata] = await sql.read([
      REVISION,
      {
        sql: "SELECT key, value FROM meta WHERE key IN (?, ?, ?, ?)",
        params: [LLM_ALARM, PUBLISH_PENDING, NEXT_ALARM, FILE_SWEEP],
      },
    ]);
    const meta = new Map(metadata.map((row) => [String(row.key), String(row.value)]));
    const pending = meta.has(PUBLISH_PENDING)
      ? (JSON.parse(meta.get(PUBLISH_PENDING)!) as Pending)
      : null;
    const llm = meta.has(LLM_ALARM) ? Number(meta.get(LLM_ALARM)) : null;
    const sweep = meta.has(FILE_SWEEP) ? Number(meta.get(FILE_SWEEP)) : null;
    const deadlines = [llm, pending?.due ?? null, sweep].filter((at): at is number => at !== null);
    return {
      revision: Number(revision[0].revision),
      state: {
        pending,
        llm,
        sweep,
        next: deadlines.length === 0 ? null : Math.min(...deadlines),
        armed: meta.get(NEXT_ALARM) ?? null,
      },
    };
  }
  function rearm(): Promise<void> {
    const result = arming.then(async () => {
      const next = await withRetries(sql, state, (current) => {
        const stored = current.next === null ? null : String(current.next);
        return {
          statements:
            stored === current.armed
              ? []
              : stored === null
                ? [{ sql: "DELETE FROM meta WHERE key = ?", params: [NEXT_ALARM] }]
                : [
                    {
                      sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                      params: [NEXT_ALARM, stored],
                    },
                  ],
          result: current.next,
        };
      });
      if (next === null) await host.cancel();
      else await host.schedule(next);
    });
    arming = result.catch(() => {});
    return result;
  }
  async function runReconciliation() {
    const before = (await state()).state;
    await publisher.publish();
    const sweepDue = before.sweep === null || before.sweep <= options.clock();
    if (sweepDue) await publisher.sweep();
    await withRetries(sql, state, (current) => ({
      statements: [
        ...(before.pending !== null &&
        JSON.stringify(current.pending) === JSON.stringify(before.pending)
          ? [{ sql: "DELETE FROM meta WHERE key = ?", params: [PUBLISH_PENDING] }]
          : []),
        ...(sweepDue
          ? [
              {
                sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params: [FILE_SWEEP, String(options.clock() + DAY_MS)],
              },
            ]
          : []),
      ],
      result: null,
    }));
    await rearm();
  }
  function reconcile(): Promise<void> {
    if (publishing !== null) return publishing;
    publishing = runReconciliation().finally(() => {
      publishing = null;
    });
    return publishing;
  }
  const tracked: Sql = {
    ...sql,
    async commit(revision, statements) {
      if (!statements.some((statement) => DOWNLOAD_WRITE.test(statement.sql)))
        return sql.commit(revision, statements);
      const now = options.clock();
      const pending: Statement = {
        sql: `INSERT INTO meta (key, value) SELECT ?, json_object(
        'first', COALESCE((SELECT json_extract(value, '$.first') FROM meta WHERE key = ?), ?),
        'last', ?, 'due', MIN(? + ?, COALESCE((SELECT json_extract(value, '$.first') FROM meta WHERE key = ?), ?) + ?),
        'revision', ?)
        WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'restore')
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        params: [
          PUBLISH_PENDING,
          PUBLISH_PENDING,
          now,
          now,
          now,
          PUBLISH_QUIET_MS,
          PUBLISH_PENDING,
          now,
          PUBLISH_MAX_WAIT_MS,
          revision + 1,
        ],
      };
      const deadline: Statement = {
        sql: `INSERT INTO meta (key, value) SELECT ?, CAST(MIN(at) AS TEXT) FROM (
          SELECT CAST(value AS INTEGER) AS at FROM meta WHERE key = ?
          UNION ALL SELECT json_extract(value, '$.due') AS at FROM meta WHERE key = ?
          UNION ALL SELECT CAST(value AS INTEGER) AS at FROM meta WHERE key = ?
        ) WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'restore')
        HAVING MIN(at) IS NOT NULL
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        params: [NEXT_ALARM, LLM_ALARM, PUBLISH_PENDING, FILE_SWEEP],
      };
      // One guard advance prevents scheduler metadata from consuming worker retry slots.
      const committed = await sql.commit(revision, [...statements, pending, deadline]);
      try {
        await rearm();
      } catch (error) {
        options.logger.error("Couldn't arm publication; its deadline remains stored", { error });
      }
      return committed;
    },
  };
  return {
    sql: tracked,
    llmScheduler: { schedule: () => rearm(), cancel: () => rearm() } satisfies Scheduler,
    get busy() {
      return publishing !== null;
    },
    start: reconcile,
    async alarm() {
      const current = (await state()).state;
      const publishDue = current.pending !== null && current.pending.due <= options.clock();
      const sweepDue = current.sweep !== null && current.sweep <= options.clock();
      if (publishDue || sweepDue) await reconcile();
    },
    async llmDue(): Promise<boolean> {
      const llm = (await state()).state.llm;
      return llm !== null && llm <= options.clock();
    },
  };
}
