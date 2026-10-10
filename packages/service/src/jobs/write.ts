// SPDX-License-Identifier: MIT
/** Guarded batch results preserve edits made while the provider was running (LLM-4, STR-4). */
import { canonicalValue, type JobFailure, type TextValue } from "@quaso/core";
import { ActorDirectory, type Author } from "../actors.ts";
import { SYSTEM, type Actor } from "../api.ts";
import type { Context } from "../context.ts";
import { bumpRevision, chunks, transaction, writeRevision } from "../db.ts";
import { isTranslatableKind } from "../entries.ts";
import { forbidden, ServiceError } from "../errors.ts";
import { loadFacts, type Facts } from "../facts.ts";
import type { GlossaryRow } from "../glossary.ts";
import { toLanguage, type LanguageRow } from "../languages.ts";
import type { Sql, SqlRow, Statement } from "../ports.ts";
import { loadSettings, settingsFromData } from "../settings.ts";
import { planSuperseded } from "../suggestions.ts";
import {
  historyParams,
  planTranslationWrite,
  TRANSLATION_COLUMNS,
  type TargetString,
  type TranslationRow,
} from "../translations.ts";
import { withRetries } from "../write.ts";
import { JOB_COLUMNS, jobProgressStatement, type JobRow, type ProgressDelta } from "./store.ts";
import type { Batch, WorkItem } from "./work.ts";

/** A result that passed the checks, and the request that gave it. */
export interface BatchSuccess {
  value: TextValue;
  requestId: number;
  model: string;
}
export type Outcome = "translated" | "proposed" | "failed" | "skipped";
type PendingProposal = { id: number; string_id: number; value: string | null };
interface BatchState {
  job: JobRow | undefined;
  strings: Map<number, TargetString>;
  translations: Map<number, TranslationRow>;
  proposals: PendingProposal[];
  nextSuggestion: number;
  processed: Map<number, Outcome>;
  facts: Facts;
  proposeForProofread: boolean;
}

