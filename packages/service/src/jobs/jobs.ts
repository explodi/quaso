// SPDX-License-Identifier: MIT
/**
 * Starting and following LLM jobs (design §5.6, S5.6; LLM-2, LLM-3): one string, a
 * selection, a file, a language or everything, from the website or `quaso translate`; and
 * the automatic job an upload queues. A dry run counts the work and estimates the tokens
 * without creating anything.
 */
import {
  canonicalLanguageTag,
  type CreateJobRequest,
  type CreateJobResult,
  type JobEstimate,
  type JobInfo,
  type JobsQuery,
  type JobsResult,
  type ProjectSettings,
} from "@quaso/core";
import {
  ActorDirectory,
  type ActorRows,
  actorReadStatements,
  authorFor,
  SYSTEM_AUTHOR,
} from "../actors.ts";
import type { Actor } from "../api.ts";
import type { Context } from "../context.ts";
import { badRequest, notFound, ServiceError } from "../errors.ts";
import { loadFacts } from "../facts.ts";
import { loadLanguages, toLanguage, type LanguageRow } from "../languages.ts";
import {
  estimateTokens,
  expectedOutputTokens,
  renderPrompt,
  type PromptContext,
} from "../llm/prompt.ts";
import {
  can,
  denied,
  languageLimit,
  permissionReadStatements,
  permissionsFromRows,
} from "../permissions.ts";
import { withRetries, RevisionConflict } from "../write.ts";
import { silentLogger, type Logger } from "../ports.ts";
import type { Sql, Statement } from "../ports.ts";
import { loadSettings, settingsFromData } from "../settings.ts";
import { promptContext, promptContextAsync, promptString } from "./prompts.ts";
import { finishJob, planJobFinish } from "./runner.ts";
import {
  insertJob,
  jobInsertStatement,
  jobActivityStatement,
  JOB_COLUMNS,
  jobActivity,
  jobInfos,
  jobInfosFromRows,
  type JobRow,
  type JobSource,
  loadJob,
  PRIORITY,
  scopeOf,
  type StoredScope,
} from "./store.ts";
import { budgetExhausted, monthlyUsage } from "./usage.ts";
import {
  outdatedCountStatement,
  batchesOf,
  countWork,
  workIn,
  workScope,
  readJobWork,
  type Batch,
} from "./work.ts";

/** Jobs `GET /jobs` lists. */
export const JOBS_LISTED = 50;

export const LLM_UNAVAILABLE = "LLM translation is off: enter a Gemini API key in Settings.";

/** The error when there is no provider. */
export function llmUnavailable(): ServiceError {
  return new ServiceError("llm_unavailable", LLM_UNAVAILABLE);
}

/** The error when the monthly budget is used up. */
export function budgetExceeded(): ServiceError {
  return new ServiceError(
    "budget_exceeded",
    "The monthly token budget is used up: LLM translation resumes next month, or when " +
      "the budget in Settings is raised.",
  );
}

export interface CreateOptions {
  llmAvailable: boolean;
  monthlyTokenBudget: number | null;
}

/**
 * `POST /jobs`, inside the caller's transaction: checks the scope (a limited manager's
 * languages only), then returns the estimate of a dry run, or the new job. A job with
 * nothing to do is done at once.
 */
export function createJob(
  ctx: Context,
  actor: Actor,
  request: CreateJobRequest,
  options: CreateOptions,
): CreateJobResult {
  if (!options.llmAvailable) throw llmUnavailable();
  const author = authorFor(ctx, actor);
  const settings = loadSettings(ctx);
  const scope = checkScope(ctx, request);
  limitScope(ctx, actor, scope);
  const counts = outdatedCounts(ctx, workScope(ctx, 0, "website", scope, settings.llm));
  if (request.dryRun) {
    return { job: null, estimate: estimate(ctx, settings, scope) };
  }
  if (counts.outdatedLeft > 0) scope.outdatedLeft = counts.outdatedLeft;
  if (budgetExhausted(ctx, options.monthlyTokenBudget)) throw budgetExceeded();
  const source: JobSource = actor.type === "token" ? "cli" : "website";
  const priority = scope.strings?.length === 1 ? PRIORITY.string : PRIORITY.bulk;
  const id = insertJob(ctx, { priority, source, scope, author });
  const total = countWork(ctx, workScope(ctx, id, source, scope, settings.llm));
  ctx.sql.run("UPDATE jobs SET total = ? WHERE id = ?", total, id);
  const job = loadJob(ctx, id)!;
  jobActivity(ctx, job, `Translation job ${id} queued: ${describeScope(scope, total)}`, {
    total,
    scope,
  });
  ctx.logger.info("LLM job queued", { jobId: id, total, source });
  if (total === 0) finishJob(ctx, id, "done");
  return { job: jobInfos(ctx, [loadJob(ctx, id)!])[0], estimate: null };
}

