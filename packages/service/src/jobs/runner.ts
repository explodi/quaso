// SPDX-License-Identifier: MIT
/**
 * The job runner (design §5.6, S5.1): `service.alarm()` calls `runJobs`, which
 *
 * 1. pauses every job when there is no provider or the monthly token budget is used up,
 *    and resumes those the budget paused once it allows;
 * 2. takes the first queued or running job (by priority, then ID) that has work, and runs
 *    its next slice: at most `3 × concurrency` batches, `concurrency` at a time, so that a
 *    run stays within the Durable Object limits on subrequests and duration;
 * 3. for each batch, calls the provider (awaiting it while other requests are served, and
 *    never inside a transaction), checks the answer, retries the strings that failed with
 *    the reasons, and writes the results in one short transaction;
 * 4. finishes the jobs without work left, and returns when to wake up next: now if any job
 *    still has work, later after a failed run (with backoff) or when the budget is used up,
 *    or null.
 */
import type { ProjectSettings } from "@quaso/core";
import type { Context } from "../context.ts";
import { transaction } from "../db.ts";
import { loadFacts } from "../facts.ts";
import { NO_USAGE, ProviderError, type TranslationProvider } from "../llm/provider.ts";
import type { Statement, Scheduler } from "../ports.ts";
import { loadSettings } from "../settings.ts";
import { fileContextOf, fileEnglish, promptContext } from "./prompts.ts";
import {
  activeJobs,
  addTokens,
  AUTH_ERROR,
  BUDGET_ERROR,
  jobActivityStatement,
  jobStatusStatements,
  type JobRow,
  loadJob,
  NO_PROVIDER_ERROR,
  scopeOf,
  setStatus,
} from "./store.ts";
import { budgetExhausted, nextMonthStart, recordRequest, type RequestRecord } from "./usage.ts";
import { type Batch, countWork, hasWork, nextBatches, type WorkScope, workScope } from "./work.ts";
import { writeBatch } from "./write.ts";
import { fileContextRequest } from "./file_context.ts";
import { translateBatch } from "./batch_runner.ts";

export { pauseActiveAsync, resumeJobsAsync } from "./store.ts";

/** What the runner works with besides the database. */
export interface JobsEnv {
  ctx: Context;
  provider: TranslationProvider | null;
  scheduler: Scheduler;
  /** Batches in parallel (`LLM_CONCURRENCY`). */
  concurrency: number;
  /** Monthly token limit, or null for none. */
  monthlyTokenBudget: number | null;
}

/** The default number of batches in parallel. */
export const DEFAULT_CONCURRENCY = 4;
/** Batches per alarm run, per batch in parallel. */
export const SLICE_FACTOR = 3;
/** A job fails after this many failed runs in a row. */
export const MAX_ATTEMPTS = 5;
/** The wait after a failed run, doubled after each. */
export const RETRY_BASE_MS = 5_000;

/** A job's next slice. */
interface Plan {
  job: JobRow;
  scope: WorkScope;
  settings: ProjectSettings;
  model: string;
  instruction: string;
  batches: Batch[];
}

/** Runs due work. Returns when to wake up next, or null. */
export async function runJobs(env: JobsEnv): Promise<number | null> {
  const { ctx } = env;
  const early = transaction(ctx.sql, () => checkPreconditions(env));
  if (early !== undefined) return early;

  for (const job of transaction(ctx.sql, () => activeJobs(ctx))) {
    const plan = transaction(ctx.sql, () => planSlice(env, job.id));
    if (plan === null) continue;
    try {
      await runSlice(env, plan);
      transaction(ctx.sql, () =>
        ctx.sql.run(
          `UPDATE jobs SET attempts = 0, error = NULL
           WHERE id = ? AND attempts > 0 AND status IN ('queued', 'running')`,
          job.id,
        ),
      );
    } catch (error) {
      ctx.logger.error("An LLM job's run failed", { jobId: job.id, error });
      const retryAt = transaction(ctx.sql, () => failedRun(ctx, job.id, error));
      if (retryAt !== null) return retryAt;
    }
    break;
  }
  return transaction(ctx.sql, () => {
    const settings = loadSettings(ctx);
    for (const job of activeJobs(ctx)) {
      if (hasWork(ctx, workScopeOf(ctx, job, settings))) return ctx.clock();
      finishJob(ctx, job.id, "done");
    }
    return budgetWakeUp(ctx);
  });
}

