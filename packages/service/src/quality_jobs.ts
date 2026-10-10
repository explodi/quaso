// SPDX-License-Identifier: MIT
/** Durable meaning-check jobs use the translation scheduler and preserve accepted text. */
import {
  canonicalLanguageTag,
  QualityJobRequest,
  type MeaningFinding,
  type QualityJobInfo,
  type TextValue,
  type CheckResult,
} from "@quaso/core";
import { SYSTEM, type Actor } from "./api.ts";
import { fromJson } from "./db.ts";
import { badRequest, forbidden, notFound } from "./errors.ts";
import { readPermissions, permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Clock, Logger, Sql, SqlRow, Statement } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import { validateActor, validateInput } from "./validation.ts";
import { withRetries } from "./write.ts";
import type { LlmConfiguration } from "./llm/configuration.ts";
import {
  checkedMeaning,
  MEANING_RESPONSE_SCHEMA,
  MEANING_SYSTEM,
  meaningId,
  type MeaningTarget,
} from "./llm/meaning.ts";
import { monthlyUsage, nextMonthStart, recordRequestAsync } from "./jobs/usage.ts";
import { llmUnavailable } from "./jobs/jobs.ts";

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};
type TargetRef = { id: number; language: string; suggestionId?: number };
type JobRow = {
  id: number;
  kind: "meaning";
  scope: string;
  targets: string;
  status: QualityJobInfo["status"];
  model: string;
  counts_budget: number;
  total: number;
  done: number;
  flagged: number;
  result: string;
  error: string | null;
  wake_at: number | null;
  created_at: number;
  finished_at: number | null;
};

