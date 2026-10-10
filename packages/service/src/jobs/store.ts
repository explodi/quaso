// SPDX-License-Identifier: MIT
/**
 * The `jobs` table (design §5.6): rows, their `JobInfo`, and the small writes every part of
 * the job runner shares (progress, tokens, finishing, the activity feed).
 */
import type { JobFailure, JobInfo, JobScope, JobStatus } from "@quaso/core";
import { ActorDirectory, type Author } from "../actors.ts";
import type { Context } from "../context.ts";
import { fromJson, toJson } from "../db.ts";
import { SYSTEM, type Actor } from "../api.ts";
import { forbidden } from "../errors.ts";
import { withRetries } from "../write.ts";
import type { Sql, Statement } from "../ports.ts";
import type { Usage } from "../llm/provider.ts";

/** A job's scope as stored: `JobScope`, with an upload job's string IDs in `strings`. */
export type StoredScope = JobScope & { outdatedLeft?: number };

export type JobSource = "website" | "cli" | "upload";

/** The priorities: single strings first, then uploads, then bulk jobs. */
export const PRIORITY = { string: 0, upload: 1, bulk: 2 } as const;
const PRIORITY_NAMES = ["string", "upload", "bulk"] as const;

/** How many failures a job keeps. */
export const MAX_FAILURES = 200;

/** The error of a job paused by the monthly token budget. */
export const BUDGET_ERROR = "Monthly token budget reached";
/** The error of a job paused because the provider refused the key. */
export const AUTH_ERROR = "The Gemini API key was refused";
/** The error of a job paused because there is no provider. */
export const NO_PROVIDER_ERROR = "LLM translation is off: enter a Gemini API key in Settings.";

export type JobRow = {
  id: number;
  status: JobStatus;
  priority: number;
  source: JobSource;
  scope: string;
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  total: number;
  done: number;
  translated: number;
  proposed: number;
  failed: number;
  skipped: number;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  failures: string;
  error: string | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

export const JOB_COLUMNS = `id, status, priority, source, scope, actor_type, actor_id,
  actor_label, total, done, translated, proposed, failed, skipped, input_tokens,
  output_tokens, thinking_tokens, failures, error, attempts, created_at, started_at,
  finished_at, updated_at`;

/** A job, or undefined. */
export function loadJob(ctx: Context, id: number): JobRow | undefined {
  return ctx.sql.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, id)[0];
}

