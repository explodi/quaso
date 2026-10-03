// SPDX-License-Identifier: MIT
/**
 * Renaming keys (STR-6, design §5.5): the translations, suggestions and history of a string
 * the English no longer has move to a string it has, in the same file and of the same
 * kind. Uploads do it with `quaso upload --rename old=new`; administrators do it on the
 * website (`POST /renames`, S10.1) after an upload suggested it. Both use the code here.
 * Translations only the LLM wrote on the new key give way to the old key's.
 */
import type { RenameRequest, RenameResult } from "@quaso/core";
import {
  ActorDirectory,
  actorReadStatements,
  type ActorRows,
  SYSTEM_AUTHOR,
  type Author,
  authorFor,
} from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, fromJsonOrNull, getRevision, toJson } from "./db.ts";
import { TRANSLATABLE_SQL } from "./entries.ts";
import { badRequest } from "./errors.ts";
import { type KeyedString, matchesKey, parseKeySelector, selectorCondition } from "./keys.ts";
import type { Sql, Statement } from "./ports.ts";
import {
  addHistory,
  historyParams,
  type HistoryRecord,
  recomputeQa,
  planQa,
  type TranslationRow,
} from "./translations.ts";

import { withRetries } from "./write.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { settingsFromData } from "./settings.ts";
import { type Facts } from "./facts.ts";
import { type LanguageRow, toLanguage } from "./languages.ts";
import { type GlossaryRow, glossaryTermFromRow } from "./glossary.ts";

/** How to name one of several strings with the same key, for error messages and warnings. */
export const AMBIGUOUS_HINT =
  'add #text, #plural or #ordinal to the key, or write its key path as a JSON array, such as ["a.b", "c"]';

/** One end of a rename. */
export type RenameEnd = KeyedString & { id: number; path: string; active: number };

/** What a rename names: the file (optional for uploads) and the two keys. */
export interface RenameNames {
  file?: string;
  from: string;
  to: string;
}

/**
 * The two strings of a rename: `from` among the strings the English no longer has, `to`
 * among those it has, in the same file and of the same kind. `when` ends the message for a
 * missing `to`, such as " after the upload".
 */
export function resolveRename(
  ctx: Context,
  rename: RenameNames,
  when = "",
): { from: RenameEnd; to: RenameEnd } {
  const candidates = [
    ...stringsNamed(ctx, rename.from, rename.file),
    ...stringsNamed(ctx, rename.to, rename.file),
  ];
  const rows = new Map(candidates.map((row) => [row.id, row]));
  return resolveRenameRows([...rows.values()], rename, when);
}

/** Resolves a rename against a snapshot of translatable strings in active files. */
export function resolveRenameRows(
  rows: RenameEnd[],
  rename: RenameNames,
  when = "",
): { from: RenameEnd; to: RenameEnd } {
  const namedRows = (key: string, file: string | undefined) => {
    const selector = parseKeySelector(key);
    return rows.filter((row) => {
      const inFile = file === undefined || row.path === file;
      return inFile && matchesKey(selector, row);
    });
  };
  const where = rename.file === undefined ? "" : ` in ${rename.file}`;
  const named = namedRows(rename.from, rename.file);
  if (named.length === 0) {
    throw badRequest(`Can't rename: there is no key ${rename.from}${where}.`, [
      { file: rename.file, key: rename.from },
    ]);
  }
  const hidden = named.filter((row) => row.active === 0);
  if (hidden.length === 0) {
    throw badRequest(
      `Can't rename ${rename.from}${where}: the English still has it. A rename moves the translations of a key the English no longer has.`,
      [{ file: named[0].path, key: rename.from }],
    );
  }
  const files = [...new Set(hidden.map((row) => row.path))].sort();
  if (files.length > 1) {
    throw badRequest(
      `Can't rename: the key ${rename.from} is in several files (${files.join(
        ", ",
      )}); name the file.`,
      [{ key: rename.from }],
    );
  }
  const path = files[0];
  const targets = namedRows(rename.to, path).filter((row) => row.active === 1);
  if (targets.length === 0) {
    throw badRequest(`Can't rename: there is no key ${rename.to} in ${path}${when}.`, [
      { file: path, key: rename.to },
    ]);
  }
  const pairs = hidden.flatMap((from) =>
    targets.filter((to) => to.kind === from.kind).map((to) => ({ from, to })),
  );
  if (pairs.length === 1) return pairs[0];
  if (pairs.length === 0) {
    throw badRequest(
      `${rename.from} is a ${hidden[0].kind} string but ${rename.to} is a ${
        targets[0].kind
      } string.`,
      [{ file: path, key: rename.to }],
    );
  }
  const ambiguous = pairs.length > hidden.length ? rename.to : rename.from;
  throw badRequest(
    `Can't rename: several strings have the key ${ambiguous} in ${path}; ${AMBIGUOUS_HINT}.`,
    [{ file: path, key: ambiguous }],
  );
}