function batchReadStatements(jobId: number, batch: Batch): Statement[] {
  const ids = JSON.stringify(batch.items.map((item) => item.stringId));
  return [
    { sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, params: [jobId] },
    {
      sql: `SELECT s.id, f.path, s.display_key, s.kind, s.source, s.source_hash, s.max_length, s.active * f.active AS active
      FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id IN (SELECT value FROM json_each(?))`,
      params: [ids],
    },
    {
      sql: `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE language = ? AND string_id IN (SELECT value FROM json_each(?))`,
      params: [batch.language, ids],
    },
    {
      sql: "SELECT id, string_id, value FROM suggestions WHERE language = ? AND kind = 'llm' AND status = 'pending' AND string_id IN (SELECT value FROM json_each(?)) ORDER BY id",
      params: [batch.language, ids],
    },
    { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM suggestions" },
    {
      sql: "SELECT string_id, outcome FROM job_items WHERE job_id = ? AND language = ? AND string_id IN (SELECT value FROM json_each(?))",
      params: [jobId, batch.language, ids],
    },
  ];
}
function batchState(rows: SqlRow[][], facts: Facts, proposeForProofread: boolean): BatchState {
  const [jobs, strings, translations, proposals, next, processed] = rows;
  return {
    job: jobs[0] as JobRow | undefined,
    strings: new Map((strings as TargetString[]).map((row) => [row.id, row])),
    translations: new Map((translations as TranslationRow[]).map((row) => [row.string_id, row])),
    proposals: proposals as PendingProposal[],
    nextSuggestion: Number(next[0].id),
    processed: new Map(processed.map((row) => [Number(row.string_id), row.outcome as Outcome])),
    facts,
    proposeForProofread,
  };
}

/** Results, failures, processed pairs and progress commit together; repeats do not count twice. */
export function writeBatch(
  ctx: Context,
  jobId: number,
  batch: Batch,
  successes: ReadonlyMap<number, BatchSuccess>,
  failures: ReadonlyMap<number, string>,
): Map<number, Outcome> | null {
  return transaction(ctx.sql, () => {
    const rows = batchReadStatements(jobId, batch).map((statement) =>
      ctx.sql.query(statement.sql, ...(statement.params ?? [])),
    );
    const plan = planBatch(
      batchState(rows, loadFacts(ctx), loadSettings(ctx).llm.proposeForProofread),
      batch,
      successes,
      failures,
      writeRevision(ctx.sql),
      ctx.clock(),
    );
    if (plan.raisesRevision) bumpRevision(ctx.sql);
    for (const statement of plan.statements)
      ctx.sql.run(statement.sql, ...(statement.params ?? []));
    return plan.result;
  });
}

export async function writeBatchAsync(
  sql: Sql,
  actor: Actor,
  jobId: number,
  batch: Batch,
  successes: ReadonlyMap<number, BatchSuccess>,
  failures: ReadonlyMap<number, string>,
  options: { now: number; model: string; expectedJobCreatedAt?: number },
): Promise<Map<number, Outcome> | null> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server records translation results.");
  return withRetries(
    sql,
    async () => {
      const [revision, settingsRows, languageRows, glossary, ...rows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT data FROM settings WHERE id = 1" },
        { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
        { sql: "SELECT * FROM glossary_terms" },
        ...batchReadStatements(jobId, batch),
      ]);
      const settings = settingsFromData(
        (settingsRows[0]?.data as string | undefined) ?? null,
        options.model,
      );
      const languages = (languageRows as LanguageRow[]).map(toLanguage);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(languages.map((language) => [language.tag, language])),
        glossary: (glossary as GlossaryRow[]).map((row) => ({
          id: row.id,
          term: row.term,
          language: row.language,
          kind: row.kind,
          translation: row.translation,
          caseSensitive: row.case_sensitive === 1,
          note: row.note,
          createdBy: null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      };
      return {
        revision: Number(revision[0].revision),
        state: {
          batch: batchState(rows, facts, settings.llm.proposeForProofread),
          revision: Number(revision[0].revision) + 1,
        },
      };
    },
    (state) =>
      options.expectedJobCreatedAt !== undefined &&
      state.batch.job?.created_at !== options.expectedJobCreatedAt
        ? { statements: [], result: null, raisesRevision: false }
        : planBatch(state.batch, batch, successes, failures, state.revision, options.now),
  );
}

function planBatch(
  state: BatchState,
  batch: Batch,
  successes: ReadonlyMap<number, BatchSuccess>,
  failures: ReadonlyMap<number, string>,
  revision: number,
  now: number,
): { statements: Statement[]; result: Map<number, Outcome> | null; raisesRevision: boolean } {
  const job = state.job;
  if (
    job === undefined ||
    job.status === "cancelled" ||
    job.status === "done" ||
    job.status === "failed"
  )
    return { statements: [], result: null, raisesRevision: false };
  const statements: Statement[] = [];
  const outcomes = new Map<number, Outcome>();
  const newOutcomes = new Map<number, Outcome>();
  const delta: ProgressDelta = { translated: 0, proposed: 0, failed: 0, skipped: 0, failures: [] };
  let raisesRevision = false;
  let nextSuggestion = state.nextSuggestion;
  const fail = (item: WorkItem, reason: string) => {
    outcomes.set(item.stringId, "failed");
    newOutcomes.set(item.stringId, "failed");
    delta.failed++;
    const failure: JobFailure = {
      stringId: item.stringId,
      language: item.language,
      file: item.path,
      key: item.key,
      reason,
    };
    delta.failures.push(failure);
    statements.push({
      sql: `INSERT INTO llm_failures (string_id, language, job_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (string_id, language) DO UPDATE SET job_id = excluded.job_id, reason = excluded.reason, created_at = excluded.created_at`,
      params: [item.stringId, item.language, job.id, reason, now],
    });
  };
  for (const item of batch.items) {
    if (outcomes.has(item.stringId)) continue;
    const processed = state.processed.get(item.stringId);
    if (processed !== undefined) {
      outcomes.set(item.stringId, processed);
      continue;
    }
    const success = successes.get(item.stringId);
    if (success === undefined) {
      const failure = failures.get(item.stringId);
      if (failure !== undefined) fail(item, failure);
      continue;
    }
    let outcome: Outcome = "skipped";
    const string = state.strings.get(item.stringId);
    const current = state.translations.get(item.stringId);
    const sourceMatches = string?.active === 1 && string.source_hash === item.sourceHash;
    const revisionMatches = (current?.revision ?? 0) === item.revision;
    const languageExists = state.facts.languages.has(item.language);
    const translatable = string !== undefined && isTranslatableKind(string.kind);
    if (sourceMatches && revisionMatches && languageExists && translatable) {
      const author: Author = { type: "llm", id: null, label: success.model };
      const detail = { model: success.model, requestId: success.requestId, jobId: job.id };
      try {
        if (current?.colour === "blue") {
          // The setting governs upload jobs; a person who starts a job chose to include them.
          const proposalsAllowed = job.source !== "upload" || state.proposeForProofread;
          if (current.source_hash !== string.source_hash && proposalsAllowed) {
            statements.push(
              ...planProposal(
                nextSuggestion++,
                state.proposals.filter((row) => row.string_id === item.stringId),
                item,
                success,
                author,
                detail,
                current,
                now,
              ),
            );
            outcome = "proposed";
            raisesRevision = true;
          }
        } else {
          const plan = planTranslationWrite(
            {
              stringId: item.stringId,
              language: item.language,
              value: success.value,
              colour: "green",
              actor: author,
              event: "translation_llm",
              baseRevision: item.revision,
              llm: true,
              detail,
            },
            {
              string,
              existing: current,
              facts: state.facts,
              actors: new ActorDirectory({ users: [], tokens: [] }),
              revision,
              now,
            },
          );
          statements.push(...plan.statements);
          outcome = plan.result.status === "skipped" ? "skipped" : "translated";
          if (plan.statements.length > 0) raisesRevision = true;
        }
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        if (error.code === "qa_failed") {
          fail(item, error.message);
          continue;
        }
        if (error.code !== "not_found" && error.code !== "bad_request") throw error;
      }
    }
    outcomes.set(item.stringId, outcome);
    newOutcomes.set(item.stringId, outcome);
    delta[outcome]++;
    if (outcome !== "skipped")
      statements.push({
        sql: "DELETE FROM llm_failures WHERE string_id = ? AND language = ?",
        params: [item.stringId, item.language],
      });
  }
  for (const pairs of chunks([...newOutcomes], 20))
    statements.push({
      sql: `INSERT INTO job_items (job_id, string_id, language, outcome) VALUES ${pairs.map(() => "(?, ?, ?, ?)").join(", ")} ON CONFLICT (job_id, string_id, language) DO UPDATE SET outcome = excluded.outcome`,
      params: pairs.flatMap(([id, outcome]) => [job.id, id, batch.language, outcome]),
    });
  if (newOutcomes.size > 0) statements.push(jobProgressStatement(job, delta, now));
  return { statements, result: outcomes, raisesRevision };
}

function planProposal(
  id: number,
  older: PendingProposal[],
  item: WorkItem,
  success: BatchSuccess,
  author: Author,
  detail: Record<string, unknown>,
  current: TranslationRow,
  now: number,
): Statement[] {
  const value = canonicalValue(success.value);
  return [
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, author_label, created_at) VALUES (?, ?, ?, 'llm', ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      params: [
        id,
        item.stringId,
        item.language,
        value,
        item.sourceHash,
        current.revision,
        author.type,
        author.id,
        author.label,
        now,
      ],
    },
    ...older.flatMap((row) => planSuperseded(row, item.stringId, item.language, author, now, id)),
    {
      sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: historyParams({
        stringId: item.stringId,
        language: item.language,
        event: "suggestion_created",
        before: [current.value, "blue"],
        after: [value, null],
        actor: author,
        detail: { suggestionId: id, kind: "llm", ...detail },
        at: now,
      }),
    },
  ];
}