/** Jobs that may still have work, in the order they run: by priority, then ID. */
export function activeJobs(ctx: Context): JobRow[] {
  return ctx.sql.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'running')
     ORDER BY priority, id`,
  );
}

export function scopeOf(row: Pick<JobRow, "scope">): StoredScope {
  return fromJson<StoredScope>(row.scope);
}

/** Inserts a job and returns its ID. */
export function insertJob(
  ctx: Context,
  job: {
    priority: number;
    source: JobSource;
    scope: StoredScope;
    author: Author;
  },
): number {
  const statement = jobInsertStatement(null, job, 0, ctx.clock());
  const [row] = ctx.sql.query<{ id: number }>(
    `${statement.sql} RETURNING id`,
    ...(statement.params ?? []),
  );
  return row.id;
}

export function jobInsertStatement(
  id: number | null,
  job: { priority: number; source: JobSource; scope: StoredScope; author: Author },
  total: number,
  now: number,
): Statement {
  return {
    sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, actor_label,
      total, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      job.priority,
      job.source,
      toJson(job.scope),
      job.author.type,
      job.author.id,
      job.author.label,
      total,
      now,
      now,
    ],
  };
}

/** Sets a job's status (and error), with `finished_at` for the final ones. */
export function setStatus(
  ctx: Context,
  id: number,
  status: JobStatus,
  error: string | null = null,
): void {
  for (const statement of jobStatusStatements(id, status, error, ctx.clock()))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function jobStatusStatements(
  id: number,
  status: JobStatus,
  error: string | null,
  now: number,
): Statement[] {
  const final = status === "done" || status === "failed" || status === "cancelled";
  const statements: Statement[] = [
    {
      sql: `UPDATE jobs SET status = ?, error = ?, updated_at = ?,
      finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END,
      started_at = CASE WHEN ? = 1 AND started_at IS NULL THEN ? ELSE started_at END WHERE id = ?`,
      params: [status, error, now, final ? 1 : 0, now, status === "running" ? 1 : 0, now, id],
    },
  ];
  if (final) statements.push({ sql: "DELETE FROM job_items WHERE job_id = ?", params: [id] });
  return statements;
}

/** Adds a request's tokens to its job. */
export function addTokens(ctx: Context, id: number, usage: Usage): void {
  const statement = jobTokensStatement(id, usage, ctx.clock());
  ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function jobTokensStatement(id: number, usage: Usage, now: number): Statement {
  return {
    sql: `UPDATE jobs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      thinking_tokens = thinking_tokens + ?, updated_at = ? WHERE id = ?`,
    params: [
      Math.round(usage.inputTokens),
      Math.round(usage.outputTokens),
      Math.round(usage.thinkingTokens),
      now,
      id,
    ],
  };
}

/** Progress to add to a job, after a batch. */
export interface ProgressDelta {
  translated: number;
  proposed: number;
  failed: number;
  skipped: number;
  failures: JobFailure[];
}

/** Adds a batch's progress to its job. */
export function addProgress(ctx: Context, id: number, delta: ProgressDelta): void {
  const job = loadJob(ctx, id);
  if (job === undefined) return;
  const statement = jobProgressStatement(job, delta, ctx.clock());
  ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function jobProgressStatement(job: JobRow, delta: ProgressDelta, now: number): Statement {
  const done = delta.translated + delta.proposed + delta.failed + delta.skipped;
  const failures = [...fromJson<JobFailure[]>(job.failures), ...delta.failures].slice(
    -MAX_FAILURES,
  );
  return {
    sql: `UPDATE jobs SET done = done + ?, translated = translated + ?, proposed = proposed + ?,
       failed = failed + ?, skipped = skipped + ?, failures = ?, total = MAX(total, done + ?),
       updated_at = ?
     WHERE id = ?`,
    params: [
      done,
      delta.translated,
      delta.proposed,
      delta.failed,
      delta.skipped,
      toJson(failures),
      done,
      now,
      job.id,
    ],
  };
}

/** Records the activity of a job: created, or finished. */
export function jobActivity(
  ctx: Context,
  job: Pick<JobRow, "id" | "actor_type" | "actor_id" | "actor_label">,
  summary: string,
  detail: Record<string, unknown>,
): void {
  const statement = jobActivityStatement(job, summary, detail, ctx.clock());
  ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function jobActivityStatement(
  job: Pick<JobRow, "id" | "actor_type" | "actor_id" | "actor_label">,
  summary: string,
  detail: Record<string, unknown>,
  now: number,
): Statement {
  return {
    sql: "INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES ('job', ?, ?, ?, ?, ?, ?)",
    params: [
      job.actor_type,
      job.actor_id,
      job.actor_label,
      summary,
      toJson({ jobId: job.id, ...detail }),
      now,
    ],
  };
}

/** Jobs as `JobInfo`, with their creators' names. */
export function jobInfos(ctx: Context, rows: JobRow[]): JobInfo[] {
  const actors = new ActorDirectory(
    ctx.sql,
    rows.map((row) => ({ type: row.actor_type, id: row.actor_id, label: row.actor_label })),
  );
  return jobInfosFromRows(rows, actors);
}

export function jobInfosFromRows(rows: JobRow[], actors: ActorDirectory): JobInfo[] {
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    priority: PRIORITY_NAMES[row.priority] ?? "bulk",
    scope: scopeOf(row),
    ...(scopeOf(row).outdatedLeft ? { outdatedLeft: scopeOf(row).outdatedLeft } : {}),
    createdBy: actors.info({ type: row.actor_type, id: row.actor_id, label: row.actor_label }),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    progress: {
      total: Math.max(row.total, row.done),
      done: row.done,
      translated: row.translated,
      proposed: row.proposed,
      failed: row.failed,
      skipped: row.skipped,
    },
    tokens: { input: row.input_tokens, output: row.output_tokens, thinking: row.thinking_tokens },
    failures: fromJson<JobFailure[]>(row.failures),
    error: row.error,
  }));
}

export async function pauseActiveAsync(
  sql: Sql,
  actor: Actor,
  reason: string,
  now: number,
): Promise<number> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server pauses translation jobs.");
  return withRetries(
    sql,
    async () => {
      const [revision, jobs] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT id FROM jobs WHERE status IN ('queued', 'running')" },
      ]);
      return { revision: Number(revision[0].revision), state: jobs.length };
    },
    (count) => ({
      statements:
        count === 0
          ? []
          : [
              {
                sql: "UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
                params: [reason, now],
              },
            ],
      result: count,
    }),
  );
}

export async function resumeJobsAsync(sql: Sql, actor: Actor, now: number): Promise<boolean> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server resumes translation jobs.");
  return withRetries(
    sql,
    async () => {
      const [revision, jobs] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT status FROM jobs WHERE status IN ('queued', 'running', 'paused')" },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: { active: jobs.length > 0, paused: jobs.some((job) => job.status === "paused") },
      };
    },
    (state) => ({
      statements: state.paused
        ? [
            {
              sql: "UPDATE jobs SET status = CASE WHEN started_at IS NULL THEN 'queued' ELSE 'running' END, error = NULL, updated_at = ? WHERE status = 'paused'",
              params: [now],
            },
          ]
        : [],
      result: state.active,
    }),
  );
}