/**
 * Pauses the active jobs when there is no provider or no budget left; resumes those the
 * budget paused when it allows. Returns the next wake-up when nothing can run now.
 */
function checkPreconditions(env: JobsEnv): number | null | undefined {
  const { ctx } = env;
  if (env.provider === null) {
    pauseActive(ctx, NO_PROVIDER_ERROR);
    return null;
  }
  if (budgetExhausted(ctx, env.monthlyTokenBudget)) {
    pauseActive(ctx, BUDGET_ERROR);
    return budgetWakeUp(ctx);
  }
  ctx.sql.run(
    `UPDATE jobs SET status = CASE WHEN started_at IS NULL THEN 'queued' ELSE 'running' END,
       error = NULL, updated_at = ?
     WHERE status = 'paused' AND error = ?`,
    ctx.clock(),
    BUDGET_ERROR,
  );
  return undefined;
}

/** The start of next month when a job waits for the budget, otherwise null. */
function budgetWakeUp(ctx: Context): number | null {
  const paused = ctx.sql.query(
    "SELECT 1 AS found FROM jobs WHERE status = 'paused' AND error = ? LIMIT 1",
    BUDGET_ERROR,
  );
  return paused.length > 0 ? nextMonthStart(ctx.clock()) : null;
}

/**
 * Whether the monthly budget allows another request, checked before each one (a batch, a
 * retry, a file's context) and not only when a run starts: a run's slice can use many
 * times a small budget. When it is used up, the active jobs are paused, which stops the
 * slice; the pairs not processed yet stay for next month. Only the requests already on
 * their way (at most `LLM_CONCURRENCY`) can go over it.
 */
function withinBudget(env: JobsEnv): boolean {
  if (env.monthlyTokenBudget === null) return true;
  const { ctx } = env;
  return transaction(ctx.sql, () => {
    if (!budgetExhausted(ctx, env.monthlyTokenBudget)) return true;
    pauseActive(ctx, BUDGET_ERROR);
    return false;
  });
}

/** Pauses every queued or running job with a reason. */
export function pauseActive(ctx: Context, reason: string): number {
  const rows = ctx.sql.query<{ id: number }>(
    `UPDATE jobs SET status = 'paused', error = ?, updated_at = ?
     WHERE status IN ('queued', 'running') RETURNING id`,
    reason,
    ctx.clock(),
  );
  if (rows.length > 0) {
    ctx.logger.warn("LLM jobs paused", { jobs: rows.map((row) => row.id), reason });
  }
  return rows.length;
}

/**
 * Resumes every paused job (after a restart: the key or the budget may have changed; the
 * runner pauses them again if not). Returns whether any job may have work.
 */
export function resumeJobs(ctx: Context): boolean {
  ctx.sql.run(
    `UPDATE jobs SET status = CASE WHEN started_at IS NULL THEN 'queued' ELSE 'running' END,
       error = NULL, updated_at = ?
     WHERE status = 'paused'`,
    ctx.clock(),
  );
  return (
    ctx.sql.query("SELECT 1 AS found FROM jobs WHERE status IN ('queued', 'running') LIMIT 1")
      .length > 0
  );
}

/** The work scope of a stored job. */
export function workScopeOf(ctx: Context, job: JobRow, settings: ProjectSettings): WorkScope {
  return workScope(ctx, job.id, job.source, scopeOf(job), settings.llm);
}

