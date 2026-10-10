// SPDX-License-Identifier: MIT
/**
 * Suggestions and review (design §5.4, §5.8; STR-2, STR-5, WEB-4): contributors send
 * translations, corrections and "looks good"; managers approve or reject them, one or many
 * at a time. Approving writes the value blue through the single write path, with the
 * suggestion's author and the reviewer as approver, and supersedes the other pending
 * suggestions for the same string and language. Downloads never read suggestions.
 */
import {
  canonicalLanguageTag,
  canonicalValue,
  type CheckResult,
  errorsOf,
  type ReviewRequest,
  type ReviewResult,
  type SuggestionInfo,
  type SuggestionKind,
  type SuggestionsPage,
  type SuggestionsQuery,
  type SuggestionStatus,
  type TextValue,
} from "@quaso/core";
import {
  ActorDirectory,
  type ActorRows,
  actorReadStatements,
  type Author,
  authorFor,
  SYSTEM_AUTHOR,
} from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, fromJson, fromJsonOrNull, toJson, transaction } from "./db.ts";
import { isTranslatableKind } from "./entries.ts";
import { badRequest, conflict, forbidden, notFound, ServiceError } from "./errors.ts";
import { type Facts, loadFacts } from "./facts.ts";
import { type GlossaryRow, glossaryTermFromRow } from "./glossary.ts";
import { type LanguageRow, toLanguage } from "./languages.ts";
import {
  can,
  permissionReadStatements,
  permissionsFromRows,
  requirePermission,
} from "./permissions.ts";
import type { Sql, SqlValue, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";
import { settingsFromData } from "./settings.ts";
import {
  addHistory,
  historyParams,
  checkValue,
  describeTranslation,
  loadString,
  loadTranslation,
  qaFailed,
  TRANSLATION_COLUMNS,
  translationInfo,
  type TranslationRow,
  type TargetString,
  writeTranslation,
  planTranslationWrite,
  type WriteTranslation,
} from "./translations.ts";

/** Suggestions per page when the query doesn't say. */
export const DEFAULT_SUGGESTIONS_LIMIT = 100;

type SuggestionRow = {
  id: number;
  string_id: number;
  language: string;
  kind: SuggestionKind;
  value: string | null;
  source_hash: string;
  base_revision: number;
  status: SuggestionStatus;
  author_type: string;
  author_id: number | null;
  author_label: string | null;
  reviewer_id: number | null;
  comment: string | null;
  created_at: number;
  reviewed_at: number | null;
  extra_checks?: string;
};

const SUGGESTION_COLUMNS = `g.id, g.string_id, g.language, g.kind, g.value, g.source_hash,
  g.base_revision, g.status, g.author_type, g.author_id, g.author_label, g.reviewer_id,
  g.comment, g.created_at, g.reviewed_at, g.extra_checks`;

/** A suggestion with its string and the current translation (columns `t_…`). */
type ListedRow = SuggestionRow & {
  path: string;
  display_key: string;
  string_kind: string;
  source: string;
  string_hash: string;
  max_length: number | null;
} & { [K in keyof TranslationRow as `t_${K & string}`]: TranslationRow[K] | null };

const LISTED_COLUMNS = `${SUGGESTION_COLUMNS}, f.path, s.display_key, s.kind AS string_kind,
  s.source, s.source_hash AS string_hash, s.max_length,
  ${TRANSLATION_COLUMNS.split(", ")
    .map((column) => `t.${column} AS t_${column}`)
    .join(", ")}`;

const LISTED_FROM = `suggestions g JOIN strings s ON s.id = g.string_id
  JOIN files f ON f.id = s.file_id
  LEFT JOIN translations t ON t.string_id = g.string_id AND t.language = g.language`;

function translationOf(row: ListedRow): TranslationRow | null {
  if (row.t_value === null) return null;
  const out: Record<string, unknown> = {};
  for (const column of TRANSLATION_COLUMNS.split(", ")) {
    out[column] = row[`t_${column}` as keyof ListedRow];
  }
  return out as TranslationRow;
}

/** Suggestions as the API shows them, with the English, the current text and the checks. */
function describe(
  ctx: Context,
  rows: ListedRow[],
  facts: Facts = loadFacts(ctx),
): SuggestionInfo[] {
  const actors = new ActorDirectory(
    ctx.sql,
    rows.flatMap((row) => {
      const refs = [{ type: row.author_type, id: row.author_id, label: row.author_label }];
      if (row.t_value !== null) {
        refs.push({ type: row.t_author_type!, id: row.t_author_id, label: row.t_author_label });
      }
      return refs;
    }),
    rows.flatMap((row) => [row.reviewer_id, row.t_approver_id]),
  );
  return describeRows(rows, facts, actors);
}

function describeRows(rows: ListedRow[], facts: Facts, actors: ActorDirectory): SuggestionInfo[] {
  return rows.map((row) =>
    describeSuggestion(row, {
      string: {
        path: row.path,
        display_key: row.display_key,
        kind: row.string_kind,
        source: row.source,
        source_hash: row.string_hash,
        max_length: row.max_length,
      },
      current: translationOf(row),
      facts,
      actors,
    }),
  );
}

function describeSuggestion(
  row: SuggestionRow,
  context: {
    string: Pick<
      TargetString,
      "path" | "display_key" | "kind" | "source" | "source_hash" | "max_length"
    >;
    current: TranslationRow | null;
    facts: Facts;
    actors: ActorDirectory;
  },
): SuggestionInfo {
  const { string, current, facts, actors } = context;
  const value = fromJsonOrNull<TextValue>(row.value);
  const checked = value ?? (current ? fromJson<TextValue>(current.value) : null);
  let checks: CheckResult[] = [];
  if (checked !== null && isTranslatableKind(string.kind) && facts.languages.has(row.language)) {
    checks = [
      ...checkValue(facts, string, row.language, checked),
      ...fromJson<CheckResult[]>(row.extra_checks ?? "[]"),
    ];
  }
  return {
    id: row.id,
    stringId: row.string_id,
    language: row.language,
    file: string.path,
    key: string.display_key,
    kind: row.kind,
    value,
    status: row.status,
    author: actors.info({ type: row.author_type, id: row.author_id, label: row.author_label }),
    reviewer: actors.user(row.reviewer_id),
    comment: row.comment,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    baseRevision: row.base_revision,
    source: fromJson<TextValue>(string.source),
    current: current ? translationInfo(current, string.source_hash, actors) : null,
    checks,
  };
}

function loadListed(ctx: Context, id: number): ListedRow | undefined {
  return ctx.sql.query<ListedRow>(
    `SELECT ${LISTED_COLUMNS} FROM ${LISTED_FROM} WHERE g.id = ?`,
    id,
  )[0];
}

/** One suggestion as the API shows it. */
export function suggestionInfo(ctx: Context, id: number): SuggestionInfo {
  const row = loadListed(ctx, id);
  if (row === undefined) throw notFound(`Suggestion ${id}`);
  return describe(ctx, [row])[0];
}

// ---------------------------------------------------------------------------------------
// Sending

export interface SuggestInput {
  /** The string. */
  id: number;
  language: string;
  kind: "translation" | "correction" | "approval";
  value?: TextValue;
  baseRevision: number;
}

/**
 * Sends a pending change (STR-2): a translation for a red string, a correction for a green
 * or blue one, or "looks good" (`approval`, without a value) for a green one. The kind
 * follows the string's state: a "translation" of a string translated meanwhile at the same
 * revision is a correction, and a correction that repeats a green text is a "looks good".
 * The checks run now (`qa_failed`); a stale `baseRevision` fails with `conflict` and the
 * current translation. The author's older pending suggestion for the same string and
 * language is superseded.
 */
export function suggest(ctx: Context, actor: Actor, input: SuggestInput): SuggestionInfo {
  const { sql } = ctx;
  const facts = loadFacts(ctx);
  const string = loadString(sql, input.id);
  if (string === undefined || string.active !== 1) throw notFound(`String ${input.id}`);
  if (!isTranslatableKind(string.kind)) {
    throw badRequest(`${string.display_key} is copied from the English, not translated.`);
  }
  const language = facts.languages.get(canonicalTag(input.language));
  if (language === undefined) throw badRequest(`The project has no language ${input.language}.`);
  requirePermission(ctx, actor, "suggest", language.tag);
  const author = authorFor(ctx, actor);

  const existing = loadTranslation(sql, string.id, language.tag);
  const revision = existing?.revision ?? 0;
  if (input.baseRevision !== revision) {
    throw conflict(
      `The translation of ${string.display_key} (${language.tag}) changed meanwhile.`,
      existing ? describeTranslation(sql, existing, string.source_hash) : null,
    );
  }
  const { kind, value, checked } = planSuggestedValue(input, existing);
  const checks = checkValue(facts, string, language.tag, checked);
  if (errorsOf(checks).length > 0) throw qaFailed(string, language.tag, checks);

  const now = ctx.clock();
  bumpRevision(sql);
  if (author.type === "user") {
    const older = sql.query<{ id: number; value: string | null }>(
      `SELECT id, value FROM suggestions WHERE string_id = ? AND language = ?
         AND status = 'pending' AND author_type = 'user' AND author_id = ?`,
      string.id,
      language.tag,
      author.id,
    );
    for (const row of older) {
      markSuperseded(ctx, row, string.id, language.tag, author, now, null);
    }
  }
  const [{ id }] = sql.query<{ id: number }>(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       status, author_type, author_id, author_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) RETURNING id`,
    string.id,
    language.tag,
    kind,
    value,
    string.source_hash,
    revision,
    author.type,
    author.id,
    author.label,
    now,
  );
  addHistory(sql, {
    stringId: string.id,
    language: language.tag,
    event: "suggestion_created",
    before: existing ? [existing.value, existing.colour] : null,
    after: value === null ? null : [value, null],
    actor: author,
    detail: { suggestionId: id, kind },
    at: now,
  });
  return suggestionInfo(ctx, id);
}

function planSuggestedValue(input: SuggestInput, existing: TranslationRow | undefined) {
  let kind: SuggestionKind = input.kind;
  let value: string | null = null;
  if (kind === "approval") {
    if (input.value !== undefined) throw badRequest('"Looks good" takes no value.');
  } else {
    if (input.value === undefined) throw badRequest("A translation or a correction needs a value.");
    value = canonicalValue(input.value);
    kind = existing ? "correction" : "translation";
    if (existing?.value === value) {
      if (existing.colour === "blue") {
        throw badRequest("That is the approved translation already.");
      }
      kind = "approval";
      value = null;
    }
  }
  if (kind === "approval") {
    if (existing === undefined) throw badRequest("There is no translation to proofread yet.");
    if (existing.colour !== "green") {
      throw badRequest('Only a translation that isn\'t approved can get a "looks good".');
    }
  }
  const checked = kind === "approval" ? fromJson<TextValue>(existing!.value) : input.value!;
  return { kind, value, checked };
}

export async function suggestAsync(
  sql: Sql,
  actor: Actor,
  input: SuggestInput,
  now: number,
  model: string,
): Promise<SuggestionInfo> {
  const tag = canonicalTag(input.language);
  const authorId = actor.type === "user" ? actor.userId : null;
  const refs: Statement = {
    sql: `SELECT author_type AS actor_type, author_id AS actor_id FROM translations WHERE string_id = ? AND language = ?
      UNION ALL SELECT 'user', approver_id FROM translations WHERE string_id = ? AND language = ?
      UNION ALL SELECT 'user', ?
      UNION ALL SELECT 'user', created_by FROM glossary_terms`,
    params: [input.id, tag, input.id, tag, authorId],
  };
  return withRetries(
    sql,
    async () => {
      const [
        revision,
        strings,
        translations,
        older,
        ids,
        stored,
        languages,
        glossary,
        users,
        tokens,
        ...permissionRows
      ] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        {
          sql: "SELECT s.id, f.path, s.display_key, s.kind, s.source, s.source_hash, s.max_length, s.active * f.active AS active FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
          params: [input.id],
        },
        {
          sql: `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE string_id = ? AND language = ?`,
          params: [input.id, tag],
        },
        {
          sql: "SELECT id, value FROM suggestions WHERE string_id = ? AND language = ? AND status = 'pending' AND author_type = 'user' AND author_id = ?",
          params: [input.id, tag, authorId],
        },
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM suggestions" },
        { sql: "SELECT data FROM settings WHERE id = 1" },
        {
          sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
        },
        { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
        ...actorReadStatements(refs),
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          string: strings[0] as TargetString | undefined,
          existing: translations[0] as TranslationRow | undefined,
          older: older as { id: number; value: string | null }[],
          id: Number(ids[0].id),
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("suggest");
      const string = state.string;
      if (string === undefined || string.active !== 1) throw notFound(`String ${input.id}`);
      if (!isTranslatableKind(string.kind))
        throw badRequest(`${string.display_key} is copied from the English, not translated.`);
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(state.languages.map(toLanguage).map((entry) => [entry.tag, entry])),
        glossary: state.glossary.map((entry) => glossaryTermFromRow(entry, actors)),
      };
      const language = facts.languages.get(tag);
      if (language === undefined)
        throw badRequest(`The project has no language ${input.language}.`);
      state.permissions.require("suggest", language.tag);
      const author: Author =
        actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
      const existing = state.existing;
      const revision = existing?.revision ?? 0;
      if (input.baseRevision !== revision)
        throw conflict(
          `The translation of ${string.display_key} (${language.tag}) changed meanwhile.`,
          existing ? translationInfo(existing, string.source_hash, actors) : null,
        );
      const { kind, value, checked } = planSuggestedValue(input, existing);
      const checks = checkValue(facts, string, language.tag, checked);
      if (errorsOf(checks).length > 0) throw qaFailed(string, language.tag, checks);
      const row: SuggestionRow = {
        id: state.id,
        string_id: string.id,
        language: language.tag,
        kind,
        value,
        source_hash: string.source_hash,
        base_revision: revision,
        status: "pending",
        author_type: author.type,
        author_id: author.id,
        author_label: author.label,
        reviewer_id: null,
        comment: null,
        created_at: now,
        reviewed_at: null,
      };
      return {
        statements: [
          ...state.older.flatMap((older) =>
            planSuperseded(older, string.id, language.tag, author, now, null),
          ),
          {
            sql: "INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, author_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
            params: [
              row.id,
              string.id,
              language.tag,
              kind,
              value,
              string.source_hash,
              revision,
              author.type,
              author.id,
              author.label,
              now,
            ],
          },
          {
            sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: historyParams({
              stringId: string.id,
              language: language.tag,
              event: "suggestion_created",
              before: existing ? [existing.value, existing.colour] : null,
              after: value === null ? null : [value, null],
              actor: author,
              detail: { suggestionId: row.id, kind },
              at: now,
            }),
          },
        ],
        result: describeSuggestion(row, { string, current: existing ?? null, facts, actors }),
      };
    },
  );
}

function canonicalTag(tag: string): string {
  return canonicalLanguageTag(tag) ?? tag;
}

function markSuperseded(
  ctx: Context,
  row: { id: number; value: string | null },
  stringId: number,
  language: string,
  actor: Author,
  now: number,
  by: number | null,
): void {
  for (const statement of planSuperseded(row, stringId, language, actor, now, by))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function planSuperseded(
  row: { id: number; value: string | null },
  stringId: number,
  language: string,
  actor: Author,
  now: number,
  by: number | null,
): Statement[] {
  return [
    {
      sql: "UPDATE suggestions SET status = 'superseded', reviewed_at = ? WHERE id = ?",
      params: [now, row.id],
    },
    {
      sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: historyParams({
        stringId,
        language,
        event: "suggestion_superseded",
        before: row.value === null ? null : [row.value, null],
        after: null,
        actor,
        detail: by === null ? { suggestionId: row.id } : { suggestionId: row.id, supersededBy: by },
        at: now,
      }),
    },
  ];
}

/** Withdraws one's own pending suggestion. */
export function withdrawSuggestion(ctx: Context, actor: Actor, id: number): SuggestionInfo {
  const [row] = ctx.sql.query<SuggestionRow>(
    `SELECT ${SUGGESTION_COLUMNS} FROM suggestions g WHERE g.id = ?`,
    id,
  );
  if (row === undefined) throw notFound(`Suggestion ${id}`);
  const author = authorFor(ctx, actor);
  if (actor.type !== "system" && (row.author_type !== author.type || row.author_id !== author.id)) {
    throw forbidden("Only its author can withdraw a suggestion.");
  }
  if (row.status !== "pending") throw badRequest(`This suggestion is ${row.status} already.`);
  withdraw(ctx, row, author, ctx.clock());
  return suggestionInfo(ctx, id);
}

export async function withdrawSuggestionAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
  model: string,
): Promise<SuggestionInfo> {
  const selected: Statement = {
    sql: `SELECT ${LISTED_COLUMNS} FROM ${LISTED_FROM} WHERE g.id = ?`,
    params: [id],
  };
  const refs: Statement = {
    sql: `WITH selected AS (${selected.sql})
      SELECT author_type AS actor_type, author_id AS actor_id FROM selected
      UNION ALL SELECT t_author_type, t_author_id FROM selected
      UNION ALL SELECT 'user', reviewer_id FROM selected
      UNION ALL SELECT 'user', t_approver_id FROM selected
      UNION ALL SELECT 'user', created_by FROM glossary_terms`,
    params: selected.params,
  };
  return withRetries(
    sql,
    async () => {
      const [revision, rows, stored, languages, glossary, users, tokens, ...permissionRows] =
        await sql.read([
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
          selected,
          { sql: "SELECT data FROM settings WHERE id = 1" },
          {
            sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
          },
          { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
          ...actorReadStatements(refs),
          ...permissionReadStatements(actor),
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          row: rows[0] as ListedRow | undefined,
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("account");
      const row = state.row;
      if (row === undefined) throw notFound(`Suggestion ${id}`);
      const author: Author =
        actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
      const owns = row.author_type === author.type && row.author_id === author.id;
      if (actor.type !== "system" && !owns)
        throw forbidden("Only its author can withdraw a suggestion.");
      if (row.status !== "pending") throw badRequest(`This suggestion is ${row.status} already.`);
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(state.languages.map(toLanguage).map((entry) => [entry.tag, entry])),
        glossary: state.glossary.map((entry) => glossaryTermFromRow(entry, actors)),
      };
      return {
        statements: planSuggestionWithdrawal(row, author, now),
        result: describeRows([{ ...row, status: "withdrawn", reviewed_at: now }], facts, actors)[0],
      };
    },
  );
}

function withdraw(ctx: Context, row: SuggestionRow, actor: Author, now: number): void {
  bumpRevision(ctx.sql);
  for (const statement of planSuggestionWithdrawal(row, actor, now))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export type WithdrawalRow = Pick<SuggestionRow, "id" | "string_id" | "language" | "value">;

export function planSuggestionWithdrawal(
  row: WithdrawalRow,
  actor: Author,
  now: number,
): Statement[] {
  return [
    {
      sql: "UPDATE suggestions SET status = 'withdrawn', reviewed_at = ? WHERE id = ?",
      params: [now, row.id],
    },
    {
      sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: historyParams({
        stringId: row.string_id,
        language: row.language,
        event: "suggestion_withdrawn",
        before: row.value === null ? null : [row.value, null],
        after: null,
        actor,
        detail: { suggestionId: row.id },
        at: now,
      }),
    },
  ];
}

/** Withdraws every pending suggestion of a person (when they delete their account). */
export function withdrawPendingOf(ctx: Context, userId: number): number {
  const rows = ctx.sql.query<SuggestionRow>(
    `SELECT ${SUGGESTION_COLUMNS} FROM suggestions g
     WHERE g.author_type = 'user' AND g.author_id = ? AND g.status = 'pending'`,
    userId,
  );
  const now = ctx.clock();
  const actor: Author = { type: "user", id: userId, label: null };
  for (const row of rows) withdraw(ctx, row, actor, now);
  return rows.length;
}

// ---------------------------------------------------------------------------------------
// Listing

/**
 * `GET /suggestions`: reviewers (managers and administrators) see everyone's; others only
 * their own (`author` "me", which is also their default). Pending ones come oldest first,
 * as a queue; the others newest first. The cursor is an offset.
 */
export function listSuggestions(
  ctx: Context,
  actor: Actor,
  query: SuggestionsQuery,
): SuggestionsPage {
  const { count, page, offset } = suggestionSelection(actor, query, can(ctx, actor, "review"));
  const total = ctx.sql.query<{ n: number }>(count.sql, ...(count.params ?? []))[0].n;
  const rows = ctx.sql.query<ListedRow>(page.sql, ...(page.params ?? []));
  return suggestionsPage(describe(ctx, rows), total, offset);
}

/** Visibility is planned first; matching revisions keep permissions and the queue consistent. */
export async function listSuggestionsAsync(
  sql: Sql,
  actor: Actor,
  query: SuggestionsQuery,
  model: string,
): Promise<SuggestionsPage> {
  const revision: Statement = {
    sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [preparedRevision, ...permissionRows] = await sql.read([
      revision,
      ...permissionReadStatements(actor),
    ]);
    const permissions = permissionsFromRows(actor, permissionRows);
    const { count, page, offset } = suggestionSelection(actor, query, permissions.can("review"));
    const refs: Statement = {
      sql: `WITH page AS (${page.sql})
        SELECT author_type AS actor_type, author_id AS actor_id FROM page
        UNION ALL SELECT t_author_type, t_author_id FROM page
        UNION ALL SELECT 'user', reviewer_id FROM page
        UNION ALL SELECT 'user', t_approver_id FROM page
        UNION ALL SELECT 'user', created_by FROM glossary_terms`,
      params: page.params,
    };
    const [currentRevision, totals, rows, stored, languages, glossary, users, tokens] =
      await sql.read([
        revision,
        count,
        page,
        { sql: "SELECT data FROM settings WHERE id = 1" },
        {
          sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
        },
        { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
        ...actorReadStatements(refs),
      ]);
    if (currentRevision[0].revision !== preparedRevision[0].revision) continue;
    const actors = new ActorDirectory({
      users: users as ActorRows["users"],
      tokens: tokens as ActorRows["tokens"],
    });
    const settings = settingsFromData((stored[0]?.data as string | undefined) ?? null, model);
    const facts: Facts = {
      sourceLanguage: settings.sourceLanguage,
      syntax: settings.syntax,
      languages: new Map(
        (languages as LanguageRow[]).map(toLanguage).map((entry) => [entry.tag, entry]),
      ),
      glossary: (glossary as GlossaryRow[]).map((entry) => glossaryTermFromRow(entry, actors)),
    };
    return suggestionsPage(
      describeRows(rows as ListedRow[], facts, actors),
      totals[0].n as number,
      offset,
    );
  }
  throw new ServiceError(
    "unavailable",
    "The project kept changing while reading suggestions. Try again.",
  );
}

function suggestionSelection(
  actor: Actor,
  query: SuggestionsQuery,
  reviewer: boolean,
): {
  count: Statement;
  page: Statement;
  offset: number;
} {
  const self = actor.type === "user" ? actor.userId : null;
  let authorId: number | null = null;
  if (query.author === "me") {
    if (self === null) throw badRequest("Only a signed-in person has suggestions of their own.");
    authorId = self;
  } else if (query.author !== undefined) {
    if (!/^\d{1,15}$/.test(query.author)) throw badRequest('author is a user ID, or "me".');
    authorId = Number(query.author);
  }
  if (!reviewer) {
    if (self === null) throw forbidden();
    if (authorId !== null && authorId !== self) throw forbidden("You can only list your own.");
    authorId = self;
  }
  const status = query.status ?? "pending";
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (status !== "all") {
    where.push("g.status = ?");
    params.push(status);
  }
  // The review queue: strings, files and languages the project has now (a removed
  // language's suggestions stay in the database, and come back with it).
  if (status === "pending") {
    where.push("s.active = 1", "f.active = 1", "g.language IN (SELECT tag FROM languages)");
  }
  if (authorId !== null) {
    where.push("g.author_type = 'user' AND g.author_id = ?");
    params.push(authorId);
  }
  if (query.language !== undefined) {
    where.push("g.language = ?");
    params.push(canonicalTag(query.language));
  }
  if (query.kind !== undefined) {
    where.push("g.kind = ?");
    params.push(query.kind);
  }
  if (query.file !== undefined) {
    if (query.file.endsWith("/")) {
      where.push("substr(f.path, 1, length(?)) = ?");
      params.push(query.file, query.file);
    } else {
      where.push("f.path = ?");
      params.push(query.file);
    }
  }
  const condition = where.length > 0 ? where.join(" AND ") : "1";
  const offset = parseCursor(query.cursor);
  const limit = query.limit ?? DEFAULT_SUGGESTIONS_LIMIT;
  return {
    count: { sql: `SELECT COUNT(*) AS n FROM ${LISTED_FROM} WHERE ${condition}`, params },
    page: {
      sql: `SELECT ${LISTED_COLUMNS} FROM ${LISTED_FROM} WHERE ${condition}
        ORDER BY g.id ${status === "pending" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`,
      params: [...params, limit, offset],
    },
    offset,
  };
}

function suggestionsPage(
  suggestions: SuggestionInfo[],
  total: number,
  offset: number,
): SuggestionsPage {
  return {
    suggestions,
    nextCursor: offset + suggestions.length < total ? String(offset + suggestions.length) : null,
    total,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d{1,9}$/.test(cursor)) throw badRequest("The cursor is invalid.");
  return Number(cursor);
}

// ---------------------------------------------------------------------------------------
// Review

/**
 * Approves or rejects suggestions (WEB-4), each on its own: one that can't be approved (its
 * checks fail against the current English, it is no longer pending, its language isn't
 * the reviewer's, the translation changed since in a way approving would lose) goes to
 * `failed`, and the rest proceed. One activity row for the call.
 */
export function reviewSuggestions(
  ctx: Context,
  actor: Actor,
  request: ReviewRequest,
): ReviewResult {
  const reviewer = authorFor(ctx, actor);
  const reviewerId = actor.type === "user" ? actor.userId : null;
  const comment = request.comment?.trim() || null;
  const facts = loadFacts(ctx);
  const result: ReviewResult = { approved: [], rejected: [], failed: [] };
  const languages = new Set<string>();
  for (const id of new Set(request.ids)) {
    const row = loadListed(ctx, id);
    if (row === undefined) {
      result.failed.push({ id, code: "not_found", message: `Suggestion ${id} was not found.` });
      continue;
    }
    if (!can(ctx, actor, "review", row.language)) {
      result.failed.push({
        id,
        code: "forbidden",
        message: `You can't review suggestions in ${row.language}.`,
      });
      continue;
    }
    if (row.status !== "pending") {
      result.failed.push({ id, code: "conflict", message: `This suggestion is ${row.status}.` });
      continue;
    }
    if (request.action === "reject") {
      reject(ctx, row, reviewer, reviewerId, comment);
      result.rejected.push(id);
      languages.add(row.language);
      continue;
    }
    try {
      // A savepoint: a suggestion that fails leaves no trace, and the others go on.
      const checks = transaction(ctx.sql, () =>
        approve(ctx, row, reviewer, reviewerId, comment, facts),
      );
      if (checks !== null) {
        result.failed.push({
          id,
          code: "qa_failed",
          message: errorsOf(checks)[0]?.message ?? "The suggestion fails the checks.",
          checks,
        });
        continue;
      }
      result.approved.push(id);
      languages.add(row.language);
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      result.failed.push({ id, code: error.code, message: error.message });
    }
  }
  if (result.approved.length + result.rejected.length > 0) {
    const statement = reviewActivity(result, languages, reviewer, comment, ctx.clock());
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
  }
  return result;
}