/** The scope, checked and normalized: project languages, active files, known strings. */
function checkScope(ctx: Context, request: CreateJobRequest): StoredScope {
  return normalizeScope(request, {
    languages: loadLanguages(ctx.sql).map((language) => language.tag),
    files: ctx.sql
      .query<{ path: string }>("SELECT path FROM files WHERE active = 1")
      .map((row) => row.path),
    strings: ctx.sql
      .query<{
        id: number;
      }>(
        "SELECT id FROM strings WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(request.strings ?? []),
      )
      .map((row) => row.id),
  });
}

function normalizeScope(
  request: CreateJobRequest,
  project: { languages: string[]; files: string[]; strings: number[] },
): StoredScope {
  const scope: StoredScope = {};
  if (request.languages !== undefined) {
    const tags: string[] = [];
    for (const requested of request.languages) {
      const tag = canonicalLanguageTag(requested);
      if (tag === null || !project.languages.includes(tag)) {
        throw badRequest(`The project has no language ${requested}.`, [
          { language: requested, message: "not a language of the project" },
        ]);
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
    scope.languages = tags;
  }
  if (request.files !== undefined) {
    const active = new Set(project.files);
    const missing = request.files.filter((path) => !active.has(path));
    if (missing.length > 0) {
      throw badRequest(
        `The project has no file ${missing.join(", ")}.`,
        missing.map((file) => ({
          file,
          message: "not a file of the project",
        })),
      );
    }
    scope.files = [...new Set(request.files)];
  }
  if (request.strings !== undefined) {
    const ids = [...new Set(request.strings)];
    const known = new Set(project.strings);
    const unknown = ids.find((id) => !known.has(id));
    if (unknown !== undefined) throw notFound(`String ${unknown}`);
    scope.strings = ids;
  }
  if (request.retranslate) scope.retranslate = true;
  if (request.qa) scope.qa = true;
  if (request.outdated !== undefined) scope.outdated = request.outdated;
  if (request.instruction !== undefined && request.instruction.trim() !== "") {
    scope.instruction = request.instruction.trim();
  }
  if (request.model !== undefined && request.model.trim() !== "") {
    if (!/^[\w.-]+$/.test(request.model.trim())) {
      throw badRequest(`Not a model name: ${request.model}`, [
        { path: "model", message: "must be a model name, such as gemini-flash-latest" },
      ]);
    }
    scope.model = request.model.trim();
  }
  return scope;
}

/**
 * A person limited to some languages (ROLE-3) runs jobs in those only: a scope naming
 * another is `forbidden`, and one naming none covers theirs.
 */
function limitScope(ctx: Context, actor: Actor, scope: StoredScope): void {
  const limit = languageLimit(ctx, actor);
  applyLanguageLimit(
    scope,
    limit,
    loadLanguages(ctx.sql).map((language) => language.tag),
  );
}

function applyLanguageLimit(scope: StoredScope, limit: string[] | null, languages: string[]): void {
  if (limit === null) return;
  if (scope.languages === undefined) {
    const theirs = languages.filter((tag) => limit.includes(tag));
    if (theirs.length === 0) throw forbiddenLanguages(limit);
    scope.languages = theirs;
  } else if (scope.languages.some((tag) => !limit.includes(tag))) {
    throw forbiddenLanguages(limit);
  }
}

function forbiddenLanguages(limit: string[]): ServiceError {
  return new ServiceError(
    "forbidden",
    limit.length === 0
      ? "You can't run translation jobs: no language is yours."
      : `You can only run translation jobs in ${limit.join(", ")}.`,
  );
}

/** "120 strings in de, fr", for the activity feed. */
function describeScope(scope: StoredScope, total: number): string {
  const parts = [`${total} ${total === 1 ? "string" : "strings"}`];
  if (scope.languages) parts.push(`in ${scope.languages.join(", ")}`);
  if (scope.files) parts.push(`of ${scope.files.join(", ")}`);
  if (scope.retranslate) parts.push("(re-translating green ones)");
  if (scope.qa) parts.push("(re-translating green ones that fail the checks)");
  return parts.join(" ");
}

function outdatedCounts(ctx: Context, scope: import("./work.ts").WorkScope) {
  let outdated = 0;
  let outdatedLeft = 0;
  for (const language of scope.languages) {
    const statement = outdatedCountStatement(scope, language);
    const [row] = ctx.sql.query<{ outdated: number; excluded: number }>(
      statement.sql,
      ...(statement.params ?? []),
    );
    outdated += row.outdated;
    outdatedLeft += row.excluded;
  }
  return { outdated, outdatedLeft };
}

/**
 * The estimate of a dry run: the strings and words to translate, the requests, and the
 * tokens (characters / 4 of each batch's rendered prompt, plus the expected output).
 */
function estimate(ctx: Context, settings: ProjectSettings, scope: StoredScope): JobEstimate {
  const work = workScope(ctx, 0, "website", scope, settings.llm);
  const facts = loadFacts(ctx);
  const batches = work.languages.flatMap((language) =>
    batchesOf(workIn(ctx, work, language), settings.llm.batchSize),
  );
  const contexts = batches.map((batch) =>
    promptContext(ctx, settings, facts, batch, scope.instruction ?? ""),
  );
  return estimateFromBatches(
    work.languages,
    batches,
    contexts,
    settings,
    outdatedCounts(ctx, work),
  );
}

function estimateFromBatches(
  languages: string[],
  batches: Batch[],
  contexts: PromptContext[],
  settings: ProjectSettings,
  counts: { outdated: number; outdatedLeft: number },
): JobEstimate {
  const result: JobEstimate = {
    ...(counts.outdated > 0 ? { outdated: counts.outdated } : {}),
    ...(counts.outdatedLeft > 0 ? { outdatedLeft: counts.outdatedLeft } : {}),
    strings: 0,
    words: 0,
    requests: batches.length,
    languages: languages.map((language) => ({ language, strings: 0, words: 0 })),
    files: [],
    work: { translate: 0, retranslate: 0, update: 0, propose: 0 },
    estimatedTokens: { input: 0, output: 0 },
  };
  const files = new Map<string, JobEstimate["files"][number]>();
  for (const [index, batch] of batches.entries()) {
    const words = batch.items.reduce((sum, item) => sum + item.words, 0);
    for (const item of batch.items) {
      const untranslated = item.revision === 0;
      if (item.action === "translate") result.work[untranslated ? "translate" : "retranslate"]++;
      else result.work[item.action]++;
    }
    const language = result.languages.find((entry) => entry.language === batch.language)!;
    language.strings += batch.items.length;
    language.words += words;
    let file = files.get(batch.path);
    if (!file) {
      file = { file: batch.path, strings: 0, words: 0 };
      files.set(batch.path, file);
    }
    file.strings += batch.items.length;
    file.words += words;
    result.strings += batch.items.length;
    result.words += words;
    const rendered = renderPrompt(
      settings.llm.promptTemplate,
      batch.items.map(promptString),
      contexts[index],
    );
    result.estimatedTokens.input += estimateTokens(rendered.system.length + rendered.prompt.length);
    result.estimatedTokens.output += expectedOutputTokens(rendered);
  }
  result.files = [...files.values()].sort((a, b) => a.file.localeCompare(b.file, "en"));
  return result;
}

export async function createJobAsync(
  sql: Sql,
  actor: Actor,
  request: CreateJobRequest,
  options: CreateOptions & { now: number; model: string; logger?: Logger },
): Promise<CreateJobResult> {
  if (actor.type === "anonymous") throw denied(actor);
  const revisionStatement: Statement = {
    sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
  };
  const creator: Statement = {
    sql: "SELECT ? AS actor_type, ? AS actor_id",
    params: [
      actor.type,
      actor.type === "user" ? actor.userId : actor.type === "token" ? actor.tokenId : null,
    ],
  };
  const logger = options.logger ?? silentLogger;
  for (let attempt = 0; attempt < 4; attempt++) {
    const [
      revisions,
      settingsRows,
      languageRows,
      files,
      strings,
      nextJob,
      monthly,
      users,
      tokens,
      ...permissionRows
    ] = await sql.read([
      revisionStatement,
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
      {
        sql: "SELECT path FROM files WHERE active = 1 AND path IN (SELECT value FROM json_each(?))",
        params: [JSON.stringify(request.files ?? [])],
      },
      {
        sql: "SELECT id FROM strings WHERE id IN (SELECT value FROM json_each(?))",
        params: [JSON.stringify(request.strings ?? [])],
      },
      { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM jobs" },
      monthlyUsage(options.now),
      ...actorReadStatements(creator),
      ...permissionReadStatements(actor),
    ]);
    const permissions = permissionsFromRows(actor, permissionRows);
    permissions.require("translate");
    if (!options.llmAvailable) throw llmUnavailable();
    const revision = Number(revisions[0].revision);
    const languages = (languageRows as LanguageRow[]).map(toLanguage);
    const settings = settingsFromData(
      (settingsRows[0]?.data as string | undefined) ?? null,
      options.model,
    );
    const scope = normalizeScope(request, {
      languages: languages.map((language) => language.tag),
      files: files.map((row) => String(row.path)),
      strings: strings.map((row) => Number(row.id)),
    });
    applyLanguageLimit(
      scope,
      permissions.languageLimit(),
      languages.map((language) => language.tag),
    );
    if (
      !request.dryRun &&
      options.monthlyTokenBudget !== null &&
      Number(monthly[0].n ?? 0) >= options.monthlyTokenBudget
    )
      throw budgetExceeded();
    const source: JobSource = actor.type === "token" ? "cli" : "website";
    const work = await readJobWork(
      sql,
      0,
      source,
      scope,
      settings.llm,
      request.dryRun ? Number.MAX_SAFE_INTEGER : 0,
    );
    // Settings, permissions, counts and prompt context must describe the same project revision.
    if (work.revision !== revision) continue;
    if (request.dryRun) {
      const facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(languages.map((language) => [language.tag, language])),
      };
      const contexts = [];
      for (const batch of work.batches)
        contexts.push(
          await promptContextAsync(sql, settings, facts, batch, scope.instruction ?? ""),
        );
      const [latest] = await sql.read([revisionStatement]);
      if (Number(latest[0].revision) !== revision) continue;
      return {
        job: null,
        estimate: estimateFromBatches(work.scope.languages, work.batches, contexts, settings, work),
      };
    }
    const author =
      actor.type === "system"
        ? SYSTEM_AUTHOR
        : {
            type: actor.type,
            id:
              actor.type === "user" ? actor.userId : actor.type === "token" ? actor.tokenId : null,
            label:
              actor.type === "token" ? ((tokens[0]?.name as string | undefined) ?? null) : null,
          };
    if (work.outdatedLeft > 0) scope.outdatedLeft = work.outdatedLeft;
    const id = Number(nextJob[0].id);
    const priority = scope.strings?.length === 1 ? PRIORITY.string : PRIORITY.bulk;
    const row: JobRow = {
      id,
      status: "queued",
      priority,
      source,
      scope: JSON.stringify(scope),
      actor_type: author.type,
      actor_id: author.id,
      actor_label: author.label,
      total: work.total,
      done: 0,
      translated: 0,
      proposed: 0,
      failed: 0,
      skipped: 0,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      failures: "[]",
      error: null,
      attempts: 0,
      created_at: options.now,
      started_at: null,
      finished_at: null,
      updated_at: options.now,
    };
    const statements = [
      jobInsertStatement(id, { priority, source, scope, author }, work.total, options.now),
      jobActivityStatement(
        row,
        `Translation job ${id} queued: ${describeScope(scope, work.total)}`,
        { total: work.total, scope },
        options.now,
      ),
    ];
    const finish = work.total === 0 ? planJobFinish(row, "done", null, options.now) : null;
    if (finish !== null) statements.push(...finish.statements);
    try {
      await sql.commit(revision, statements);
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
    logger.info("LLM job queued", { jobId: id, total: work.total, source });
    if (finish !== null)
      logger.info("LLM job ended", {
        jobId: id,
        status: "done",
        translated: 0,
        proposed: 0,
        failed: 0,
        skipped: 0,
      });
    return {
      job: jobInfosFromRows(
        [finish?.row ?? row],
        new ActorDirectory({
          users: users as ActorRows["users"],
          tokens: tokens as ActorRows["tokens"],
        }),
      )[0],
      estimate: null,
    };
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

/** `GET /jobs/{id}` */
export function getJob(ctx: Context, id: number): JobInfo {
  const job = loadJob(ctx, id);
  if (job === undefined) throw notFound(`Job ${id}`);
  return jobInfos(ctx, [job])[0];
}

/** `GET /jobs`: the newest first. */
export function listJobs(ctx: Context, query: JobsQuery = {}): JobsResult {
  const selection = jobsSelection(query);
  const rows = ctx.sql.query<JobRow>(selection.sql, ...(selection.params ?? []));
  return { jobs: jobInfos(ctx, rows) };
}

export async function getJobAsync(sql: Sql, actor: Actor, id: number): Promise<JobInfo> {
  const jobs = await readJobs(sql, actor, {
    sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`,
    params: [id],
  });
  if (jobs.length === 0) throw notFound(`Job ${id}`);
  return jobs[0];
}

export async function listJobsAsync(
  sql: Sql,
  actor: Actor,
  query: JobsQuery = {},
): Promise<JobsResult> {
  return {
    jobs: await readJobs(sql, actor, jobsSelection(query)),
  };
}

function jobsSelection(query: JobsQuery): Statement {
  // Active jobs cannot disappear behind a limit when many newer jobs have finished.
  if (query.active)
    return {
      sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('queued', 'running') ORDER BY id DESC`,
    };
  return { sql: `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY id DESC LIMIT ?`, params: [JOBS_LISTED] };
}

/** Job progress, creator identities and access use the same snapshot. */
async function readJobs(sql: Sql, actor: Actor, selection: Statement): Promise<JobInfo[]> {
  const [rows, users, tokens, ...permissionRows] = await sql.read([
    selection,
    ...actorReadStatements(selection),
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("translate");
  return jobInfosFromRows(
    rows as JobRow[],
    new ActorDirectory({
      users: users as ActorRows["users"],
      tokens: tokens as ActorRows["tokens"],
    }),
  );
}

/**
 * `DELETE /jobs/{id}`: cancels a job. Administrators may cancel any job, managers those in
 * their languages (ROLE-3), an API key the jobs it started. Batches running meanwhile are dropped when they return.
 */
export function cancelJob(ctx: Context, actor: Actor, id: number): JobInfo {
  if (!can(ctx, actor, "translate")) throw denied(actor);
  const job = loadJob(ctx, id);
  if (job === undefined) throw notFound(`Job ${id}`);
  if (actor.type === "token" && (job.actor_type !== "token" || job.actor_id !== actor.tokenId)) {
    throw new ServiceError("forbidden", "An API key can only cancel the jobs it started.");
  }
  const limit = languageLimit(ctx, actor);
  const languages = scopeOf(job).languages;
  if (limit !== null && (languages?.some((tag) => !limit.includes(tag)) ?? true)) {
    throw new ServiceError("forbidden", "This job translates languages that aren't yours.");
  }
  if (job.status === "done" || job.status === "failed") {
    const state = job.status === "done" ? "finished" : "failed";
    throw new ServiceError("conflict", `Job ${id} has ${state} already.`);
  }
  if (job.status !== "cancelled") {
    finishJob(ctx, id, "cancelled");
    ctx.logger.info("LLM job cancelled", { jobId: id });
  }
  return getJob(ctx, id);
}

export async function cancelJobAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
  logger: Logger = silentLogger,
): Promise<JobInfo> {
  const selection: Statement = {
    sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`,
    params: [id],
  };
  const committed = await withRetries(
    sql,
    async () => {
      const [revision, jobs, users, tokens, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        selection,
        ...actorReadStatements(selection),
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          job: jobs[0] as JobRow | undefined,
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("translate");
      const job = state.job;
      if (job === undefined) throw notFound(`Job ${id}`);
      if (actor.type === "token" && (job.actor_type !== "token" || job.actor_id !== actor.tokenId))
        throw new ServiceError("forbidden", "An API key can only cancel the jobs it started.");
      const limit = state.permissions.languageLimit();
      const languages = scopeOf(job).languages;
      if (limit !== null && (languages?.some((tag) => !limit.includes(tag)) ?? true))
        throw new ServiceError("forbidden", "This job translates languages that aren't yours.");
      if (job.status === "done" || job.status === "failed") {
        const status = job.status === "done" ? "finished" : "failed";
        throw new ServiceError("conflict", `Job ${id} has ${status} already.`);
      }
      const plan =
        job.status === "cancelled"
          ? { statements: [], row: job }
          : planJobFinish(job, "cancelled", null, now);
      return {
        statements: plan.statements,
        result: {
          row: plan.row,
          info: jobInfosFromRows([plan.row], new ActorDirectory(state.actors))[0],
          changed: plan.statements.length > 0,
        },
      };
    },
  );
  if (committed.changed) {
    const job = committed.row;
    logger.info("LLM job ended", {
      jobId: id,
      status: job.status,
      translated: job.translated,
      proposed: job.proposed,
      failed: job.failed,
      skipped: job.skipped,
    });
    logger.info("LLM job cancelled", { jobId: id });
  }
  return committed.info;
}
