// SPDX-License-Identifier: MIT
/**
 * The single write path for translations (design §5.3, §5.4). Every change to the
 * `translations` table goes through `writeTranslation`: it enforces the state rules (the
 * LLM never writes over blue, LLM-4; revisions catch conflicts), runs the quality checks
 * (QA-1), writes history (STR-5) and raises the revision.
 *
 * A translation's `revision` is the project revision of its last change; an untranslated
 * string has revision 0. It is outdated when the hash of the English it was made for
 * differs from the string's current hash (STR-4), so it stops being outdated when the
 * English changes back.
 */
import {
  canonicalLanguageTag,
  canonicalValue,
  type CheckResult,
  checkTranslation,
  type Colour,
  type ErrorDetail,
  errorsOf,
  type HistoryEvent,
  type TextValue,
  type TranslatableKind,
  type TranslationInfo,
} from "@quaso/core";
import { ActorDirectory, type Author } from "./actors.ts";
import type { Context } from "./context.ts";
import { bumpRevision, fromJson, idList, normalizeSearch, toJson, writeRevision } from "./db.ts";
import { isTranslatableKind, TRANSLATABLE_SQL, valueText } from "./entries.ts";
import { badRequest, conflict, notFound, ServiceError } from "./errors.ts";
import { type CheckFacts, type Facts, loadFacts, overrideOf } from "./facts.ts";
import type { Statement, SyncSql } from "./ports.ts";

/** A string, as the write path and the checks need it. */
export type TargetString = {
  id: number;
  path: string;
  display_key: string;
  kind: string;
  source: string;
  source_hash: string;
  max_length: number | null;
  active: number;
};

/** A row of the `translations` table. */
export type TranslationRow = {
  string_id: number;
  language: string;
  value: string;
  colour: Colour;
  source_hash: string;
  author_type: string;
  author_id: number | null;
  author_label: string | null;
  approver_id: number | null;
  revision: number;
  qa_errors: number;
  qa_warnings: number;
  created_at: number;
  updated_at: number;
};

/** The columns of a `TranslationRow`, for `SELECT`. */
export const TRANSLATION_COLUMNS =
  "string_id, language, value, colour, source_hash, author_type, author_id, author_label, approver_id, revision, qa_errors, qa_warnings, created_at, updated_at";

