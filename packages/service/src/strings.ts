// SPDX-License-Identifier: MIT
/**
 * The strings for the editor and the public site (WEB-1, WEB-2): lists with filters,
 * search and paging, and one string with everything around it.
 */
import {
  type CheckResult,
  languageName,
  type ReferenceHint,
  referencesOf,
  type StringDetail,
  type StringsPage,
  type StringsQuery,
  type StringsQueueQuery,
  type StringsQueue,
  type StringSummary,
  type SuggestionInfo,
  type TextValue,
  type TranslatableKind,
  canonicalLanguageTag,
} from "@quaso/core";
import { ActorDirectory, type ActorRows, actorReadStatements } from "./actors.ts";
import type { Context } from "./context.ts";
import { fromJson, fromJsonOrNull, idList, normalizeSearch, toJson } from "./db.ts";
import { TRANSLATABLE_SQL } from "./entries.ts";
import { badRequest, notFound, ServiceError } from "./errors.ts";
import { type GlossaryRow, glossaryTermFromRow, matchingGlossary } from "./glossary.ts";
import { type Facts, loadFacts } from "./facts.ts";
import { type LanguageRow, requireLanguage, toLanguage } from "./languages.ts";
import { settingsFromData } from "./settings.ts";
import type { Sql, SqlValue, Statement } from "./ports.ts";
import {
  checkValue,
  TRANSLATION_READ_COLUMNS,
  translationInfo,
  type TranslationRow,
} from "./translations.ts";

/** Strings per page when the query doesn't say. */
export const DEFAULT_LIMIT = 100;

/** How long reviewed suggestions stay in a string's details. */
const RECENT_REVIEWS = 30 * 24 * 60 * 60 * 1000;

/** A string with its translation in one language (columns prefixed `t_`), as listed. */
type SummaryRow = {
  id: number;
  file_id: number;
  path: string;
  display_key: string;
  kind: TranslatableKind;
  source: string;
  source_hash: string;
  description: string;
  max_length: number | null;
  max_length_locked: number;
  words: number;
  pending: number;
  t_value: string | null;
  t_colour: string | null;
  t_source_hash: string | null;
  t_author_type: string | null;
  t_author_id: number | null;
  t_author_label: string | null;
  t_approver_id: number | null;
  t_revision: number | null;
  t_qa_errors: number | null;
  t_qa_warnings: number | null;
  t_extra_checks: string | null;
  t_created_at: number | null;
  t_updated_at: number | null;
};

const SUMMARY_COLUMNS = `s.id, s.file_id, f.path, s.display_key, s.kind, s.source,
  s.source_hash, s.description, s.max_length, s.max_length_locked, s.words,
  (SELECT COUNT(*) FROM suggestions g
   WHERE g.string_id = s.id AND g.language = ? AND g.status = 'pending') AS pending,
  t.value AS t_value, t.colour AS t_colour, t.source_hash AS t_source_hash,
  t.author_type AS t_author_type, t.author_id AS t_author_id,
  t.author_label AS t_author_label, t.approver_id AS t_approver_id,
  t.revision AS t_revision, t.qa_errors AS t_qa_errors, t.qa_warnings AS t_qa_warnings, t.extra_checks AS t_extra_checks,
  t.created_at AS t_created_at, t.updated_at AS t_updated_at`;

const SUMMARY_FROM = `strings s JOIN files f ON f.id = s.file_id
  LEFT JOIN translations t ON t.string_id = s.id AND t.language = ?`;

/** Conditions for each state filter. */
const STATES: Record<NonNullable<StringsQuery["state"]>, string> = {
  untranslated: "t.string_id IS NULL",
  green: "t.colour = 'green'",
  blue: "t.colour = 'blue'",
  outdated: "t.source_hash <> s.source_hash",
  pending: `EXISTS (SELECT 1 FROM suggestions g
    WHERE g.string_id = s.id AND g.language = ? AND g.status = 'pending')`,
  qa: "(t.qa_errors > 0 OR json_array_length(t.extra_checks) > 0)",
};

/**
 * `GET /strings`: the active, translatable strings of active files in one language, by
 * file path and position, filtered by state, search text (in the key, the English and
 * the translation), file (a path, or a folder ending in `/`) and IDs. The cursor is an
 * offset, opaque to clients.
 */
