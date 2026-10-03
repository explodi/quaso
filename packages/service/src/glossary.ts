// SPDX-License-Identifier: MIT
/** Glossary storage and whole-term selection for the editor, checks and prompts. */
import {
  canonicalLanguageTag,
  type CreateGlossaryTermRequest,
  glossaryMatches,
  type GlossaryQuery,
  type GlossaryResult,
  type GlossaryTerm,
  type TextValue,
  type UpdateGlossaryTermRequest,
} from "@quaso/core";
import { ActorDirectory, type ActorRows } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, fromJson, normalizeSearch } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import {
  denied,
  languageLimit,
  requirePermission,
  permissionReadStatements,
  permissionsFromRows,
  type Permissions,
} from "./permissions.ts";
import { recomputeQa, planQa, type QaRow } from "./translations.ts";
import type { Sql, Statement } from "./ports.ts";
import { toLanguage, type LanguageRow } from "./languages.ts";
import { settingsFromData } from "./settings.ts";
import { withRetries } from "./write.ts";

export type GlossaryRow = {
  id: number;
  term: string;
  language: string | null;
  kind: "translate" | "keep";
  translation: string | null;
  case_sensitive: number;
  note: string;
  created_by: number | null;
  created_at: number;
  updated_at: number;
};

const GLOSSARY_SQL = `SELECT * FROM glossary_terms WHERE (? IS NULL OR language IS NULL OR language = ?)
  ORDER BY term_normalized, language, kind, id`;

export function listGlossary(ctx: Context, query: GlossaryQuery): GlossaryResult {
  let texts: string[] | undefined;
  if (query.stringId !== undefined) {
    const [row] = ctx.sql.query<{ source: string }>(
      "SELECT source FROM strings WHERE id = ? AND active = 1",
      query.stringId,
    );
    if (!row) throw notFound(`String ${query.stringId}`);
    const source = fromJson<TextValue>(row.source);
    texts = typeof source === "string" ? [source] : Object.values(source);
  }
  const tag = query.language ? canonicalLanguageTag(query.language) : null;
  const rows = ctx.sql.query<GlossaryRow>(GLOSSARY_SQL, tag, tag);
  const actors = new ActorDirectory(
    ctx.sql,
    [],
    rows.map((r) => r.created_by),
  );
  return glossaryResult(rows, actors, query.q, texts);
}