function info(row: JobRow): QualityJobInfo {
  return {
    id: row.id,
    kind: row.kind,
    scope: fromJson(row.scope),
    status: row.status,
    model: row.model,
    total: row.total,
    done: row.done,
    flagged: row.flagged,
    result: fromJson(row.result),
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
function allowed(row: JobRow, limit: string[] | null): boolean {
  return (
    limit === null ||
    fromJson<QualityJobRequest>(row.scope).languages.every((tag) => limit.includes(tag))
  );
}

export async function listQualityJobs(
  sql: Sql,
  caller: Actor,
): Promise<{ jobs: QualityJobInfo[] }> {
  const actor = validateActor(caller);
  const [rows, ...permissions] = await sql.read([
    { sql: "SELECT * FROM quality_jobs ORDER BY id DESC LIMIT 50" },
    ...permissionReadStatements(actor),
  ]);
  const access = permissionsFromRows(actor, permissions);
  access.require("translate");
  return {
    jobs: (rows as JobRow[]).filter((row) => allowed(row, access.languageLimit())).map(info),
  };
}
export async function getQualityJob(sql: Sql, caller: Actor, id: number): Promise<QualityJobInfo> {
  const actor = validateActor(caller);
  const [rows, ...permissions] = await sql.read([
    { sql: "SELECT * FROM quality_jobs WHERE id = ?", params: [id] },
    ...permissionReadStatements(actor),
  ]);
  const access = permissionsFromRows(actor, permissions);
  access.require("translate");
  const row = rows[0] as JobRow | undefined;
  if (!row) throw notFound(`Quality job ${id}`);
  if (!allowed(row, access.languageLimit()))
    throw forbidden("This quality job includes other languages.");
  return info(row);
}

function targetSelection(request: QualityJobRequest): Statement {
  const suggestions = request.suggestions !== undefined;
  return {
    sql: `SELECT s.id, t.language${suggestions ? ", t.id AS suggestionId" : ""} FROM strings s JOIN files f ON f.id = s.file_id
      JOIN ${suggestions ? "suggestions" : "translations"} t ON t.string_id = s.id
      WHERE s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')
      AND t.language IN (SELECT value FROM json_each(?))
      AND (? = 1 OR f.path IN (SELECT value FROM json_each(?)))
      AND (? = 1 OR s.id IN (SELECT value FROM json_each(?)))
      ${suggestions ? "AND t.status = 'pending' AND t.value IS NOT NULL AND t.id IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY t.language, f.path, s.position`,
    params: [
      JSON.stringify(request.languages),
      request.files === undefined ? 1 : 0,
      JSON.stringify(request.files ?? []),
      request.strings === undefined ? 1 : 0,
      JSON.stringify(request.strings ?? []),
      ...(suggestions ? [JSON.stringify(request.suggestions)] : []),
    ],
  };
}
function targetsFromRows(rows: SqlRow[]): MeaningTarget[] {
  return rows.map((row) => ({
    id: Number(row.id),
    language: String(row.language),
    file: String(row.file),
    key: String(row.key),
    source: fromJson<TextValue>(row.source),
    translation: fromJson<TextValue>(row.value),
    sourceHash: String(row.source_hash),
    description: String(row.description),
    ...(row.suggestionId === null ? {} : { suggestionId: Number(row.suggestionId) }),
  }));
}

async function readTargets(sql: Sql, refs: TargetRef[]): Promise<MeaningTarget[]> {
  const [rows] = await sql.read([
    {
      sql: `SELECT s.id, f.path AS file, s.display_key AS key, s.source, s.source_hash, s.description,
      json_extract(r.value, '$.language') AS language, json_extract(r.value, '$.suggestionId') AS suggestionId,
      CASE WHEN json_extract(r.value, '$.suggestionId') IS NULL THEN t.value ELSE g.value END AS value
      FROM json_each(?) r JOIN strings s ON s.id = json_extract(r.value, '$.id') JOIN files f ON f.id = s.file_id
      LEFT JOIN translations t ON t.string_id = s.id AND t.language = json_extract(r.value, '$.language')
      LEFT JOIN suggestions g ON g.id = json_extract(r.value, '$.suggestionId') AND g.status = 'pending'
      WHERE s.active = 1 AND f.active = 1 AND (CASE WHEN json_extract(r.value, '$.suggestionId') IS NULL THEN t.value ELSE g.value END) IS NOT NULL`,
      params: [JSON.stringify(refs)],
    },
  ]);
  return targetsFromRows(rows);
}

export function createQualityJobs(
  sql: Sql,
  options: {
    clock: Clock;
    logger: Logger;
    model: string;
    configuration(): Promise<LlmConfiguration>;
    schedule(at: number): Promise<void>;
  },
) {
  let running: Promise<void> | null = null;
  async function settings() {
    const [rows] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
    return settingsFromData((rows[0]?.data as string | undefined) ?? null, options.model);
  }
  async function create(caller: Actor, input: QualityJobRequest): Promise<QualityJobInfo> {
    const actor = validateActor(caller);
    (await readPermissions(sql, actor)).require("translate");
    const request = validateInput(QualityJobRequest, input);
    request.languages = request.languages.map((tag) => canonicalLanguageTag(tag) ?? tag);
    if ((await options.configuration()).provider === null) throw llmUnavailable();
    const result = await withRetries(
      sql,
      async () => {
        const [revision, stored, languages, targets, next, ...permissionRows] = await sql.read([
          REVISION,
          { sql: "SELECT data FROM settings WHERE id = 1" },
          { sql: "SELECT tag FROM languages" },
          targetSelection(request),
          { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM quality_jobs" },
          ...permissionReadStatements(actor),
        ]);
        return {
          revision: Number(revision[0].revision),
          state: {
            stored,
            languages,
            targets,
            id: Number(next[0].id),
            access: permissionsFromRows(actor, permissionRows),
          },
        };
      },
      (state) => {
        state.access.require("translate");
        const limit = state.access.languageLimit();
        const permitted = limit === null || request.languages.every((tag) => limit.includes(tag));
        if (!permitted) throw forbidden("Choose your assigned languages for the quality check.");
        if (request.languages.some((tag) => !state.languages.some((row) => row.tag === tag)))
          throw badRequest("Choose project target languages for the quality check.");
        const current = settingsFromData(
          (state.stored[0]?.data as string | undefined) ?? null,
          options.model,
        );
        const policy = current.llm.meaningCheck;
        const now = options.clock();
        const row: JobRow = {
          id: state.id,
          kind: "meaning",
          scope: JSON.stringify(request),
          targets: JSON.stringify(state.targets),
          model: policy?.model || current.llm.model,
          counts_budget: policy?.countsAgainstBudget === false ? 0 : 1,
          status: state.targets.length === 0 ? "done" : "queued",
          total: state.targets.length,
          done: 0,
          flagged: 0,
          result: "[]",
          error: null,
          wake_at: null,
          created_at: now,
          finished_at: state.targets.length === 0 ? now : null,
        };
        return {
          statements: [
            {
              sql: `INSERT INTO quality_jobs (id, kind, scope, targets, status, model, counts_budget, total, created_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              params: [
                row.id,
                row.kind,
                row.scope,
                row.targets,
                row.status,
                row.model,
                row.counts_budget,
                row.total,
                now,
                row.finished_at,
              ],
            },
          ],
          result: info(row),
        };
      },
    );
    if (result.status === "queued") await options.schedule(options.clock());
    return result;
  }

  async function update(id: number, statements: Statement[]) {
    await withRetries(
      sql,
      async () => {
        const [revision] = await sql.read([REVISION]);
        return { revision: Number(revision[0].revision), state: null };
      },
      () => ({ statements, result: null }),
    );
  }
  async function alarm() {
    const [jobs] = await sql.read([
      {
        sql: "SELECT * FROM quality_jobs WHERE status IN ('queued', 'running', 'paused') ORDER BY status = 'paused', id LIMIT 1",
      },
    ]);
    const job = jobs[0] as JobRow | undefined;
    if (!job) return;
    const configuration = await options.configuration();
    const [usage] = await sql.read([monthlyUsage(options.clock())]);
    const budgetUsed = Number(usage[0].n ?? 0);
    const budgetBlocked =
      job.counts_budget === 1 &&
      configuration.monthlyTokenBudget !== null &&
      budgetUsed >= configuration.monthlyTokenBudget;
    if (configuration.provider === null || budgetBlocked) {
      const next = budgetBlocked ? nextMonthStart(options.clock()) : null;
      await update(job.id, [
        {
          sql: "UPDATE quality_jobs SET status = 'paused', error = ?, wake_at = ? WHERE id = ?",
          params: [
            budgetBlocked ? "Monthly token budget reached" : "LLM translation is unavailable",
            next,
            job.id,
          ],
        },
      ]);
      const [queued] = await sql.read([
        { sql: "SELECT 1 FROM quality_jobs WHERE status IN ('queued', 'running') LIMIT 1" },
      ]);
      if (queued.length > 0) await options.schedule(options.clock());
      else if (next !== null) await options.schedule(next);
      return;
    }
    const provider = configuration.provider;
    const refs = fromJson<TargetRef[]>(job.targets).slice(job.done, job.done + 25);
    const targets = await readTargets(sql, refs);
    await update(job.id, [
      {
        sql: "UPDATE quality_jobs SET status = 'running', error = NULL, wake_at = NULL WHERE id = ?",
        params: [job.id],
      },
    ]);
    let results = new Map<string, CheckResult[]>();
    try {
      if (targets.length > 0) {
        const project = await settings();
        const [languages] = await sql.read([
          {
            sql: "SELECT tag, instructions FROM languages WHERE tag IN (SELECT value FROM json_each(?))",
            params: [JSON.stringify([...new Set(targets.map((target) => target.language))])],
          },
        ]);
        const started = options.clock();
        const answer = await provider.translate({
          model: job.model,
          safety: project.llm.safety,
          system: MEANING_SYSTEM,
          prompt: JSON.stringify({
            sourceLanguage: project.sourceLanguage,
            instructions: project.llm.projectInstructions,
            languageInstructions: languages,
            comparisons: targets.map((target) => ({
              id: meaningId(target),
              language: target.language,
              source: target.source,
              translation: target.translation,
              description: target.description,
            })),
          }),
          responseSchema: MEANING_RESPONSE_SCHEMA,
        });
        await recordRequestAsync(
          sql,
          SYSTEM,
          {
            jobId: null,
            language: targets[0].language,
            fileId: null,
            provider: provider.name,
            model: answer.model ?? job.model,
            strings: targets.length,
            usage: answer.usage,
            durationMs: options.clock() - started,
            outcome: "ok",
            error: null,
            countsBudget: job.counts_budget === 1,
          },
          options.clock(),
        );
        results = checkedMeaning(answer.answer, targets);
      }
      const findings: MeaningFinding[] = targets
        .filter((target) => (results.get(meaningId(target))?.length ?? 0) > 0)
        .map((target) => ({
          id: target.id,
          language: target.language,
          file: target.file,
          key: target.key,
          ...(target.suggestionId === undefined ? {} : { suggestionId: target.suggestionId }),
          checks: results.get(meaningId(target))!,
        }));
      await withRetries(
        sql,
        async () => {
          const [revision, rows] = await sql.read([
            REVISION,
            { sql: "SELECT * FROM quality_jobs WHERE id = ?", params: [job.id] },
          ]);
          return { revision: Number(revision[0].revision), state: rows[0] as JobRow };
        },
        (current) => {
          const statements: Statement[] = [];
          for (const target of targets) {
            const checks = JSON.stringify(results.get(meaningId(target)) ?? []);
            const suggestions = target.suggestionId !== undefined;
            const table = suggestions ? "suggestions" : "translations";
            const identity = suggestions
              ? "id = ? AND status = 'pending'"
              : "string_id = ? AND language = ?";
            statements.push({
              sql: `UPDATE ${table} SET extra_checks = (
            SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(extra_checks) WHERE json_extract(value, '$.check') <> 'meaning'
              UNION ALL SELECT value FROM json_each(?))) WHERE ${identity} AND value = ?
              AND EXISTS (SELECT 1 FROM strings WHERE id = ? AND source_hash = ? AND description = ?)`,
              params: [
                checks,
                ...(suggestions ? [target.suggestionId!] : [target.id, target.language]),
                JSON.stringify(target.translation),
                target.id,
                target.sourceHash,
                target.description,
              ],
            });
          }
          const done = current.done + refs.length;
          const finished = done >= current.total;
          statements.push({
            sql: "UPDATE quality_jobs SET done = ?, flagged = flagged + ?, result = ?, status = ?, finished_at = ? WHERE id = ?",
            params: [
              done,
              findings.length,
              JSON.stringify(
                [...fromJson<MeaningFinding[]>(current.result), ...findings].slice(-200),
              ),
              finished ? "done" : "queued",
              finished ? options.clock() : null,
              job.id,
            ],
          });
          return { statements, result: null };
        },
      );
    } catch (error) {
      await update(job.id, [
        {
          sql: "UPDATE quality_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
          params: [
            error instanceof Error ? error.message : "Meaning check failed",
            options.clock(),
            job.id,
          ],
        },
      ]);
      options.logger.warn("Meaning check failed", { jobId: job.id });
    }
    const [remaining] = await sql.read([
      { sql: "SELECT 1 FROM quality_jobs WHERE status IN ('queued', 'running') LIMIT 1" },
    ]);
    if (remaining.length > 0) await options.schedule(options.clock());
  }

  return {
    create,
    get busy() {
      return running !== null;
    },
    async start() {
      const [rows] = await sql.read([
        {
          sql: "SELECT 1 FROM quality_jobs WHERE status IN ('queued', 'running', 'paused') LIMIT 1",
        },
      ]);
      if (rows.length > 0) await options.schedule(options.clock());
    },
    alarm(): Promise<void> {
      if (running !== null) return running;
      running = alarm()
        .catch(async (error) => {
          await options.schedule(options.clock() + 60_000);
          throw error;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    async afterTranslation(
      event: "save" | "approval",
      id: number,
      language: string,
      suggestionId?: number,
    ) {
      try {
        const policy = (await settings()).llm.meaningCheck;
        const enabled = policy?.enabled && (event === "save" ? policy.onSave : policy.onApproval);
        if (!enabled) return;
        const [rows] = await sql.read([
          {
            sql: "SELECT colour FROM translations WHERE string_id = ? AND language = ?",
            params: [id, language],
          },
        ]);
        const blueOnly = policy.colours === "blue";
        if (blueOnly && (suggestionId !== undefined || rows[0]?.colour !== "blue")) return;
        await create(SYSTEM, {
          kind: "meaning",
          languages: [language],
          ...(suggestionId === undefined ? { strings: [id] } : { suggestions: [suggestionId] }),
        });
      } catch {
        options.logger.warn("Couldn't queue an automatic meaning check", {
          stringId: id,
          language,
        });
      }
    },
  };
}
