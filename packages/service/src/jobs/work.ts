// SPDX-License-Identifier: MIT
/**
 * What a job has left to do (design §5.6). The work is declarative, worked out from the
 * scope each time: for each of the scope's languages and each active translatable string in
 * scope, the pair needs work when
 *
 * - it is untranslated (`translate`);
 * - re-translating, and it is green (`translate`; never blue, LLM-4);
 * - it is outdated and the scope takes outdated translations: green is updated (`update`);
 *   blue gets a proposal (`propose`) if the settings say so and no pending LLM proposal for
 *   the current English exists;
 *
 * minus the pairs the job already processed (`job_items`). An upload job follows the two
 * settings separately: `updateOutdated` for green, `proposeForProofread` for blue.
 *
 * String and file lists go to SQLite as one JSON parameter (`json_each`), so any number of
 * them fits in one statement within the Durable Object limits.
 */
import type { LlmSettings, TextValue, TranslatableKind } from "@quaso/core";
import type { Context } from "../context.ts";
import { fromJson, toJson } from "../db.ts";
import { TRANSLATABLE_SQL } from "../entries.ts";
import { loadLanguages } from "../languages.ts";
import { ServiceError } from "../errors.ts";
import type { Sql, SqlValue, Statement } from "../ports.ts";
import type { JobSource, StoredScope } from "./store.ts";

export type WorkAction = "translate" | "update" | "propose";

/** A string that needs work in a language. */
export interface WorkItem {
  stringId: number;
  language: string;
  fileId: number;
  path: string;
  position: number;
  key: string;
  kind: TranslatableKind;
  english: TextValue;
  sourceHash: string;
  maxLength: number | null;
  description: string;
  words: number;
  action: WorkAction;
  /** The translation's revision when the work was computed; 0 when untranslated. */
  revision: number;
  /** The current translation, for updates and proposals. */
  current: TextValue | null;
}

/** The scope, resolved: languages, file IDs, and what counts as work. */
export interface WorkScope {
  /** 0 for a dry run, which has processed nothing. */
  jobId: number;
  languages: string[];
  fileIds: number[] | null;
  stringIds: number[] | null;
  retranslate: boolean;
  /** Green translations that fail the quality checks, such as imported ones. */
  qa: boolean;
  updateGreen: boolean;
  proposeBlue: boolean;
}

/** Resolves a job's scope against the settings: which outdated translations it takes. */
export function workScope(
  ctx: Context,
  jobId: number,
  source: JobSource,
  scope: StoredScope,
  llm: Pick<LlmSettings, "updateOutdated" | "proposeForProofread">,
): WorkScope {
  return resolveWorkScope(
    loadLanguages(ctx.sql).map((language) => language.tag),
    scope.files === undefined
      ? []
      : ctx.sql.query<{ id: number; path: string }>("SELECT id, path FROM files"),
    jobId,
    source,
    scope,
    llm,
  );
}

function resolveWorkScope(
  project: string[],
  files: { id: number; path: string }[],
  jobId: number,
  source: JobSource,
  scope: StoredScope,
  llm: Pick<LlmSettings, "updateOutdated" | "proposeForProofread">,
): WorkScope {
  const outdated = scope.outdated ?? true;
  const upload = source === "upload";
  // Only the project's languages: one removed meanwhile has nothing to do.
  const languages = scope.languages?.filter((tag) => project.includes(tag)) ?? project;
  let fileIds: number[] | null = null;
  if (scope.files !== undefined) {
    const paths = new Set(scope.files);
    fileIds = files.filter((row) => paths.has(row.path)).map((row) => row.id);
  }
  return {
    jobId,
    languages,
    fileIds,
    stringIds: scope.strings ?? null,
    retranslate: scope.retranslate === true,
    qa: scope.qa === true,
    updateGreen: outdated && (!upload || llm.updateOutdated),
    proposeBlue: outdated && llm.proposeForProofread,
  };
}