/** Terms, source matching and creator metadata use the same database snapshot. */
export async function listGlossaryAsync(sql: Sql, query: GlossaryQuery): Promise<GlossaryResult> {
  const tag = query.language ? canonicalLanguageTag(query.language) : null;
  const [sources, rows, users] = await sql.read([
    {
      sql: "SELECT source FROM strings WHERE id = ? AND active = 1",
      params: [query.stringId ?? null],
    },
    { sql: GLOSSARY_SQL, params: [tag, tag] },
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN (SELECT created_by FROM (${GLOSSARY_SQL}))`,
      params: [tag, tag],
    },
  ]);
  let texts: string[] | undefined;
  if (query.stringId !== undefined) {
    if (sources.length === 0) throw notFound(`String ${query.stringId}`);
    const source = fromJson<TextValue>(sources[0].source);
    texts = typeof source === "string" ? [source] : Object.values(source);
  }
  const actors = new ActorDirectory({ users: users as ActorRows["users"], tokens: [] });
  return glossaryResult(rows as GlossaryRow[], actors, query.q, texts);
}

function glossaryResult(
  rows: GlossaryRow[],
  actors: ActorDirectory,
  search?: string,
  texts?: string[],
): GlossaryResult {
  const q = normalizeSearch(search?.trim() ?? "");
  return {
    terms: rows
      .filter(
        (r) =>
          !texts ||
          texts.some((text) => glossaryMatches(text, r.term, r.case_sensitive === 1).length > 0),
      )
      .filter(
        (r) => !q || normalizeSearch(`${r.term}\n${r.translation ?? ""}\n${r.note}`).includes(q),
      )
      .map((r) => glossaryTermFromRow(r, actors)),
  };
}

export function glossaryTermFromRow(r: GlossaryRow, actors: ActorDirectory): GlossaryTerm {
  return {
    id: r.id,
    term: r.term,
    language: r.language,
    kind: r.kind,
    translation: r.translation,
    caseSensitive: r.case_sensitive === 1,
    note: r.note,
    createdBy: actors.user(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Selects only matching terms, optionally from an operation's already-loaded glossary. */
export function matchingGlossary(
  terms: GlossaryTerm[],
  language: string,
  texts: string[],
): GlossaryTerm[] {
  return terms.filter(
    (term) =>
      (term.language === null || term.language === language) &&
      texts.some((text) => glossaryMatches(text, term.term, term.caseSensitive).length > 0),
  );
}

export function glossaryFor(ctx: Context, language: string, texts: string[]): GlossaryTerm[] {
  return matchingGlossary(listGlossary(ctx, { language }).terms, language, texts);
}

export function createGlossaryTerm(
  ctx: Context,
  actor: Actor,
  request: CreateGlossaryTermRequest,
): GlossaryTerm {
  const entry = normalized(request);
  requireGlossary(ctx, actor, entry.language);
  unique(ctx, entry);
  const now = ctx.clock();
  const [row] = ctx.sql.query<{ id: number }>(
    `INSERT INTO glossary_terms (term, term_normalized, language, kind, translation, case_sensitive,
      note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    entry.term,
    normalizeSearch(entry.term),
    entry.language,
    entry.kind,
    entry.translation,
    entry.caseSensitive ? 1 : 0,
    entry.note,
    actor.type === "user" ? actor.userId : null,
    now,
    now,
  );
  changed(ctx);
  return get(ctx, row.id);
}

export function updateGlossaryTerm(
  ctx: Context,
  actor: Actor,
  id: number,
  request: UpdateGlossaryTermRequest,
): GlossaryTerm {
  const old = get(ctx, id);
  requireGlossary(ctx, actor, old.language);
  const entry = normalized({ ...old, ...request });
  requireGlossary(ctx, actor, entry.language);
  unique(ctx, entry, id);
  ctx.sql.run(
    `UPDATE glossary_terms SET term = ?, term_normalized = ?, language = ?, kind = ?,
    translation = ?, case_sensitive = ?, note = ?, updated_at = ? WHERE id = ?`,
    entry.term,
    normalizeSearch(entry.term),
    entry.language,
    entry.kind,
    entry.translation,
    entry.caseSensitive ? 1 : 0,
    entry.note,
    ctx.clock(),
    id,
  );
  changed(ctx);
  return get(ctx, id);
}

export function deleteGlossaryTerm(ctx: Context, actor: Actor, id: number): { ok: true } {
  const entry = get(ctx, id);
  requireGlossary(ctx, actor, entry.language);
  ctx.sql.run("DELETE FROM glossary_terms WHERE id = ?", id);
  changed(ctx);
  return { ok: true };
}

function get(ctx: Context, id: number): GlossaryTerm {
  const entry = listGlossary(ctx, {}).terms.find((term) => term.id === id);
  if (!entry) throw notFound(`Glossary term ${id}`);
  return entry;
}

async function readGlossaryForChange(sql: Sql, actor: Actor) {
  const [revision, terms, translations, settings, languages, users, ...permissionRows] =
    await sql.read([
      {
        sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
      },
      { sql: "SELECT * FROM glossary_terms ORDER BY id" },
      {
        sql: "SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source, s.max_length FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.kind IN ('text', 'plural', 'ordinal')",
      },
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
      {
        sql: "SELECT id, display_name, avatar_url FROM users WHERE id IN (SELECT created_by FROM glossary_terms UNION ALL SELECT ?)",
        params: [actor.type === "user" ? actor.userId : null],
      },
      ...permissionReadStatements(actor),
    ]);
  return {
    revision: Number(revision[0].revision),
    state: {
      terms: terms as GlossaryRow[],
      translations: translations as QaRow[],
      settings: (settings[0]?.data as string | undefined) ?? null,
      languages: (languages as LanguageRow[]).map(toLanguage),
      actors: new ActorDirectory({ users: users as ActorRows["users"], tokens: [] }),
      permissions: permissionsFromRows(actor, permissionRows),
    },
  };
}

type GlossaryState = Awaited<ReturnType<typeof readGlossaryForChange>>["state"];

function glossaryQa(state: GlossaryState, terms: GlossaryRow[], model: string): Statement[] {
  const settings = settingsFromData(state.settings, model);
  return planQa(state.translations, {
    sourceLanguage: settings.sourceLanguage,
    syntax: settings.syntax,
    languages: new Map(state.languages.map((language) => [language.tag, language])),
    glossary: terms.map((term) => ({ ...term, caseSensitive: term.case_sensitive === 1 })),
  });
}

function requireGlossarySnapshot(permissions: Permissions, language: string | null): void {
  permissions.require("glossary", language ?? undefined);
  if (language === null && permissions.languageLimit() !== null) throw denied(permissions.actor);
}

function uniqueGlossary(terms: GlossaryRow[], entry: ReturnType<typeof normalized>, id = 0): void {
  const duplicate = terms.some((term) => {
    const sameTerm = normalizeSearch(term.term) === normalizeSearch(entry.term);
    const sameScope = term.language === entry.language && term.kind === entry.kind;
    return term.id !== id && sameTerm && sameScope;
  });
  if (duplicate) throw conflict("That glossary term already exists for this language and kind.");
}

function glossaryRow(
  entry: ReturnType<typeof normalized>,
  id: number,
  creator: number | null,
  created: number,
  now: number,
): GlossaryRow {
  return {
    id,
    term: entry.term,
    language: entry.language,
    kind: entry.kind,
    translation: entry.translation,
    case_sensitive: entry.caseSensitive ? 1 : 0,
    note: entry.note,
    created_by: creator,
    created_at: created,
    updated_at: now,
  };
}

function glossaryParams(row: GlossaryRow) {
  return [
    row.term,
    normalizeSearch(row.term),
    row.language,
    row.kind,
    row.translation,
    row.case_sensitive,
    row.note,
  ];
}

export async function createGlossaryTermAsync(
  sql: Sql,
  actor: Actor,
  request: CreateGlossaryTermRequest,
  now: number,
  model: string,
): Promise<GlossaryTerm> {
  return withRetries(
    sql,
    () => readGlossaryForChange(sql, actor),
    (state) => {
      state.permissions.require("glossary");
      const entry = normalized(request);
      requireGlossarySnapshot(state.permissions, entry.language);
      uniqueGlossary(state.terms, entry);
      const id = (state.terms.at(-1)?.id ?? 0) + 1;
      const row = glossaryRow(entry, id, actor.type === "user" ? actor.userId : null, now, now);
      return {
        statements: [
          {
            sql: "INSERT INTO glossary_terms (term, term_normalized, language, kind, translation, case_sensitive, note, id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: [...glossaryParams(row), id, row.created_by, now, now],
          },
          ...glossaryQa(state, [...state.terms, row], model),
        ],
        result: glossaryTermFromRow(row, state.actors),
      };
    },
  );
}

export async function updateGlossaryTermAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  request: UpdateGlossaryTermRequest,
  now: number,
  model: string,
): Promise<GlossaryTerm> {
  return withRetries(
    sql,
    () => readGlossaryForChange(sql, actor),
    (state) => {
      state.permissions.require("glossary");
      const old = state.terms.find((term) => term.id === id);
      if (!old) throw notFound(`Glossary term ${id}`);
      requireGlossarySnapshot(state.permissions, old.language);
      const entry = normalized({ ...glossaryTermFromRow(old, state.actors), ...request });
      requireGlossarySnapshot(state.permissions, entry.language);
      uniqueGlossary(state.terms, entry, id);
      const row = glossaryRow(entry, id, old.created_by, old.created_at, now);
      return {
        statements: [
          {
            sql: "UPDATE glossary_terms SET term = ?, term_normalized = ?, language = ?, kind = ?, translation = ?, case_sensitive = ?, note = ?, updated_at = ? WHERE id = ?",
            params: [...glossaryParams(row), now, id],
          },
          ...glossaryQa(
            state,
            state.terms.map((term) => (term.id === id ? row : term)),
            model,
          ),
        ],
        result: glossaryTermFromRow(row, state.actors),
      };
    },
  );
}

export async function deleteGlossaryTermAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  model: string,
): Promise<{ ok: true }> {
  return withRetries(
    sql,
    () => readGlossaryForChange(sql, actor),
    (state) => {
      state.permissions.require("glossary");
      const old = state.terms.find((term) => term.id === id);
      if (!old) throw notFound(`Glossary term ${id}`);
      requireGlossarySnapshot(state.permissions, old.language);
      return {
        statements: [
          { sql: "DELETE FROM glossary_terms WHERE id = ?", params: [id] },
          ...glossaryQa(
            state,
            state.terms.filter((term) => term.id !== id),
            model,
          ),
        ],
        result: { ok: true as const },
      };
    },
  );
}

