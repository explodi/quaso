// SPDX-License-Identifier: MIT
/** Async alarm slices use consistent reads and guarded writes around every provider request. */
import type { ProjectSettings } from "@quaso/core";
import { ActorDirectory } from "../actors.ts";
import { SYSTEM, type Actor } from "../api.ts";
import { FALLBACK_MODEL } from "../context.ts";
import { forbidden, ServiceError } from "../errors.ts";
import type { Facts } from "../facts.ts";
import { glossaryTermFromRow, type GlossaryRow } from "../glossary.ts";
import { toLanguage, type LanguageRow } from "../languages.ts";
import type { TranslationProvider } from "../llm/provider.ts";
import { silentLogger, type Clock, type Logger, type Sql, type Statement } from "../ports.ts";
import { settingsFromData } from "../settings.ts";
import { RevisionConflict, withRetries } from "../write.ts";
import { memoryRead, memoryMatches } from "./memory.ts";
import { translateBatch } from "./batch_runner.ts";
import { generateFileContextAsync } from "./file_context.ts";
import { promptContextAsync } from "./prompts.ts";
import {
  DEFAULT_CONCURRENCY,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  SLICE_FACTOR,
  planJobFinish,
} from "./runner.ts";
import {
  AUTH_ERROR,
  BUDGET_ERROR,
  JOB_COLUMNS,
  NO_PROVIDER_ERROR,
  jobStatusStatements,
  scopeOf,
  type JobRow,
} from "./store.ts";
import { monthlyUsage, nextMonthStart, recordRequestAsync } from "./usage.ts";
import { readJobWork, type Batch } from "./work.ts";
import { writeBatchAsync } from "./write.ts";