type WorkRow = {
  id: number;
  file_id: number;
  path: string;
  position: number;
  display_key: string;
  kind: TranslatableKind;
  source: string;
  source_hash: string;
  max_length: number | null;
  description: string;
  words: number;
  t_colour: string | null;
  t_hash: string | null;
  t_revision: number | null;
  t_value: string | null;
};

/** The SQL condition and parameters of the work in one language (after `?` for the language). */
function condition(scope: WorkScope, language: string): { where: string; params: SqlValue[] } {
  const where = ["s.active = 1", "f.active = 1", `s.kind IN (${TRANSLATABLE_SQL})`];
  const params: SqlValue[] = [];
  if (scope.fileIds !== null) {
    where.push("s.file_id IN (SELECT value FROM json_each(?))");
    params.push(toJson(scope.fileIds));
  }
  if (scope.stringIds !== null) {
    where.push("s.id IN (SELECT value FROM json_each(?))");
    params.push(toJson(scope.stringIds));
  }
  if (scope.jobId > 0) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM job_items j
         WHERE j.job_id = ? AND j.string_id = s.id AND j.language = ?)`,
    );
    params.push(scope.jobId, language);
  }
  const needs = ["t.string_id IS NULL"];
  if (scope.retranslate) needs.push("t.colour = 'green'");
  if (scope.qa) needs.push("(t.colour = 'green' AND t.qa_errors > 0)");
  if (scope.updateGreen) needs.push("(t.colour = 'green' AND t.source_hash <> s.source_hash)");
  if (scope.proposeBlue) {
    needs.push(
      `(t.colour = 'blue' AND t.source_hash <> s.source_hash AND NOT EXISTS (
         SELECT 1 FROM suggestions g WHERE g.string_id = s.id AND g.language = ?
           AND g.kind = 'llm' AND g.status = 'pending' AND g.source_hash = s.source_hash))`,
    );
    params.push(language);
  }
  where.push(`(${needs.join(" OR ")})`);
  return { where: where.join(" AND "), params };
}

const FROM = `strings s JOIN files f ON f.id = s.file_id
  LEFT JOIN translations t ON t.string_id = s.id AND t.language = ?`;

/** The work in one language, in file and position order, at most `limit` items. */
export function workIn(
  ctx: Context,
  scope: WorkScope,
  language: string,
  limit = Number.MAX_SAFE_INTEGER,
): WorkItem[] {
  const statement = workSelection(scope, language, limit);
  return workItemsFromRows(
    ctx.sql.query<WorkRow>(statement.sql, ...(statement.params ?? [])),
    scope,
    language,
  );
}

function workSelection(scope: WorkScope, language: string, limit: number): Statement {
  const { where, params } = condition(scope, language);
  return {
    sql: `SELECT s.id, s.file_id, f.path, s.position, s.display_key, s.kind, s.source, s.source_hash,
            s.max_length, s.description, s.words, t.colour AS t_colour, t.source_hash AS t_hash,
            t.revision AS t_revision, t.value AS t_value
     FROM ${FROM} WHERE ${where} ORDER BY f.path, s.position LIMIT ?`,
    params: [language, ...params, limit],
  };
}

function workItemsFromRows(rows: WorkRow[], scope: WorkScope, language: string): WorkItem[] {
  return rows.map((row) => {
    let action: WorkAction = "translate";
    if (row.t_colour === "blue") action = "propose";
    else if (row.t_colour === "green" && row.t_hash !== row.source_hash && scope.updateGreen) {
      action = "update";
    }
    return {
      stringId: row.id,
      language,
      fileId: row.file_id,
      path: row.path,
      position: row.position,
      key: row.display_key,
      kind: row.kind,
      english: fromJson<TextValue>(row.source),
      sourceHash: row.source_hash,
      maxLength: row.max_length,
      description: row.description,
      words: row.words,
      action,
      revision: row.t_revision ?? 0,
      current: action === "translate" || row.t_value === null ? null : fromJson(row.t_value),
    };
  });
}

/** How many pairs need work, in every language of the scope. */
export function countWork(ctx: Context, scope: WorkScope): number {
  let total = 0;
  for (const language of scope.languages) {
    const statement = workCount(scope, language);
    total += ctx.sql.query<{ n: number }>(statement.sql, ...(statement.params ?? []))[0].n;
  }
  return total;
}

function workCount(scope: WorkScope, language: string): Statement {
  const { where, params } = condition(scope, language);
  return { sql: `SELECT COUNT(*) AS n FROM ${FROM} WHERE ${where}`, params: [language, ...params] };
}

/** Scope, counts and ordered batches belong to one revision; callers can guard writes with it. */
export async function readJobWork(
  sql: Sql,
  jobId: number,
  source: JobSource,
  stored: StoredScope,
  llm: Pick<LlmSettings, "updateOutdated" | "proposeForProofread" | "batchSize">,
  maxBatches = Number.MAX_SAFE_INTEGER,
): Promise<{ revision: number; scope: WorkScope; total: number; batches: Batch[] }> {
  if (!Number.isSafeInteger(llm.batchSize) || llm.batchSize < 1)
    throw new RangeError("Batch size must be a positive integer.");
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 0)
    throw new RangeError("Maximum batches must be a nonnegative integer.");
  const revisionStatement: Statement = {
    sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [revisionRows, languages, files] = await sql.read([
      revisionStatement,
      { sql: "SELECT tag FROM languages ORDER BY tag" },
      {
        sql: "SELECT id, path FROM files WHERE path IN (SELECT value FROM json_each(?))",
        params: [toJson(stored.files ?? [])],
      },
    ]);
    const revision = Number(revisionRows[0].revision);
    const scope = resolveWorkScope(
      languages.map((row) => String(row.tag)),
      files as { id: number; path: string }[],
      jobId,
      source,
      stored,
      llm,
    );
    const limit = Math.min(Number.MAX_SAFE_INTEGER, maxBatches * llm.batchSize);
    const [currentRevision, ...rows] = await sql.read([
      revisionStatement,
      ...scope.languages.flatMap((language) => [
        workCount(scope, language),
        workSelection(scope, language, limit),
      ]),
    ]);
    // A language/file change between reads must not leave a partially resolved scope.
    if (Number(currentRevision[0].revision) !== revision) continue;
    let total = 0;
    const batches: Batch[] = [];
    for (const [index, language] of scope.languages.entries()) {
      total += Number(rows[index * 2][0].n);
      const items = workItemsFromRows(rows[index * 2 + 1] as WorkRow[], scope, language);
      const room = maxBatches - batches.length;
      for (const batch of batchesOf(items, llm.batchSize).slice(0, Math.max(0, room)))
        batches.push(batch);
    }
    return { revision, scope, total, batches };
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

/** Whether any pair needs work. */
export function hasWork(ctx: Context, scope: WorkScope): boolean {
  return scope.languages.some((language) => workIn(ctx, scope, language, 1).length > 0);
}

/** A batch: neighbouring strings of one file, in one language (design §5.6). */
export interface Batch {
  language: string;
  fileId: number;
  path: string;
  items: WorkItem[];
}

/** Groups work (in file and position order) into batches of at most `size` strings. */
export function batchesOf(items: readonly WorkItem[], size: number): Batch[] {
  const batches: Batch[] = [];
  let current: Batch | null = null;
  for (const item of items) {
    if (
      current === null ||
      current.fileId !== item.fileId ||
      current.language !== item.language ||
      current.items.length >= size
    ) {
      current = { language: item.language, fileId: item.fileId, path: item.path, items: [] };
      batches.push(current);
    }
    current.items.push(item);
  }
  return batches;
}

/** The next batches of a job: at most `max`, language by language. */
export function nextBatches(
  ctx: Context,
  scope: WorkScope,
  batchSize: number,
  max: number,
): Batch[] {
  const out: Batch[] = [];
  for (const language of scope.languages) {
    const room = max - out.length;
    if (room <= 0) break;
    const items = workIn(ctx, scope, language, room * batchSize);
    out.push(...batchesOf(items, batchSize).slice(0, room));
  }
  return out;
}