export async function reviewSuggestionsAsync(
  sql: Sql,
  actor: Actor,
  request: ReviewRequest,
  now: number,
  model: string,
): Promise<ReviewResult> {
  const ids = [...new Set(request.ids)];
  // JSON parameters keep a 1,000-item review below D1's bind-parameter limit.
  const selected = "SELECT CAST(value AS INTEGER) FROM json_each(?)";
  const page: Statement = {
    sql: `SELECT ${LISTED_COLUMNS}, s.active * f.active AS active FROM ${LISTED_FROM}
      WHERE EXISTS (SELECT 1 FROM suggestions chosen WHERE chosen.id IN (${selected})
        AND chosen.string_id = g.string_id AND chosen.language = g.language)
      AND (g.status = 'pending' OR g.id IN (${selected}))`,
    params: [toJson(ids), toJson(ids)],
  };
  const refs: Statement = {
    sql: `WITH page AS (${page.sql})
      SELECT t_author_type AS actor_type, t_author_id AS actor_id FROM page
      UNION ALL SELECT 'user', t_approver_id FROM page
      UNION ALL SELECT 'user', created_by FROM glossary_terms`,
    params: page.params,
  };
  const reviewer: Author =
    actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
  const reviewerId = actor.type === "user" ? actor.userId : null;
  const comment = request.comment?.trim() || null;
  return withRetries(
    sql,
    async () => {
      const [revision, rows, stored, languages, glossary, users, tokens, ...permissionRows] =
        await sql.read([
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
          page,
          { sql: "SELECT data FROM settings WHERE id = 1" },
          {
            sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
          },
          { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
          ...actorReadStatements(refs),
          ...permissionReadStatements(actor),
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          revision: Number(revision[0].revision),
          rows: rows as (ListedRow & { active: number })[],
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("review");
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(
          state.languages.map(toLanguage).map((language) => [language.tag, language]),
        ),
        glossary: state.glossary.map((row) => glossaryTermFromRow(row, actors)),
      };
      const rows = new Map(state.rows.map((row) => [row.id, { ...row }]));
      const result: ReviewResult = { approved: [], rejected: [], failed: [] };
      const statements: Statement[] = [];
      const languages = new Set<string>();
      for (const id of ids) {
        const row = rows.get(id);
        if (row === undefined) {
          result.failed.push({ id, code: "not_found", message: `Suggestion ${id} was not found.` });
          continue;
        }
        if (!state.permissions.can("review", row.language)) {
          result.failed.push({
            id,
            code: "forbidden",
            message: `You can't review suggestions in ${row.language}.`,
          });
          continue;
        }
        if (row.status !== "pending") {
          result.failed.push({
            id,
            code: "conflict",
            message: `This suggestion is ${row.status}.`,
          });
          continue;
        }
        if (request.action === "reject") {
          statements.push(...planSuggestionRejection(row, reviewer, reviewerId, comment, now));
          row.status = "rejected";
          result.rejected.push(id);
          languages.add(row.language);
          continue;
        }
        try {
          const { input, checks } = suggestionApproval(
            row,
            reviewer,
            reviewerId,
            comment,
            facts,
            actors,
          );
          if (errorsOf(checks).length > 0) {
            result.failed.push({
              id,
              code: "qa_failed",
              message: errorsOf(checks)[0]?.message ?? "The suggestion fails the checks.",
              checks,
            });
            continue;
          }
          const plan = planTranslationWrite(input, {
            string: {
              id: row.string_id,
              path: row.path,
              display_key: row.display_key,
              kind: row.string_kind,
              source: row.source,
              source_hash: row.string_hash,
              max_length: row.max_length,
              active: row.active,
            },
            existing: translationOf(row) ?? undefined,
            facts,
            actors,
            revision: state.revision + 1,
            now,
          });
          statements.push(...plan.statements, {
            sql: "UPDATE suggestions SET status = 'approved', reviewer_id = ?, comment = ?, reviewed_at = ? WHERE id = ?",
            params: [reviewerId, comment, now, id],
          });
          row.status = "approved";
          for (const other of rows.values()) {
            const sameTarget = other.string_id === row.string_id && other.language === row.language;
            if (!sameTarget || other.status !== "pending") continue;
            statements.push(
              ...planSuperseded(other, row.string_id, row.language, reviewer, now, id),
              {
                sql: "UPDATE suggestions SET reviewer_id = ? WHERE id = ?",
                params: [reviewerId, other.id],
              },
            );
            other.status = "superseded";
          }
          result.approved.push(id);
          languages.add(row.language);
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          result.failed.push({ id, code: error.code, message: error.message });
        }
      }
      if (result.approved.length + result.rejected.length > 0)
        statements.push(reviewActivity(result, languages, reviewer, comment, now));
      return { statements, result };
    },
  );
}

function reviewActivity(
  result: ReviewResult,
  languages: Set<string>,
  reviewer: Author,
  comment: string | null,
  now: number,
): Statement {
  const parts = [];
  if (result.approved.length > 0) parts.push(`${result.approved.length} approved`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} rejected`);
  const tags = [...languages].sort();
  return {
    sql: "INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES ('review', ?, ?, ?, ?, ?, ?)",
    params: [
      reviewer.type,
      reviewer.id,
      reviewer.label,
      `Review (${tags.join(", ")}): ${parts.join(", ")}`,
      toJson({
        kind: "suggestions",
        approved: result.approved,
        rejected: result.rejected,
        failed: result.failed.length,
        languages: tags,
        comment,
      }),
      now,
    ],
  };
}

function planSuggestionRejection(
  row: SuggestionRow,
  reviewer: Author,
  reviewerId: number | null,
  comment: string | null,
  now: number,
): Statement[] {
  return [
    {
      sql: "UPDATE suggestions SET status = 'rejected', reviewer_id = ?, comment = ?, reviewed_at = ? WHERE id = ?",
      params: [reviewerId, comment, now, row.id],
    },
    {
      sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: historyParams({
        stringId: row.string_id,
        language: row.language,
        event: "suggestion_rejected",
        before: row.value === null ? null : [row.value, null],
        after: null,
        actor: reviewer,
        detail: comment === null ? { suggestionId: row.id } : { suggestionId: row.id, comment },
        at: now,
      }),
    },
  ];
}

function reject(
  ctx: Context,
  row: ListedRow,
  reviewer: Author,
  reviewerId: number | null,
  comment: string | null,
): void {
  bumpRevision(ctx.sql);
  for (const statement of planSuggestionRejection(row, reviewer, reviewerId, comment, ctx.clock()))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

/**
 * Whether approving a pending suggestion would lose a change made after it was sent
 * (design §5.8: a change based on an older revision fails with 409): the translation
 * changed since, and it is now a person's approved (blue) text, or the suggestion vouches
 * for ("looks good") or updates (the LLM's proposal, LLM-4) the exact text it saw. A
 * person's translation or correction may still replace a newer green, or deleted, one: that
 * is what approving it means.
 */
function isStale(
  kind: SuggestionKind,
  baseRevision: number,
  current: Pick<TranslationRow, "revision" | "colour"> | null | undefined,
): boolean {
  if (baseRevision === (current?.revision ?? 0)) return false;
  return kind === "approval" || kind === "llm" || current?.colour === "blue";
}

/**
 * After a person's direct edit of a translation (`edits.ts`): the pending suggestions for
 * it that can no longer be approved (`isStale`) are superseded, so they leave the review
 * queue and their authors see why.
 */
export function supersedeStale(
  ctx: Context,
  stringId: number,
  language: string,
  actor: Author,
): void {
  const current = loadTranslation(ctx.sql, stringId, language);
  const rows = ctx.sql.query<{
    id: number;
    kind: SuggestionKind;
    value: string | null;
    base_revision: number;
  }>(
    `SELECT id, kind, value, base_revision FROM suggestions
     WHERE string_id = ? AND language = ? AND status = 'pending'`,
    stringId,
    language,
  );
  const now = ctx.clock();
  for (const statement of planStaleSuggestions(rows, current, stringId, language, actor, now))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export type PendingSuggestion = Pick<SuggestionRow, "id" | "kind" | "value" | "base_revision">;

export function planStaleSuggestions(
  rows: PendingSuggestion[],
  current: TranslationRow | null | undefined,
  stringId: number,
  language: string,
  actor: Author,
  now: number,
): Statement[] {
  return rows
    .filter((row) => isStale(row.kind, row.base_revision, current))
    .flatMap((row) => planSuperseded(row, stringId, language, actor, now, null));
}

/**
 * Approves one suggestion: writes it blue (the author's, approved by the reviewer) for the
 * English it was made for, and supersedes the other pending suggestions for the same string
 * and language. A suggestion the translation outgrew (`isStale`) fails with `conflict`.
 * Returns the checks, against the current English, when they fail (nothing is written),
 * else null.
 */
function approve(
  ctx: Context,
  row: ListedRow,
  reviewer: Author,
  reviewerId: number | null,
  comment: string | null,
  facts: Facts,
): CheckResult[] | null {
  const { sql } = ctx;
  const current = translationOf(row);
  const actors = new ActorDirectory(
    sql,
    current
      ? [{ type: current.author_type, id: current.author_id, label: current.author_label }]
      : [],
    [current?.approver_id ?? null],
  );
  const { input, checks } = suggestionApproval(row, reviewer, reviewerId, comment, facts, actors);
  if (errorsOf(checks).length > 0) return checks;
  writeTranslation(ctx, input, facts);
  const now = ctx.clock();
  sql.run(
    `UPDATE suggestions SET status = 'approved', reviewer_id = ?, comment = ?, reviewed_at = ?
     WHERE id = ?`,
    reviewerId,
    comment,
    now,
    row.id,
  );
  const others = sql.query<{ id: number; value: string | null }>(
    `SELECT id, value FROM suggestions
     WHERE string_id = ? AND language = ? AND status = 'pending' AND id <> ?`,
    row.string_id,
    row.language,
    row.id,
  );
  for (const other of others) {
    markSuperseded(ctx, other, row.string_id, row.language, reviewer, now, row.id);
    sql.run("UPDATE suggestions SET reviewer_id = ? WHERE id = ?", reviewerId, other.id);
  }
  return null;
}

function suggestionApproval(
  row: ListedRow,
  reviewer: Author,
  reviewerId: number | null,
  comment: string | null,
  facts: Facts,
  actors: ActorDirectory,
): { input: WriteTranslation; checks: CheckResult[] } {
  const author: Author = {
    type: row.author_type as Author["type"],
    id: row.author_id,
    label: row.author_label,
  };
  const current = translationOf(row);
  if (isStale(row.kind, row.base_revision, current)) {
    throw conflict(
      row.kind === "approval"
        ? 'The translation changed after this "looks good" was sent.'
        : "The translation changed after this suggestion was sent: reject it, or ask for a new one.",
      current ? translationInfo(current, row.string_hash, actors) : null,
    );
  }
  let value: TextValue;
  if (row.kind === "approval") {
    // "Looks good" vouches for the text the contributor saw, and nothing newer.
    value = fromJson<TextValue>(current!.value);
  } else {
    value = fromJson<TextValue>(row.value!);
  }
  if (!isTranslatableKind(row.string_kind)) throw notFound(`String ${row.string_id}`);
  const checks = checkValue(
    facts,
    { kind: row.string_kind, source: row.source, max_length: row.max_length },
    row.language,
    value,
  );
  const detail: Record<string, unknown> = {
    suggestionId: row.id,
    kind: row.kind,
    author: { type: author.type, id: author.id },
  };
  if (comment !== null) detail.comment = comment;
  return {
    input: {
      stringId: row.string_id,
      language: row.language,
      value,
      colour: "blue",
      actor: reviewer,
      author: row.kind === "approval" ? undefined : author,
      approverId: reviewerId,
      event: "suggestion_approved",
      detail,
      // Made for the English the author saw: approved after the English changed, it stays
      // outdated (STR-4).
      sourceHash: row.source_hash,
    },
    checks,
  };
}