export function listStrings(ctx: Context, query: StringsQuery): StringsPage {
  const language = requireLanguage(ctx, query.language).tag;
  const { count, page, offset } = listStatements(query, language);
  const total = ctx.sql.query<{ n: number }>(count.sql, ...(count.params ?? []))[0].n;
  const rows = ctx.sql.query<SummaryRow>(page.sql, ...(page.params ?? []));
  const actors = directoryFor(ctx, rows);
  const failures = llmFailures(
    ctx,
    rows.map((row) => row.id),
    language,
  );
  return listResult(rows, actors, failures, { language, offset, total });
}

function listStatements(
  query: StringsQuery,
  language: string,
): { count: Statement; page: Statement; offset: number } {
  const offset = parseCursor(query.cursor);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const { condition, params } = stringConditions(query, language);
  return {
    offset,
    count: {
      sql: `SELECT COUNT(*) AS n FROM ${SUMMARY_FROM} WHERE ${condition}`,
      params: [language, ...params],
    },
    page: {
      sql: `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE ${condition}
     ORDER BY f.path, s.position LIMIT ? OFFSET ?`,
      params: [language, language, ...params, limit, offset],
    },
  };
}

function stringConditions(query: StringsQuery, language: string) {
  const where = ["s.active = 1", "f.active = 1", `s.kind IN (${TRANSLATABLE_SQL})`];
  const params: SqlValue[] = [];
  if (query.state !== undefined) {
    where.push(STATES[query.state]);
    if (query.state === "pending") params.push(language);
  }
  if (query.q !== undefined && query.q.trim() !== "") {
    // instr(), not LIKE: Durable Objects refuse LIKE patterns over 50 bytes, and both
    // sides are already normalized (NFKC, lower case), so a plain substring search is
    // exact, whatever the query's length, with `%` and `_` as themselves.
    const text = normalizeSearch(query.q.trim());
    where.push("(instr(s.search_text, ?) > 0 OR instr(t.search_text, ?) > 0)");
    params.push(text, text);
  }
  if (query.file !== undefined) {
    if (query.file.endsWith("/")) {
      // Not LIKE, which ignores case: paths are compared exactly, as everywhere else.
      where.push("substr(f.path, 1, length(?)) = ?");
      params.push(query.file, query.file);
    } else {
      where.push("f.path = ?");
      params.push(query.file);
    }
  }
  if (query.ids !== undefined) where.push(`s.id IN (${idList(query.ids)})`);
  return { condition: where.join(" AND "), params };
}

type QueueRow = { id: number; priority: number };

function queueStatement(query: StringsQueueQuery, language: string): Statement {
  const { condition, params } = stringConditions(query, language);
  return {
    sql: `SELECT s.id, CASE WHEN t.string_id IS NULL THEN 0
      WHEN t.source_hash <> s.source_hash THEN 1 ELSE 2 END AS priority
      FROM ${SUMMARY_FROM} WHERE ${condition}
      ORDER BY priority, f.path, s.position, s.id`,
    params: [language, ...params],
  };
}

function queueResult(language: string, rows: QueueRow[]): StringsQueue {
  return {
    language,
    ids: rows.map((row) => row.id),
    toDo: rows.filter((row) => row.priority < 2).length,
  };
}

export function getStringsQueue(ctx: Context, query: StringsQueueQuery): StringsQueue {
  const language = requireLanguage(ctx, query.language).tag;
  const statement = queueStatement(query, language);
  return queueResult(language, ctx.sql.query<QueueRow>(statement.sql, ...(statement.params ?? [])));
}

export async function getStringsQueueAsync(
  sql: Sql,
  query: StringsQueueQuery,
): Promise<StringsQueue> {
  const language = canonicalLanguageTag(query.language) ?? query.language;
  const [found, rows] = await sql.read([
    { sql: "SELECT tag FROM languages WHERE tag = ?", params: [language] },
    queueStatement(query, language),
  ]);
  if (found.length === 0)
    throw new ServiceError("not_found", `The project has no language ${query.language}.`);
  return queueResult(language, rows as QueueRow[]);
}

