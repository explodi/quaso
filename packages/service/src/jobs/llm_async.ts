// SPDX-License-Identifier: MIT
/** Serialized job alarms and durable wake-ups for the async service. */
import { SYSTEM } from "../api.ts";
import { silentLogger, type Scheduler, type Sql } from "../ports.ts";
import { createAsyncWakeUps } from "../wakeups.ts";
import { StoredLlm, type StoredLlmOptions } from "../llm/configuration.ts";
import { FALLBACK_MODEL } from "../context.ts";
import { runJobsAsync, type AsyncJobsOptions } from "./runner_async.ts";
import { resumeJobsAsync } from "./store.ts";

export function createAsyncLlm(
  sql: Sql,
  options: Omit<AsyncJobsOptions, "provider"> &
    Pick<StoredLlmOptions, "provider" | "providerFactory" | "dev"> & {
      scheduler: Scheduler;
      wakeUpKey?: string;
    },
) {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const wakeUps = createAsyncWakeUps(sql, options.scheduler, options.wakeUpKey);
  const runtime = new StoredLlm({
    ...options,
    model: options.model ?? FALLBACK_MODEL,
    clock,
    logger,
  });
  const configuration = () => runtime.readAsync(sql);
  let running: Promise<void> | null = null;

  async function alarm() {
    const due = await wakeUps.next();
    const separateDeadline = options.wakeUpKey !== undefined;
    // A running LLM request must leave the host timer available for publication.
    try {
      if (separateDeadline) await wakeUps.cancel();
      const next = await runJobsAsync(sql, SYSTEM, { ...options, ...(await configuration()) });
      await wakeUps.finish(due, next, clock());
    } catch (error) {
      if (separateDeadline) {
        try {
          await wakeUps.schedule(due ?? clock());
        } catch (cause) {
          logger.error("Couldn't re-arm the failed LLM alarm", { error: cause });
        }
      }
      throw error;
    }
  }

  return {
    test: (checkedSql: Sql) => runtime.testAsync(checkedSql),
    configuration,
    schedule: wakeUps.schedule,
    get busy() {
      return running !== null;
    },
    nextWakeUp: () => wakeUps.next(),
    models: async () => {
      await configuration();
      return runtime.models();
    },
    async start() {
      await wakeUps.rearm();
      if (await resumeJobsAsync(sql, SYSTEM, clock())) await wakeUps.schedule(clock());
    },
    alarm(): Promise<void> {
      if (running !== null) return running;
      // Install the promise before any SQL/provider await, and release it after arming.
      running = alarm().finally(() => {
        running = null;
      });
      return running;
    },
    afterCreateJob: () => wakeUps.schedule(clock()),
    async afterUpload(job: { id: number } | null) {
      if (job === null) return;
      try {
        await wakeUps.schedule(clock());
      } catch (error) {
        logger.error("Couldn't arm the wake-up for an upload's job", { job: job.id, error });
      }
    },
  };
}