export interface AsyncJobsOptions {
  provider: TranslationProvider | null;
  concurrency?: number;
  monthlyTokenBudget?: number | null;
  clock?: Clock;
  logger?: Logger;
  model?: string;
}
type RunEnv = {
  databaseInOrder<T>(operation: () => Promise<T>): Promise<T>;
  sql: Sql;
  provider: TranslationProvider | null;
  concurrency: number;
  monthlyTokenBudget: number | null;
  clock: Clock;
  logger: Logger;
  model: string;
};
type JobPlan = {
  job: JobRow;
  settings: ProjectSettings;
  model: string;
  instruction: string;
  batches: Batch[];
};
const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};
const ACTIVE_JOBS: Statement = {
  sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'running') ORDER BY priority, id`,
};

/** The host serializes alarm calls and schedules the returned next wake-up. */
export async function runJobsAsync(
  sql: Sql,
  actor: Actor,
  options: AsyncJobsOptions,
): Promise<number | null> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server runs translation jobs.");
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isFinite(concurrency) || concurrency < 1)
    throw new RangeError("Concurrency must be positive.");
  // Sibling workers must not exhaust guard retries against each other's database work.
  let databaseWork: Promise<unknown> = Promise.resolve();
  const env: RunEnv = {
    databaseInOrder<T>(operation: () => Promise<T>): Promise<T> {
      const result = databaseWork.then(operation);
      databaseWork = result.catch(() => {});
      return result;
    },
    sql,
    provider: options.provider,
    concurrency: Math.floor(concurrency),
    monthlyTokenBudget: options.monthlyTokenBudget ?? null,
    clock: options.clock ?? Date.now,
    logger: options.logger ?? silentLogger,
    model: options.model ?? FALLBACK_MODEL,
  };
  const early = await preconditions(env);
  if (early !== undefined) return early;
  const [jobs] = await sql.read([ACTIVE_JOBS]);
  for (const job of jobs as JobRow[]) {
    const plan = await prepareJob(env, job.id, false);
    if (plan === null) continue;
    try {
      await runSlice(env, plan);
      await changeJob(env, job.id, (current) => ({
        statements:
          current !== undefined &&
          current.created_at === plan.job.created_at &&
          active(current) &&
          current.attempts > 0
            ? [{ sql: "UPDATE jobs SET attempts = 0, error = NULL WHERE id = ?", params: [job.id] }]
            : [],
        result: null,
      }));
    } catch (error) {
      env.logger.error("An LLM job's run failed", { jobId: job.id, error });
      const retry = await failedRun(env, plan.job, error);
      if (retry !== null) return retry;
    }
    break;
  }
  const [remaining] = await sql.read([ACTIVE_JOBS]);
  for (const job of remaining as JobRow[]) {
    if ((await prepareJob(env, job.id, true)) !== null) return env.clock();
  }
  const [paused] = await sql.read([
    {
      sql: "SELECT 1 AS found FROM jobs WHERE status = 'paused' AND error = ? LIMIT 1",
      params: [BUDGET_ERROR],
    },
  ]);
  return paused.length > 0 ? nextMonthStart(env.clock()) : null;
}

function active(job: JobRow): boolean {
  return job.status === "queued" || job.status === "running";
}
function changeJob<T>(
  env: RunEnv,
  id: number,
  decide: (job: JobRow | undefined) => { statements: Statement[]; result: T },
): Promise<T> {
  return withRetries(
    env.sql,
    async () => {
      const [revision, jobs] = await env.sql.read([
        REVISION,
        { sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, params: [id] },
      ]);
      return { revision: Number(revision[0].revision), state: jobs[0] as JobRow | undefined };
    },
    decide,
  );
}

function logFinished(env: RunEnv, job: JobRow) {
  env.logger.info("LLM job ended", {
    jobId: job.id,
    status: job.status,
    translated: job.translated,
    proposed: job.proposed,
    failed: job.failed,
    skipped: job.skipped,
  });
}

async function preconditions(env: RunEnv): Promise<number | null | undefined> {
  const now = env.clock();
  const committed = await env.databaseInOrder(() =>
    withRetries(
      env.sql,
      async () => {
        const [revision, monthly, jobs] = await env.sql.read([
          REVISION,
          monthlyUsage(now),
          {
            sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'running', 'paused')`,
          },
        ]);
        return {
          revision: Number(revision[0].revision),
          state: { used: Number(monthly[0].n ?? 0), jobs: jobs as JobRow[] },
        };
      },
      (
        state,
      ): {
        statements: Statement[];
        result: { next: number | null | undefined; paused: number[]; reason: string | null };
      } => {
        const reason =
          env.provider === null
            ? NO_PROVIDER_ERROR
            : env.monthlyTokenBudget !== null && state.used >= env.monthlyTokenBudget
              ? BUDGET_ERROR
              : null;
        const running = state.jobs.filter(active);
        if (reason !== null) {
          const waitingForBudget =
            reason === BUDGET_ERROR &&
            (running.length > 0 ||
              state.jobs.some((job) => job.status === "paused" && job.error === BUDGET_ERROR));
          return {
            statements:
              running.length === 0
                ? []
                : [
                    {
                      sql: "UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
                      params: [reason, now],
                    },
                  ],
            result: {
              next: waitingForBudget ? nextMonthStart(now) : null,
              paused: running.map((job) => job.id),
              reason,
            },
          };
        }
        const budgetPaused = state.jobs.some(
          (job) => job.status === "paused" && job.error === BUDGET_ERROR,
        );
        return {
          statements: budgetPaused
            ? [
                {
                  sql: "UPDATE jobs SET status = CASE WHEN started_at IS NULL THEN 'queued' ELSE 'running' END, error = NULL, updated_at = ? WHERE status = 'paused' AND error = ?",
                  params: [now, BUDGET_ERROR],
                },
              ]
            : [],
          result: { next: undefined, paused: [] as number[], reason: null },
        };
      },
    ),
  );
  if (committed.paused.length > 0)
    env.logger.warn("LLM jobs paused", { jobs: committed.paused, reason: committed.reason });
  return committed.next;
}