/** An active string in an active file, or `undefined`. */
export function loadString(sql: SyncSql, id: number): TargetString | undefined {
  return sql.query<TargetString>(
    `SELECT s.id, f.path, s.display_key, s.kind, s.source, s.source_hash, s.max_length,
            s.active * f.active AS active
     FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    id,
  )[0];
}

/** The translation of a string in a language, or `undefined` (red). */
export function loadTranslation(
  sql: SyncSql,
  stringId: number,
  language: string,
): TranslationRow | undefined {
  return sql.query<TranslationRow>(
    `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE string_id = ? AND language = ?`,
    stringId,
    language,
  )[0];
}

export interface WriteTranslation {
  stringId: number;
  language: string;
  /** The new value, or `null` to delete the translation (red). */
  value: TextValue | null;
  /** The colour of the new value. Required unless deleting. */
  colour?: Colour;
  /** Who makes the change: the history's actor, and the author when the text changes. */
  actor: Author;
  /** The author when it isn't the actor: an approved suggestion's (the actor approved it). */
  author?: Author;
  event: HistoryEvent;
  /**
   * The translation's revision the change is based on (0 for untranslated). A mismatch
   * fails with `conflict`, or makes an LLM write a no-op.
   */
  baseRevision?: number;
  /** The hash of the English the value was made for. Default: the string's current hash. */
  sourceHash?: string;
  /**
   * An LLM result: never over blue (LLM-4), and dropped if the translation changed. Always
   * so when `actor` is the LLM.
   */
  llm?: boolean;
  /** For blue translations: the person who approved it. */
  approverId?: number | null;
  /** Extra facts for the history: the model and request, the suggestion, the comment. */
  detail?: Record<string, unknown>;
  /** Store a value with check errors instead of refusing it. Only for known problems. */
  allowQaErrors?: boolean;
}

export interface WriteResult {
  /** `unchanged`: the same value, colour and English, so nothing was written. */
  status: "written" | "unchanged" | "skipped";
  /** Why an LLM write was skipped: a blue translation, or one changed meanwhile. */
  reason?: "blue" | "changed";
  /** The translation's revision now (0 when there is none). */
  revision: number;
  /** The checks of the value written (none for deletions and no-ops). */
  checks: CheckResult[];
}

/**
 * Writes one translation, inside the caller's transaction (design §5.3, §5.4):
 *
 * - The string must be active and translatable, and the language a project language.
 * - An LLM result is skipped over a blue translation (LLM-4), and when `baseRevision` no
 *   longer matches (a person changed it meanwhile). For everyone else, a `baseRevision`
 *   mismatch fails with `conflict` and the current translation.
 * - Writing the same value, colour and English hash changes nothing and writes no history.
 * - Values with check errors fail with `qa_failed` (QA-1), unless `allowQaErrors`.
 * - A write stores the checks' counts, the search text and the project revision, and adds
 *   a history row with the value and colour before and after.
 */
export function writeTranslation(
  ctx: Context,
  input: WriteTranslation,
  facts: Facts = loadFacts(ctx),
): WriteResult {
  const string = loadString(ctx.sql, input.stringId);
  const existing = loadTranslation(
    ctx.sql,
    input.stringId,
    canonicalLanguageTag(input.language) ?? input.language,
  );
  const actors = new ActorDirectory(
    ctx.sql,
    existing
      ? [{ type: existing.author_type, id: existing.author_id, label: existing.author_label }]
      : [],
    [existing?.approver_id ?? null],
  );
  const plan = planTranslationWrite(input, {
    string,
    existing,
    facts,
    actors,
    revision: writeRevision(ctx.sql),
    now: ctx.clock(),
  });
  if (plan.statements.length > 0) {
    bumpRevision(ctx.sql);
    for (const statement of plan.statements)
      ctx.sql.run(statement.sql, ...(statement.params ?? []));
  }
  return plan.result;
}

/** Plans the common translation rules and writes from one consistent snapshot. */
export function planTranslationWrite(
  input: WriteTranslation,
  state: {
    string: TargetString | undefined;
    existing: TranslationRow | undefined;
    facts: Facts;
    actors: ActorDirectory;
    revision: number;
    now: number;
  },
): { statements: Statement[]; result: WriteResult; translation: TranslationRow | null } {
  const { string, existing, facts, actors, revision, now } = state;
  if (string === undefined || string.active !== 1) throw notFound(`String ${input.stringId}`);
  if (!isTranslatableKind(string.kind)) {
    throw badRequest(`${string.display_key} is copied from the English, not translated.`);
  }
  const language = facts.languages.get(canonicalLanguageTag(input.language) ?? input.language);
  if (language === undefined) {
    throw badRequest(`The project has no language ${input.language}.`);
  }
  const current = existing?.revision ?? 0;
  // The rules for LLM results hold for anything the LLM wrote, flag or not (LLM-4).
  if (input.llm || input.actor.type === "llm") {
    if (input.value === null || input.colour !== "green") {
      throw new ServiceError("internal", "The LLM only writes green translations.");
    }
    if (existing?.colour === "blue")
      return { statements: [], result: skipped("blue", current), translation: existing ?? null };
    if (input.baseRevision !== undefined && input.baseRevision !== current) {
      return { statements: [], result: skipped("changed", current), translation: existing ?? null };
    }
  } else if (input.baseRevision !== undefined && input.baseRevision !== current) {
    const info = existing ? translationInfo(existing, string.source_hash, actors) : null;
    throw conflict(
      `The translation of ${string.display_key} (${language.tag}) changed meanwhile.`,
      info,
    );
  }
  if (input.value === null) {
    if (existing === undefined)
      return {
        statements: [],
        result: { status: "unchanged", revision: 0, checks: [] },
        translation: null,
      };
    return {
      statements: [
        {
          sql: "DELETE FROM translations WHERE string_id = ? AND language = ?",
          params: [string.id, existing.language],
        },
        translationHistory({
          stringId: string.id,
          language: existing.language,
          event: input.event,
          before: [existing.value, existing.colour],
          after: null,
          actor: input.actor,
          detail: input.detail,
          at: now,
        }),
      ],
      result: { status: "written", revision: 0, checks: [] },
      translation: null,
    };
  }

  const colour = input.colour;
  if (colour !== "green" && colour !== "blue") throw new ServiceError("internal", "No colour");
  const value = canonicalValue(input.value);
  const sourceHash = input.sourceHash ?? string.source_hash;
  if (
    existing?.value === value &&
    existing.colour === colour &&
    existing.source_hash === sourceHash
  ) {
    return {
      statements: [],
      result: { status: "unchanged", revision: current, checks: [] },
      translation: existing ?? null,
    };
  }
  const checks = checkValue(facts, string, language.tag, input.value);
  const errors = errorsOf(checks);
  if (errors.length > 0 && !input.allowQaErrors) throw qaFailed(string, language.tag, checks);

  const sameText = existing?.value === value;
  const author: Author =
    sameText && existing
      ? {
          type: existing.author_type as Author["type"],
          id: existing.author_id,
          label: existing.author_label,
        }
      : (input.author ?? input.actor);
  const approverId =
    colour === "blue"
      ? (input.approverId ?? (sameText && existing ? existing.approver_id : null))
      : null;
  const statements: Statement[] = [
    {
      sql: `INSERT INTO translations (${TRANSLATION_COLUMNS}, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (string_id, language) DO UPDATE SET
       value = excluded.value, colour = excluded.colour, source_hash = excluded.source_hash,
       author_type = excluded.author_type, author_id = excluded.author_id,
       author_label = excluded.author_label, approver_id = excluded.approver_id,
       revision = excluded.revision, qa_errors = excluded.qa_errors,
       qa_warnings = excluded.qa_warnings, search_text = excluded.search_text,
       updated_at = excluded.updated_at`,
      params: [
        string.id,
        language.tag,
        value,
        colour,
        sourceHash,
        author.type,
        author.id,
        author.label,
        approverId,
        revision,
        errors.length,
        checks.length - errors.length,
        existing?.created_at ?? now,
        now,
        normalizeSearch(valueText(input.value)),
      ],
    },
    translationHistory({
      stringId: string.id,
      language: language.tag,
      event: input.event,
      before: existing ? [existing.value, existing.colour] : null,
      after: [value, colour],
      actor: input.actor,
      detail: input.detail,
      at: now,
    }),
  ];
  // An LLM failure shown on the string stands until the pair is translated (design §5.6).
  statements.push({
    sql: "DELETE FROM llm_failures WHERE string_id = ? AND language = ?",
    params: [string.id, language.tag],
  });
  return {
    statements,
    result: { status: "written", revision, checks },
    translation: {
      string_id: string.id,
      language: language.tag,
      value,
      colour,
      source_hash: sourceHash,
      author_type: author.type,
      author_id: author.id,
      author_label: author.label,
      approver_id: approverId,
      revision,
      qa_errors: errors.length,
      qa_warnings: checks.length - errors.length,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    },
  };
}

function skipped(reason: "blue" | "changed", revision: number): WriteResult {
  return { status: "skipped", reason, revision, checks: [] };
}

/** A history row: before and after as `[value JSON, colour]` (colour null for the English). */
export interface HistoryRecord {
  stringId: number;
  language: string | null;
  event: HistoryEvent;
  before: [string, string | null] | null;
  after: [string, string | null] | null;
  actor: Author;
  detail?: Record<string, unknown> | null;
  at: number;
}

/** Appends a history row (STR-5). */
export function addHistory(sql: SyncSql, record: HistoryRecord): void {
  sql.run(
    `INSERT INTO history (string_id, language, event, before_value, after_value, before_colour,
       after_colour, actor_type, actor_id, actor_label, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...historyParams(record),
  );
}

function translationHistory(record: HistoryRecord): Statement {
  return {
    sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params: historyParams(record),
  };
}

/** The 12 parameters of a history row, in the order `addHistory` inserts them. */
export function historyParams(record: HistoryRecord): (string | number | null)[] {
  return [
    record.stringId,
    record.language,
    record.event,
    record.before?.[0] ?? null,
    record.after?.[0] ?? null,
    record.before?.[1] ?? null,
    record.after?.[1] ?? null,
    record.actor.type,
    record.actor.id,
    record.actor.label,
    record.detail ? toJson(record.detail) : null,
    record.at,
  ];
}

/** The quality checks of a value for a string, in a language (design §5.7). */
export function checkValue(
  facts: CheckFacts,
  string: Pick<TargetString, "kind" | "source" | "max_length">,
  language: string,
  value: TextValue,
): CheckResult[] {
  return checkTranslation({
    kind: string.kind as TranslatableKind,
    source: fromJson<TextValue>(string.source),
    translation: value,
    language,
    maxLength: string.max_length,
    syntax: facts.syntax,
    pluralOverride: overrideOf(facts, language),
    glossary: facts.glossary?.filter(
      (term) => term.language === null || term.language === language,
    ),
  });
}

/** The `qa_failed` error for a value with check errors, with a detail for each error. */
export function qaFailed(
  string: Pick<TargetString, "path" | "display_key">,
  language: string,
  checks: readonly CheckResult[],
): ServiceError {
  const errors = errorsOf(checks);
  return new ServiceError("qa_failed", errors[0]?.message ?? "The translation fails the checks.", {
    details: errors.map((result) => checkDetail(string, language, result)),
  });
}

function checkDetail(
  string: Pick<TargetString, "path" | "display_key">,
  language: string,
  result: CheckResult,
): ErrorDetail {
  const detail: ErrorDetail = {
    file: string.path,
    key: string.display_key,
    language,
    check: result.check,
    message: result.message,
  };
  if (result.value !== undefined) detail.value = result.value;
  if (result.form !== undefined) detail.form = result.form;
  return detail;
}

/**
 * Runs the checks again on the translations of some strings, after their English or their
 * limit changed, and stores the new counts. Translations that now fail stay (design §5.7):
 * the "QA problems" filter lists them. Returns how many translations changed counts.
 */
export function recomputeQa(
  ctx: Context,
  stringIds: Iterable<number>,
  facts: Facts = loadFacts(ctx),
): number {
  const ids = [...new Set(stringIds)];
  let updated = 0;
  for (let start = 0; start < ids.length; start += 500) {
    const rows = ctx.sql.query<QaRow>(
      `SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source,
              s.max_length
       FROM translations t JOIN strings s ON s.id = t.string_id
       WHERE t.string_id IN (${idList(ids.slice(start, start + 500))})
         AND s.kind IN (${TRANSLATABLE_SQL})`,
    );
    const statements = planQa(rows, facts);
    for (const statement of statements) ctx.sql.run(statement.sql, ...(statement.params ?? []));
    updated += statements.length;
  }
  return updated;
}

/** Translation checks with the source and limit after the operation's changes. */
export type QaRow = {
  string_id: number;
  language: string;
  value: string;
  qa_errors: number;
  qa_warnings: number;
  kind: string;
  source: string;
  max_length: number | null;
};

/** Recheck a snapshot without I/O; store only counts that changed. */
export function planQa(rows: QaRow[], facts: CheckFacts): Statement[] {
  const statements: Statement[] = [];
  for (const row of rows) {
    const checks = checkValue(facts, row, row.language, fromJson<TextValue>(row.value));
    const errors = errorsOf(checks).length;
    const warnings = checks.length - errors;
    if (errors === row.qa_errors && warnings === row.qa_warnings) continue;
    statements.push({
      sql: "UPDATE translations SET qa_errors = ?, qa_warnings = ? WHERE string_id = ? AND language = ?",
      params: [errors, warnings, row.string_id, row.language],
    });
  }
  return statements;
}

/** A translation row as `TranslationInfo`, given the string's current English hash. */
export function translationInfo(
  row: TranslationRow,
  stringHash: string,
  actors: ActorDirectory,
): TranslationInfo {
  return {
    value: fromJson<TextValue>(row.value),
    colour: row.colour,
    outdated: row.source_hash !== stringHash,
    revision: row.revision,
    qa: { errors: row.qa_errors, warnings: row.qa_warnings },
    author: actors.info({ type: row.author_type, id: row.author_id, label: row.author_label }),
    approver: actors.user(row.approver_id),
    updatedAt: row.updated_at,
  };
}

/** `TranslationInfo` for one row, looking up its people and keys. */
export function describeTranslation(
  sql: SyncSql,
  row: TranslationRow,
  stringHash: string,
): TranslationInfo {
  const actors = new ActorDirectory(
    sql,
    [{ type: row.author_type, id: row.author_id, label: row.author_label }],
    [row.approver_id],
  );
  return translationInfo(row, stringHash, actors);
}