/** The job's next slice, marking it running; null (and done) when it has no work left. */
function planSlice(env: JobsEnv, jobId: number): Plan | null {
  const { ctx } = env;
  const job = loadJob(ctx, jobId);
  if (job === undefined || (job.status !== "queued" && job.status !== "running")) return null;
  const settings = loadSettings(ctx);
  const scope = workScopeOf(ctx, job, settings);
  const concurrency = Math.max(1, env.concurrency);
  const batches = nextBatches(ctx, scope, settings.llm.batchSize, concurrency * SLICE_FACTOR);
  if (batches.length === 0) {
    finishJob(ctx, job.id, "done");
    return null;
  }
  ctx.sql.run("UPDATE jobs SET total = ? WHERE id = ?", job.done + countWork(ctx, scope), job.id);
  if (job.status === "queued") setStatus(ctx, job.id, "running");
  const stored = scopeOf(job);
  return {
    job,
    scope,
    settings,
    model: stored.model ?? settings.llm.model,
    instruction: stored.instruction ?? "",
    batches,
  };
}

/** Ends a job, with an activity row and a log line. */
export function finishJob(
  ctx: Context,
  jobId: number,
  status: "done" | "failed" | "cancelled",
  error: string | null = null,
): void {
  const job = loadJob(ctx, jobId);
  if (job === undefined) return;
  const plan = planJobFinish(job, status, error, ctx.clock());
  for (const statement of plan.statements) ctx.sql.run(statement.sql, ...(statement.params ?? []));
  ctx.logger.info("LLM job ended", {
    jobId,
    status,
    translated: job.translated,
    proposed: job.proposed,
    failed: job.failed,
    skipped: job.skipped,
  });
}