/** The translatable strings in active files that a rename's key names. */
function stringsNamed(ctx: Context, key: string, file: string | undefined): RenameEnd[] {
  const selector = parseKeySelector(key);
  const condition = selectorCondition(selector);
  return ctx.sql
    .query<RenameEnd>(
      `SELECT s.id, f.path, s.display_key, s.key_path, s.kind, s.active
     FROM strings s JOIN files f ON f.id = s.file_id
     WHERE f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL}) AND ${condition.sql}
       ${file === undefined ? "" : "AND f.path = ?"}
     ORDER BY f.path, s.position`,
      ...condition.params,
      ...(file === undefined ? [] : [file]),
    )
    .filter((row) => matchesKey(selector, row));
}

/**
 * Whether `to` already took `from`'s translations in an earlier rename, and `from` has
 * none left: the rename was made, and asking for it again changes nothing.
 */
export function alreadyRenamed(ctx: Context, fromId: number, toId: number): boolean {
  const { sql } = ctx;
  const left = sql.query(
    `SELECT 1 AS found FROM translations WHERE string_id = ?
     UNION ALL SELECT 1 AS found FROM suggestions WHERE string_id = ? LIMIT 1`,
    fromId,
    fromId,
  );
  if (left.length > 0) return false;
  return sql
    .query<{
      detail: string | null;
    }>("SELECT detail FROM history WHERE string_id = ? AND event = 'source_renamed'", toId)
    .some((row) => fromJsonOrNull<{ fromStringId?: number }>(row.detail)?.fromStringId === fromId);
}

/** A translation of the new key in a language the old key has one in too. */
export type RenameClash = {
  language: string;
  value: string;
  colour: string;
  author_type: string;
  /** History rows of the pair that aren't the LLM's: a person saved, reviewed or suggested. */
  people: number;
};

/**
 * Moves the translations, suggestions and history of `from` to `to`. Where both have a
 * translation in a language, `to`'s must be one only the LLM wrote (green, and no person
 * in its history): the automatic job of the upload that added `to` translates it before
 * an administrator can accept the rename the upload suggested, and the old key's
 * translation replaces it (recorded as `translation_deleted`). One a person made or
 * reviewed is never replaced: the rename is refused. Returns the `source_renamed` history
 * record for the caller to write (an upload writes its history in bulk, with its ID).
 */
export function moveRename(
  ctx: Context,
  ends: { from: RenameEnd; to: RenameEnd },
  rename: RenameNames,
  author: Author,
  at: number,
): HistoryRecord {
  const { sql } = ctx;
  const { from, to } = ends;
  const clashes = sql.query<RenameClash>(
    `SELECT t.language, t.value, t.colour, t.author_type,
       (SELECT COUNT(*) FROM history h
        WHERE h.string_id = t.string_id AND h.language = t.language AND h.actor_type <> 'llm')
         AS people
     FROM translations t
     WHERE t.string_id = ?
       AND t.language IN (SELECT language FROM translations WHERE string_id = ?)
     ORDER BY t.language`,
    to.id,
    from.id,
  );
  const plan = planRenameMove(ends, rename, author, at, clashes);
  for (const statement of plan.statements) sql.run(statement.sql, ...(statement.params ?? []));
  return plan.history;
}