async function canRequest(env: RunEnv, jobId: number, createdAt: number): Promise<boolean> {
  const now = env.clock();
  const committed = await env.databaseInOrder(() =>
    withRetries(
      env.sql,
      async () => {
        const [revision, monthly, jobs] = await env.sql.read([
          REVISION,
          monthlyUsage(now),
          ACTIVE_JOBS,
        ]);
        return {
          revision: Number(revision[0].revision),
          state: { used: Number(monthly[0].n ?? 0), jobs: jobs as JobRow[] },
        };
      },
      (state) => {
        const exhausted = env.monthlyTokenBudget !== null && state.used >= env.monthlyTokenBudget;
        const pause = exhausted && state.jobs.length > 0;
        return {
          statements: pause
            ? [
                {
                  sql: "UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
                  params: [BUDGET_ERROR, now],
                },
              ]
            : [],
          result: {
            allowed:
              !exhausted &&
              state.jobs.some((job) => job.id === jobId && job.created_at === createdAt),
            paused: pause ? state.jobs.map((job) => job.id) : [],
          },
        };
      },
    ),
  );
  if (committed.paused.length > 0)
    env.logger.warn("LLM jobs paused", { jobs: committed.paused, reason: BUDGET_ERROR });
  return committed.allowed;
}

/** Scope/count reads and status changes must use the same revision. */
async function prepareJob(env: RunEnv, jobId: number, inspect: boolean): Promise<JobPlan | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [revisionRows, jobs, settingsRows] = await env.sql.read([
      REVISION,
      { sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, params: [jobId] },
      { sql: "SELECT data FROM settings WHERE id = 1" },
    ]);
    const job = jobs[0] as JobRow | undefined;
    if (job === undefined || !active(job)) return null;
    const revision = Number(revisionRows[0].revision);
    const settings = settingsFromData(
      (settingsRows[0]?.data as string | undefined) ?? null,
      env.model,
    );
    const stored = scopeOf(job);
    const work = await readJobWork(
      env.sql,
      job.id,
      job.source,
      stored,
      settings.llm,
      inspect ? 0 : env.concurrency * SLICE_FACTOR,
    );
    if (work.revision !== revision) continue;
    const finish = work.total === 0 ? planJobFinish(job, "done", null, env.clock()) : null;
    const statements: Statement[] = finish?.statements ?? [];
    if (!inspect && finish === null) {
      const total = job.done + work.total;
      if (total !== job.total)
        statements.push({ sql: "UPDATE jobs SET total = ? WHERE id = ?", params: [total, job.id] });
      if (job.status === "queued")
        statements.push(...jobStatusStatements(job.id, "running", null, env.clock()));
    }
    try {
      if (statements.length > 0) await env.sql.commit(revision, statements);
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
    if (finish !== null) {
      logFinished(env, finish.row);
      return null;
    }
    return {
      job,
      settings,
      model: stored.model ?? settings.llm.model,
      instruction: stored.instruction ?? "",
      batches: work.batches,
    };
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

async function failedRun(env: RunEnv, original: JobRow, error: unknown): Promise<number | null> {
  const jobId = original.id;
  const message = error instanceof Error ? error.message : String(error);
  const now = env.clock();
  const committed = await changeJob(env, jobId, (job) => {
    if (job === undefined || job.created_at !== original.created_at || !active(job))
      return {
        statements: [],
        result: { next: null as number | null, finished: null as JobRow | null },
      };
    const attempts = job.attempts + 1;
    const finish =
      attempts >= MAX_ATTEMPTS
        ? planJobFinish(job, "failed", `The job failed ${attempts} times in a row: ${message}`, now)
        : null;
    return {
      statements: [
        {
          sql: "UPDATE jobs SET attempts = ?, error = ?, updated_at = ? WHERE id = ?",
          params: [attempts, message, now, jobId],
        },
        ...(finish?.statements ?? []),
      ],
      result: {
        next: finish === null ? now + RETRY_BASE_MS * 2 ** (attempts - 1) : null,
        finished: finish?.row ?? null,
      },
    };
  });
  if (committed.finished !== null) logFinished(env, committed.finished);
  return committed.next;
}

async function runSlice(env: RunEnv, plan: JobPlan): Promise<void> {
  if (plan.settings.llm.translationMemory) {
    const remaining: Batch[] = [];
    for (const batch of plan.batches) {
      const { facts } = await batchContext(env, plan, batch);
      const [rows] = await env.sql.read([memoryRead(batch)]);
      const matches = memoryMatches(batch, rows, facts);
      const outcomes = await writeBatchAsync(
        env.sql,
        SYSTEM,
        plan.job.id,
        batch,
        matches,
        new Map(),
        {
          now: env.clock(),
          model: env.model,
          expectedJobCreatedAt: plan.job.created_at,
        },
      );
      const items = batch.items.filter((item) => !outcomes?.has(item.stringId));
      if (items.length > 0) remaining.push({ ...batch, items });
    }
    plan.batches = remaining;
  }
  if (plan.settings.llm.context.fileContext) {
    for (const fileId of new Set(plan.batches.map((batch) => batch.fileId))) {
      if (!(await canRequest(env, plan.job.id, plan.job.created_at))) return;
      await generateFileContextAsync(env.sql, SYSTEM, plan.job.id, fileId, env);
    }
  }
  const queue = [...plan.batches];
  const worker = async () => {
    for (;;) {
      const batch = queue.shift();
      if (batch === undefined) return;
      if (!(await canRequest(env, plan.job.id, plan.job.created_at))) return;
      await runBatch(env, plan, batch);
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(env.concurrency, queue.length) }, worker),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function runBatch(env: RunEnv, plan: JobPlan, batch: Batch): Promise<void> {
  const provider = env.provider!;
  const { facts, context } = await env.databaseInOrder(() => batchContext(env, plan, batch));
  const result = await translateBatch({
    provider,
    settings: plan.settings,
    facts,
    context,
    batch,
    model: plan.model,
    clock: env.clock,
    canRequest: () => canRequest(env, plan.job.id, plan.job.created_at),
    record: (entry) =>
      env.databaseInOrder(() =>
        recordRequestAsync(
          env.sql,
          SYSTEM,
          { ...entry, jobId: plan.job.id, provider: provider.name },
          env.clock(),
          plan.job.created_at,
        ),
      ),
    async pauseForAuth(error) {
      await env.databaseInOrder(() =>
        changeJob(env, plan.job.id, (job) => ({
          statements:
            job !== undefined && job.created_at === plan.job.created_at && active(job)
              ? jobStatusStatements(job.id, "paused", AUTH_ERROR, env.clock())
              : [],
          result: null,
        })),
      );
      env.logger.error("The provider refused the API key; the job is paused", {
        jobId: plan.job.id,
        error: error.message,
      });
    },
  });
  await env.databaseInOrder(() =>
    writeBatchAsync(env.sql, SYSTEM, plan.job.id, batch, result.successes, result.failures, {
      now: env.clock(),
      model: env.model,
      expectedJobCreatedAt: plan.job.created_at,
    }),
  );
}

async function batchContext(env: RunEnv, plan: JobPlan, batch: Batch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [revision, settingsRows, languageRows, glossaryRows] = await env.sql.read([
      REVISION,
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
      { sql: "SELECT * FROM glossary_terms" },
    ]);
    const settings = settingsFromData(
      (settingsRows[0]?.data as string | undefined) ?? null,
      env.model,
    );
    const languages = (languageRows as LanguageRow[]).map(toLanguage);
    const actors = new ActorDirectory({ users: [], tokens: [] });
    const facts: Facts = {
      sourceLanguage: settings.sourceLanguage,
      syntax: settings.syntax,
      languages: new Map(languages.map((language) => [language.tag, language])),
      glossary: (glossaryRows as GlossaryRow[]).map((row) => glossaryTermFromRow(row, actors)),
    };
    const context = await promptContextAsync(
      env.sql,
      plan.settings,
      facts,
      batch,
      plan.instruction,
    );
    const [latest] = await env.sql.read([REVISION]);
    if (Number(latest[0].revision) === Number(revision[0].revision)) return { facts, context };
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}