/** The page, count, identities and failures share one snapshot. */
export async function listStringsAsync(sql: Sql, query: StringsQuery): Promise<StringsPage> {
  const language = canonicalLanguageTag(query.language) ?? query.language;
  const { count, page, offset } = listStatements(query, language);
  const refs: Statement = {
    sql: `SELECT t_author_type AS actor_type, t_author_id AS actor_id FROM (${page.sql})
      UNION ALL SELECT 'user' AS actor_type, t_approver_id AS actor_id FROM (${page.sql})`,
    params: [...(page.params ?? []), ...(page.params ?? [])],
  };
  const [found, totals, rows, users, tokens, failures] = await sql.read([
    { sql: "SELECT tag FROM languages WHERE tag = ?", params: [language] },
    count,
    page,
    ...actorReadStatements(refs),
    {
      sql: `SELECT string_id, reason FROM llm_failures WHERE language = ? AND string_id IN (SELECT id FROM (${page.sql}))`,
      params: [language, ...(page.params ?? [])],
    },
  ]);
  if (found.length === 0)
    throw new ServiceError("not_found", `The project has no language ${query.language}.`);
  const actors = new ActorDirectory({
    users: users as ActorRows["users"],
    tokens: tokens as ActorRows["tokens"],
  });
  const failed = new Map(
    (failures as { string_id: number; reason: string }[]).map((row) => [row.string_id, row.reason]),
  );
  return listResult(rows as SummaryRow[], actors, failed, {
    language,
    offset,
    total: Number(totals[0].n),
  });
}

function listResult(
  rows: SummaryRow[],
  actors: ActorDirectory,
  failures: Map<number, string>,
  page: { language: string; offset: number; total: number },
): StringsPage {
  const { language, offset, total } = page;
  return {
    language,
    strings: rows.map((row) => summaryOf(row, actors, failures.get(row.id) ?? null)),
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
    total,
  };
}

/** The last LLM failure of each string in a language, while it stands (design §5.6). */
function llmFailures(ctx: Context, ids: number[], language: string): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = ctx.sql.query<{ string_id: number; reason: string }>(
    `SELECT string_id, reason FROM llm_failures
     WHERE language = ? AND string_id IN (${idList(ids)})`,
    language,
  );
  return new Map(rows.map((row) => [row.string_id, row.reason]));
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d{1,9}$/.test(cursor)) throw badRequest("The cursor is invalid.");
  return Number(cursor);
}

/** The people and keys behind the rows' translations. */
function directoryFor(ctx: Context, rows: SummaryRow[]): ActorDirectory {
  return new ActorDirectory(
    ctx.sql,
    rows
      .filter((row) => row.t_value !== null)
      .map((row) => ({
        type: row.t_author_type!,
        id: row.t_author_id,
        label: row.t_author_label,
      })),
    rows.map((row) => row.t_approver_id),
  );
}

function summaryOf(
  row: SummaryRow,
  actors: ActorDirectory,
  llmFailure: string | null = null,
): StringSummary {
  return {
    id: row.id,
    fileId: row.file_id,
    file: row.path,
    key: row.display_key,
    kind: row.kind,
    source: fromJson<TextValue>(row.source),
    description: row.description,
    maxLength: row.max_length,
    maxLengthLocked: row.max_length_locked === 1,
    words: row.words,
    translation:
      row.t_value === null
        ? null
        : translationInfo(
            {
              string_id: row.id,
              language: "",
              value: row.t_value,
              colour: row.t_colour as TranslationRow["colour"],
              source_hash: row.t_source_hash!,
              author_type: row.t_author_type!,
              author_id: row.t_author_id,
              author_label: row.t_author_label,
              approver_id: row.t_approver_id,
              revision: row.t_revision!,
              qa_errors: row.t_qa_errors!,
              qa_warnings: row.t_qa_warnings!,
              extra_checks: row.t_extra_checks ?? "[]",
              created_at: row.t_created_at!,
              updated_at: row.t_updated_at!,
            },
            row.source_hash,
            actors,
          ),
    pending: row.pending,
    llmFailure,
  };
}