export function planJobFinish(
  job: JobRow,
  status: "done" | "failed" | "cancelled",
  error: string | null,
  now: number,
): { statements: Statement[]; row: JobRow } {
  const statements = jobStatusStatements(job.id, status, error, now);
  if (status === "done")
    statements.push({ sql: "UPDATE jobs SET total = done WHERE id = ?", params: [job.id] });
  const counts = [
    `${job.translated} translated`,
    job.proposed > 0 ? `${job.proposed} proposed` : "",
    job.failed > 0 ? `${job.failed} failed` : "",
    job.skipped > 0 ? `${job.skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const verb = status === "done" ? "finished" : status;
  statements.push(
    jobActivityStatement(
      job,
      `Translation job ${job.id} ${verb}: ${counts}`,
      {
        status,
        translated: job.translated,
        proposed: job.proposed,
        failed: job.failed,
        skipped: job.skipped,
        tokens: job.input_tokens + job.output_tokens + job.thinking_tokens,
        ...(error ? { error } : {}),
      },
      now,
    ),
  );
  return {
    statements,
    row: {
      ...job,
      status,
      error,
      updated_at: now,
      finished_at: now,
      total: status === "done" ? job.done : job.total,
    },
  };
}

/** After a run failed unexpectedly: a later retry, or the job fails after `MAX_ATTEMPTS`. */
function failedRun(ctx: Context, jobId: number, error: unknown): number | null {
  const job = loadJob(ctx, jobId);
  if (job === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    ctx.sql.run("UPDATE jobs SET attempts = ? WHERE id = ?", attempts, jobId);
    finishJob(ctx, jobId, "failed", `The job failed ${attempts} times in a row: ${message}`);
    return null;
  }
  ctx.sql.run(
    "UPDATE jobs SET attempts = ?, error = ?, updated_at = ? WHERE id = ?",
    attempts,
    message,
    ctx.clock(),
    jobId,
  );
  return ctx.clock() + RETRY_BASE_MS * 2 ** (attempts - 1);
}

/** Whether a job is still queued or running (not cancelled or paused meanwhile). */
function stillRunning(ctx: Context, jobId: number): boolean {
  const job = transaction(ctx.sql, () => loadJob(ctx, jobId));
  return job !== undefined && (job.status === "queued" || job.status === "running");
}

/** Runs a slice: the files' contexts first, then the batches, `concurrency` at a time. */
async function runSlice(env: JobsEnv, plan: Plan): Promise<void> {
  const { ctx } = env;
  if (plan.settings.llm.context.fileContext) {
    const files = new Map(plan.batches.map((batch) => [batch.fileId, batch.path]));
    for (const [fileId, path] of files) {
      const file = transaction(ctx.sql, () => fileContextOf(ctx, fileId));
      if (file.context.trim() !== "" || file.generated !== null) continue;
      if (transaction(ctx.sql, () => askedForContext(ctx, plan.job, fileId))) continue;
      if (!stillRunning(ctx, plan.job.id) || !withinBudget(env)) return;
      await generateFileContext(env, plan, fileId, path);
    }
  }
  const queue = [...plan.batches];
  const worker = async () => {
    while (queue.length > 0) {
      if (!stillRunning(ctx, plan.job.id)) return;
      await runBatch(env, plan, queue.shift()!);
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, env.concurrency), queue.length) },
    worker,
  );
  const results = await Promise.allSettled(workers);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

/** Records a request and adds its tokens to the job. Returns the request's ID. */
function record(env: JobsEnv, plan: Plan, entry: Omit<RequestRecord, "jobId" | "provider">) {
  const { ctx } = env;
  return transaction(ctx.sql, () => {
    const id = recordRequest(ctx, {
      ...entry,
      jobId: plan.job.id,
      provider: env.provider?.name ?? "none",
    });
    addTokens(ctx, plan.job.id, entry.usage);
    return id;
  });
}

/**
 * Whether the job already asked for a file's context. A job asks at most once, even when
 * that failed or gave nothing: otherwise every alarm run of the job would repeat the same
 * failing request (and its retries) before its batches. A later job asks again.
 */
function askedForContext(ctx: Context, job: JobRow, fileId: number): boolean {
  return (
    ctx.sql.query(
      `SELECT 1 AS found FROM llm_requests
     WHERE created_at >= ? AND job_id = ? AND file_id = ? AND language IS NULL LIMIT 1`,
      job.created_at,
      job.id,
      fileId,
    ).length > 0
  );
}

/** Generates a file's context once, from its English, and caches it. */
async function generateFileContext(
  env: JobsEnv,
  plan: Plan,
  fileId: number,
  path: string,
): Promise<void> {
  const { ctx } = env;
  const provider = env.provider!;
  const english = transaction(ctx.sql, () => fileEnglish(ctx, fileId));
  if (english === "") return;
  const { settings } = plan;
  const started = ctx.clock();
  try {
    const result = await provider.generateText(
      fileContextRequest(settings, plan.model, path, english),
    );
    const text = result.text.trim();
    record(env, plan, {
      language: null,
      fileId,
      model: result.model ?? plan.model,
      strings: 0,
      usage: result.usage,
      durationMs: result.durationMs ?? ctx.clock() - started,
      outcome: "ok",
      error: null,
    });
    if (text !== "") {
      transaction(ctx.sql, () =>
        ctx.sql.run(
          "UPDATE files SET generated_context = ? WHERE id = ? AND generated_context IS NULL",
          text,
          fileId,
        ),
      );
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    record(env, plan, {
      language: null,
      fileId,
      model: plan.model,
      strings: 0,
      usage: error.usage ?? NO_USAGE,
      durationMs: ctx.clock() - started,
      outcome: error.kind === "blocked" ? "blocked" : "failed",
      error: error.message,
    });
    ctx.logger.warn("Couldn't generate a file's context", { fileId, error: error.message });
  }
}

/** Runs one batch: requests, checks, retries with the reasons, then writes the results. */
async function runBatch(env: JobsEnv, plan: Plan, batch: Batch): Promise<void> {
  const { ctx } = env;
  const provider = env.provider!;
  const { settings } = plan;
  const { facts, context } = transaction(ctx.sql, () => {
    const facts = loadFacts(ctx);
    return { facts, context: promptContext(ctx, settings, facts, batch, plan.instruction) };
  });
  const result = await translateBatch({
    provider,
    settings,
    facts,
    context,
    batch,
    model: plan.model,
    clock: ctx.clock,
    canRequest: () => stillRunning(ctx, plan.job.id) && withinBudget(env),
    record: (entry) => record(env, plan, entry),
    pauseForAuth(error) {
      transaction(ctx.sql, () => {
        const job = loadJob(ctx, plan.job.id);
        if (job?.status === "queued" || job?.status === "running")
          setStatus(ctx, plan.job.id, "paused", AUTH_ERROR);
      });
      ctx.logger.error("The provider refused the API key; the job is paused", {
        jobId: plan.job.id,
        error: error.message,
      });
    },
  });
  writeBatch(ctx, plan.job.id, batch, result.successes, result.failures);
}