function normalized(request: CreateGlossaryTermRequest) {
  const term = request.term.trim().normalize("NFC");
  if (!term) throw badRequest("A glossary term cannot be blank.");
  const translation =
    request.kind === "keep" ? null : (request.translation?.trim().normalize("NFC") ?? null);
  if (request.kind === "translate" && !translation) {
    throw badRequest("A translated term needs a translation.");
  }
  return {
    term,
    language: request.language ? canonicalLanguageTag(request.language)! : null,
    kind: request.kind,
    translation,
    caseSensitive: request.caseSensitive ?? false,
    note: request.note?.trim() ?? "",
  };
}

function unique(ctx: Context, entry: ReturnType<typeof normalized>, id = 0): void {
  if (
    ctx.sql.query(
      `SELECT 1 FROM glossary_terms WHERE term_normalized = ? AND language IS ? AND kind = ? AND id <> ?`,
      normalizeSearch(entry.term),
      entry.language,
      entry.kind,
      id,
    ).length
  ) {
    throw conflict("That glossary term already exists for this language and kind.");
  }
}

/** Glossary changes immediately update stored warning counts too. */
function changed(ctx: Context): void {
  const ids = ctx.sql.query<{ string_id: number }>("SELECT DISTINCT string_id FROM translations");
  recomputeQa(
    ctx,
    ids.map((r) => r.string_id),
  );
  bumpRevision(ctx.sql);
}

function requireGlossary(ctx: Context, actor: Actor, language: string | null): void {
  requirePermission(ctx, actor, "glossary", language ?? undefined);
  if (language === null && languageLimit(ctx, actor) !== null) throw denied(actor);
}