type SuggestionRow = {
  id: number;
  kind: SuggestionInfo["kind"];
  value: string | null;
  status: SuggestionInfo["status"];
  author_type: string;
  author_id: number | null;
  author_label: string | null;
  reviewer_id: number | null;
  comment: string | null;
  created_at: number;
  reviewed_at: number | null;
  base_revision: number;
};

/**
 * `GET /strings/{id}?language=`: the string with its translation, its suggestions (pending,
 * or reviewed in the last 30 days), the same string in every other project language, what
 * its nesting references point to, and the checks of the current translation.
 */
export function getString(ctx: Context, id: number, language: string): StringDetail {
  const { sql } = ctx;
  const tag = requireLanguage(ctx, language).tag;
  const [row] = sql.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM}
     WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`,
    tag,
    tag,
    id,
  );
  if (row === undefined) throw notFound(`String ${id}`);
  const facts = loadFacts(ctx);
  const translations = sql.query<TranslationRow>(
    `SELECT ${TRANSLATION_READ_COLUMNS} FROM translations WHERE string_id = ?`,
    id,
  );
  const suggestions = sql.query<SuggestionRow>(
    `SELECT id, kind, value, status, author_type, author_id, author_label, reviewer_id, comment,
            created_at, reviewed_at, base_revision
     FROM suggestions WHERE string_id = ? AND language = ?
       AND (status = 'pending' OR reviewed_at >= ?)
     ORDER BY id DESC`,
    id,
    tag,
    ctx.clock() - RECENT_REVIEWS,
  );
  const actors = new ActorDirectory(
    sql,
    [
      ...translations.map((t) => ({ type: t.author_type, id: t.author_id, label: t.author_label })),
      ...suggestions.map((g) => ({ type: g.author_type, id: g.author_id, label: g.author_label })),
    ],
    [...translations.map((t) => t.approver_id), ...suggestions.map((g) => g.reviewer_id)],
  );
  return stringDetail(
    {
      row,
      facts,
      translations,
      suggestions,
      actors,
      failure: llmFailures(ctx, [id], tag).get(id) ?? null,
      references: referenceHints(ctx, fromJson<TextValue>(row.source), row.path, facts.syntax),
      sourceWarnings: sql.query(sourceWarningStatement(id).sql, id) as NonNullable<
        StringDetail["sourceWarnings"]
      >,
      identicalSources: sql.query(identicalSourceStatement(id).sql, id, id, id) as NonNullable<
        StringDetail["identicalSources"]
      >,
    },
    tag,
  );
}

/** Reference targets are planned first; matching revisions keep both reads consistent. */
export async function getStringAsync(
  sql: Sql,
  id: number,
  language: string,
  options: { model: string; clock?: () => number },
): Promise<StringDetail> {
  const tag = canonicalLanguageTag(language) ?? language;
  const revision: Statement = {
    sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
  };
  const settingsRead: Statement = { sql: "SELECT data FROM settings WHERE id = 1" };
  const now = (options.clock ?? Date.now)();
  for (let attempt = 0; attempt < 4; attempt++) {
    const [preparedRevision, preparedSettings, sources, found] = await sql.read([
      revision,
      settingsRead,
      {
        sql: `SELECT s.source, f.path FROM strings s JOIN files f ON f.id = s.file_id
        WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`,
        params: [id],
      },
      { sql: "SELECT tag FROM languages WHERE tag = ?", params: [tag] },
    ]);
    if (found.length === 0)
      throw new ServiceError("not_found", `The project has no language ${language}.`);
    if (sources.length === 0) throw notFound(`String ${id}`);
    const settings = settingsFromData(
      (preparedSettings[0]?.data as string | undefined) ?? null,
      options.model,
    );
    const targets = referenceTargets(
      fromJson<TextValue>(sources[0].source),
      sources[0].path as string,
      settings.syntax,
    );
    const translations: Statement = {
      sql: `SELECT ${TRANSLATION_READ_COLUMNS} FROM translations WHERE string_id = ?`,
      params: [id],
    };
    const suggestions: Statement = {
      sql: `SELECT id, kind, value, status, author_type, author_id, author_label, reviewer_id, comment,
        created_at, reviewed_at, base_revision FROM suggestions WHERE string_id = ? AND language = ?
        AND (status = 'pending' OR reviewed_at >= ?) ORDER BY id DESC`,
      params: [id, tag, now - RECENT_REVIEWS],
    };
    const refs: Statement = {
      sql: `SELECT author_type AS actor_type, author_id AS actor_id FROM (${translations.sql})
        UNION ALL SELECT 'user', approver_id FROM (${translations.sql})
        UNION ALL SELECT author_type, author_id FROM (${suggestions.sql})
        UNION ALL SELECT 'user', reviewer_id FROM (${suggestions.sql})
        UNION ALL SELECT 'user', created_by FROM glossary_terms`,
      params: [
        ...translations.params!,
        ...translations.params!,
        ...suggestions.params!,
        ...suggestions.params!,
      ],
    };
    const [
      currentRevision,
      currentSettings,
      languages,
      summaries,
      translated,
      suggested,
      glossary,
      users,
      tokens,
      failures,
      referenced,
      identicalSources,
      sourceWarnings,
    ] = await sql.read([
      revision,
      settingsRead,
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
      {
        sql: `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`,
        params: [tag, tag, id],
      },
      translations,
      suggestions,
      { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
      ...actorReadStatements(refs),
      {
        sql: "SELECT reason FROM llm_failures WHERE string_id = ? AND language = ?",
        params: [id, tag],
      },
      {
        sql: `SELECT json_extract(r.value, '$.raw') AS raw, s.source FROM json_each(?) r
        JOIN files f ON f.path = json_extract(r.value, '$.file')
        JOIN strings s ON s.file_id = f.id AND s.display_key = json_extract(r.value, '$.key')
        WHERE s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})
        ORDER BY s.kind = 'text' DESC`,
        params: [toJson(targets)],
      },
      identicalSourceStatement(id),
      sourceWarningStatement(id),
    ]);
    if (currentRevision[0].revision !== preparedRevision[0].revision) continue;
    const row = summaries[0] as SummaryRow | undefined;
    if (row === undefined) throw notFound(`String ${id}`);
    const actors = new ActorDirectory({
      users: users as ActorRows["users"],
      tokens: tokens as ActorRows["tokens"],
    });
    const current = settingsFromData(
      (currentSettings[0]?.data as string | undefined) ?? null,
      options.model,
    );
    const facts: Facts = {
      sourceLanguage: current.sourceLanguage,
      syntax: current.syntax,
      languages: new Map(
        (languages as LanguageRow[]).map(toLanguage).map((entry) => [entry.tag, entry]),
      ),
      glossary: (glossary as GlossaryRow[]).map((entry) => glossaryTermFromRow(entry, actors)),
    };
    const english = new Map<string, string | null>();
    for (const reference of referenced) {
      const raw = reference.raw as string;
      if (!english.has(raw)) english.set(raw, referenceEnglish(reference.source as string));
    }
    return stringDetail(
      {
        row,
        facts,
        translations: translated as TranslationRow[],
        suggestions: suggested as SuggestionRow[],
        actors,
        failure: (failures[0]?.reason as string | undefined) ?? null,
        identicalSources: identicalSources as NonNullable<StringDetail["identicalSources"]>,
        sourceWarnings: sourceWarnings as NonNullable<StringDetail["sourceWarnings"]>,
        references: targets.map((target) => ({
          raw: target.raw,
          english: english.get(target.raw) ?? null,
        })),
      },
      tag,
    );
  }
  throw new ServiceError("unavailable", "The project is busy. Try again shortly.");
}

function stringDetail(
  data: {
    row: SummaryRow;
    facts: Facts;
    translations: TranslationRow[];
    suggestions: SuggestionRow[];
    actors: ActorDirectory;
    failure: string | null;
    references: ReferenceHint[];
    identicalSources?: NonNullable<StringDetail["identicalSources"]>;
    sourceWarnings?: NonNullable<StringDetail["sourceWarnings"]>;
  },
  tag: string,
): StringDetail {
  const { row, facts, translations, suggestions, actors } = data;
  const id = row.id;
  const info = (t: TranslationRow) => translationInfo(t, row.source_hash, actors);
  const byLanguage = new Map(translations.map((t) => [t.language, t]));
  const summary = summaryOf(row, actors, data.failure);
  const current = summary.translation;
  const source = summary.source;
  const checksOf = (value: TextValue): CheckResult[] => checkValue(facts, row, tag, value);
  const extra = fromJson<CheckResult[]>(byLanguage.get(tag)?.extra_checks ?? "[]");
  return {
    ...summary,
    ...(data.identicalSources?.length ? { identicalSources: data.identicalSources } : {}),
    ...(data.sourceWarnings?.length ? { sourceWarnings: data.sourceWarnings } : {}),
    language: tag,
    suggestions: suggestions.map((g) => ({
      id: g.id,
      stringId: id,
      language: tag,
      file: row.path,
      key: row.display_key,
      kind: g.kind,
      value: fromJsonOrNull<TextValue>(g.value),
      status: g.status,
      author: actors.info({ type: g.author_type, id: g.author_id, label: g.author_label }),
      reviewer: actors.user(g.reviewer_id),
      comment: g.comment,
      createdAt: g.created_at,
      reviewedAt: g.reviewed_at,
      baseRevision: g.base_revision,
      source,
      current,
      checks: g.value === null ? [] : checksOf(fromJson<TextValue>(g.value)),
    })),
    otherLanguages: [...facts.languages.values()]
      .filter((other) => other.tag !== tag)
      .map((other) => {
        const translation = byLanguage.get(other.tag);
        return {
          language: other.tag,
          name: languageName(other.tag),
          translation: translation ? info(translation) : null,
        };
      }),
    references: data.references,
    checks: current === null ? [] : [...checksOf(current.value), ...extra],
    glossary: matchingGlossary(
      facts.glossary ?? [],
      tag,
      typeof source === "string" ? [source] : Object.values(source),
    ),
  };
}

/**
 * The nesting references in the English, each once, with the English they point to:
 * `$t(ns:key)` names a key in `ns.json`, `$t(key)` one in the same file. A plural string
 * gives its `other` form.
 */
function referenceHints(
  ctx: Context,
  source: TextValue,
  file: string,
  syntax: { prefix: string; suffix: string },
): ReferenceHint[] {
  return referenceTargets(source, file, syntax).map((reference) => {
    const [found] = ctx.sql.query<{ source: string }>(
      `SELECT s.source FROM strings s JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND s.display_key = ? AND s.active = 1 AND f.active = 1
         AND s.kind IN (${TRANSLATABLE_SQL})
       ORDER BY s.kind = 'text' DESC LIMIT 1`,
      reference.file,
      reference.key,
    );
    return {
      raw: reference.raw,
      english: found === undefined ? null : referenceEnglish(found.source),
    };
  });
}

function referenceEnglish(source: string): string | null {
  const value = fromJson<TextValue>(source);
  return typeof value === "string" ? value : (value.other ?? null);
}

function referenceTargets(
  source: TextValue,
  file: string,
  syntax: { prefix: string; suffix: string },
): { raw: string; file: string; key: string }[] {
  const texts = typeof source === "string" ? [source] : Object.values(source);
  const hints = new Map<string, { raw: string; file: string; key: string }>();
  for (const text of texts) {
    for (const reference of referencesOf(text ?? "", syntax)) {
      if (hints.has(reference.raw)) continue;
      const target = reference.namespace !== undefined ? `${reference.namespace}.json` : file;
      hints.set(reference.raw, { raw: reference.raw, file: target, key: reference.key });
    }
  }
  return [...hints.values()];
}

function identicalSourceStatement(id: number): Statement {
  return {
    sql: `SELECT s.id, f.path AS file, s.display_key AS key FROM strings s JOIN files f ON f.id = s.file_id
      WHERE s.active = 1 AND f.active = 1 AND s.id <> ? AND s.source_hash = (SELECT source_hash FROM strings WHERE id = ?)
      AND s.kind = (SELECT kind FROM strings WHERE id = ?) ORDER BY f.path, s.position LIMIT 50`,
    params: [id, id, id],
  };
}

function sourceWarningStatement(id: number): Statement {
  return {
    sql: `SELECT w.kind, w.message FROM source_warnings w JOIN strings s ON s.id = w.string_id
    WHERE s.id = ? AND w.source_hash = s.source_hash AND trim(s.description) = ''`,
    params: [id],
  };
}