/** Computes the complete rename write set, refusing to replace a person's work. */
export function planRenameMove(
  ends: { from: RenameEnd; to: RenameEnd },
  rename: RenameNames,
  author: Author,
  at: number,
  clashes: RenameClash[],
): { statements: Statement[]; history: HistoryRecord } {
  const { from, to } = ends;
  const statements: Statement[] = [];
  const kept = clashes.filter(
    (row) => row.author_type !== "llm" || row.colour !== "green" || row.people > 0,
  );
  if (kept.length > 0) {
    const languages = kept.map((row) => row.language).join(", ");
    throw badRequest(
      `${rename.to} already has translations a person made or reviewed (${languages}), so it can't take ${rename.from}'s.`,
      kept.map((row) => ({ file: from.path, key: rename.to, language: row.language })),
    );
  }
  for (const row of clashes) {
    statements.push({
      sql: "DELETE FROM translations WHERE string_id = ? AND language = ?",
      params: [to.id, row.language],
    });
    const deleted: HistoryRecord = {
      stringId: to.id,
      language: row.language,
      event: "translation_deleted",
      before: [row.value, row.colour],
      after: null,
      actor: author,
      detail: { reason: "rename", file: from.path, from: rename.from, to: rename.to },
      at,
    };
    statements.push({
      sql: `INSERT INTO history (string_id, language, event, before_value, after_value,
        before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: historyParams(deleted),
    });
  }
  for (const table of ["translations", "suggestions", "history"]) {
    statements.push({
      sql: `UPDATE ${table} SET string_id = ? WHERE string_id = ?`,
      params: [to.id, from.id],
    });
  }
  // The new key has translations now where the LLM may have failed on it.
  statements.push({
    sql: `DELETE FROM llm_failures WHERE string_id = ?
     AND language IN (SELECT language FROM translations WHERE string_id = ?)`,
    params: [to.id, to.id],
  });
  return {
    statements,
    history: {
      stringId: to.id,
      language: null,
      event: "source_renamed",
      before: null,
      after: null,
      actor: author,
      detail: { file: from.path, from: rename.from, to: rename.to, fromStringId: from.id },
      at,
    },
  };
}

/**
 * `POST /renames` (administrators, S10.1): one rename, as an upload's `--rename` makes it,
 * in its own transaction, with the history event and an activity row. A rename already
 * made changes nothing.
 */
export function renameKey(ctx: Context, actor: Actor, request: RenameRequest): RenameResult {
  const author = authorFor(ctx, actor);
  const ends = resolveRename(ctx, request);
  if (alreadyRenamed(ctx, ends.from.id, ends.to.id)) {
    return { renamed: [], revision: getRevision(ctx.sql) };
  }
  const now = ctx.clock();
  const record = moveRename(ctx, ends, request, author, now);
  addHistory(ctx.sql, record);
  recomputeQa(ctx, [ends.to.id]);
  const renamed = { file: ends.from.path, from: request.from, to: request.to };
  const activity = renameActivity(ends, request, author, now);
  ctx.sql.run(activity.sql, ...(activity.params ?? []));
  return { renamed: [renamed], revision: bumpRevision(ctx.sql) };
}

function renameActivity(
  ends: { from: RenameEnd; to: RenameEnd },
  request: RenameRequest,
  author: Author,
  now: number,
): Statement {
  const renamed = { file: ends.from.path, from: request.from, to: request.to };
  return {
    sql: "INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES ('rename', ?, ?, ?, ?, ?, ?)",
    params: [
      author.type,
      author.id,
      author.label,
      `Renamed ${request.from} to ${request.to} in ${ends.from.path}`,
      toJson({ ...renamed, fromStringId: ends.from.id, toStringId: ends.to.id }),
      now,
    ],
  };
}

type RenameSource = RenameEnd & { source: string; source_hash: string; max_length: number | null };
type RenameTranslation = TranslationRow & { people: number };

export async function renameKeyAsync(
  sql: Sql,
  actor: Actor,
  request: RenameRequest,
  now: number,
  model: string,
): Promise<RenameResult> {
  const selected = `SELECT s.id FROM strings s JOIN files f ON f.id = s.file_id
    WHERE f.path = ? AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`;
  const refs: Statement = {
    sql: "SELECT 'user' AS actor_type, created_by AS actor_id FROM glossary_terms",
  };
  return withRetries(
    sql,
    async () => {
      const [
        revision,
        strings,
        translations,
        suggestions,
        history,
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
          sql: `SELECT s.id, f.path, s.display_key, s.key_path, s.kind, s.active, s.source, s.source_hash, s.max_length FROM strings s JOIN files f ON f.id = s.file_id WHERE s.id IN (${selected}) ORDER BY s.position`,
          params: [request.file],
        },
        {
          sql: `SELECT t.*, (SELECT COUNT(*) FROM history h WHERE h.string_id = t.string_id AND h.language = t.language AND h.actor_type <> 'llm') AS people FROM translations t WHERE t.string_id IN (${selected}) ORDER BY t.language`,
          params: [request.file],
        },
        {
          sql: `SELECT string_id, COUNT(*) AS count FROM suggestions WHERE string_id IN (${selected}) GROUP BY string_id`,
          params: [request.file],
        },
        {
          sql: `SELECT string_id, detail FROM history WHERE event = 'source_renamed' AND string_id IN (${selected})`,
          params: [request.file],
        },
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
          strings: strings as RenameSource[],
          translations: translations as RenameTranslation[],
          suggestions: suggestions as { string_id: number; count: number }[],
          history: history as { string_id: number; detail: string | null }[],
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("settings");
      const ends = resolveRenameRows(state.strings, request);
      const old = state.translations.filter((row) => row.string_id === ends.from.id);
      const hasSuggestions = state.suggestions.some(
        (row) => row.string_id === ends.from.id && row.count > 0,
      );
      const renamedBefore = state.history.some(
        (row) =>
          row.string_id === ends.to.id &&
          fromJsonOrNull<{ fromStringId?: number }>(row.detail)?.fromStringId === ends.from.id,
      );
      if (old.length === 0 && !hasSuggestions && renamedBefore)
        return { statements: [], result: { renamed: [], revision: state.revision } };
      const current = state.translations.filter((row) => row.string_id === ends.to.id);
      const languages = new Set(old.map((row) => row.language));
      const clashes = current.filter((row) => languages.has(row.language));
      const author: Author =
        actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
      const plan = planRenameMove(ends, request, author, now, clashes);
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(state.languages.map(toLanguage).map((entry) => [entry.tag, entry])),
        glossary: state.glossary.map((entry) => glossaryTermFromRow(entry, actors)),
      };
      const target = state.strings.find((row) => row.id === ends.to.id)!;
      const moved = new Map(current.map((row) => [row.language, row]));
      for (const row of old) moved.set(row.language, { ...row, string_id: ends.to.id });
      const qa = [...moved.values()].map((row) => ({
        ...row,
        kind: target.kind,
        source: target.source,
        max_length: target.max_length,
      }));
      return {
        statements: [
          ...plan.statements,
          {
            sql: "INSERT INTO history (string_id, language, event, before_value, after_value, before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: historyParams(plan.history),
          },
          ...planQa(qa, facts),
          renameActivity(ends, request, author, now),
        ],
        result: {
          renamed: [{ file: ends.from.path, from: request.from, to: request.to }],
          revision: state.revision + 1,
        },
      };
    },
  );
}
