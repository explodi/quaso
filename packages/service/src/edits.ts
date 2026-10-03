// SPDX-License-Identifier: MIT
/**
 * Direct edits by managers and administrators (design §5.4, S6.9): a save is blue, a green
 * translation can be approved as it is (an outdated one then becomes current: a person
 * confirmed it for the current English), unapproved back to green, or deleted (red). Every
 * change goes through the single write path, with its revision check (409) and history.
 */
import { canonicalLanguageTag, type TextValue } from "@quaso/core";
import type { TranslationResult, TranslationTarget } from "./accounts_api.ts";
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
import { fromJson } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import { permissionReadStatements, permissionsFromRows, requirePermission } from "./permissions.ts";
import { planStaleSuggestions, type PendingSuggestion, supersedeStale } from "./suggestions.ts";
import {
  describeTranslation,
  loadString,
  loadTranslation,
  writeTranslation,
  planTranslationWrite,
  translationInfo,
  TRANSLATION_COLUMNS,
  type TargetString,
  type TranslationRow,
  type WriteTranslation,
} from "./translations.ts";

import type { Sql, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";
import { type Facts } from "./facts.ts";
import { type LanguageRow, toLanguage } from "./languages.ts";
import { type GlossaryRow, glossaryTermFromRow } from "./glossary.ts";
import { settingsFromData } from "./settings.ts";

function target(ctx: Context, actor: Actor, input: TranslationTarget) {
  const language = canonicalLanguageTag(input.language) ?? input.language;
  requirePermission(ctx, actor, "edit", language);
  const string = loadString(ctx.sql, input.id);
  if (string === undefined || string.active !== 1) throw notFound(`String ${input.id}`);
  return { string, language, author: authorFor(ctx, actor) };
}

/**
 * The translation after an edit. The pending suggestions the edit made stale (a "looks
 * good" or an LLM proposal for the old text, anything over a new blue) are superseded.
 */
function result(
  ctx: Context,
  stringId: number,
  language: string,
  author: Author,
): TranslationResult {
  supersedeStale(ctx, stringId, language, author);
  const string = loadString(ctx.sql, stringId)!;
  const row = loadTranslation(ctx.sql, stringId, language);
  return { translation: row ? describeTranslation(ctx.sql, row, string.source_hash) : null };
}

function approverOf(actor: Actor): number | null {
  return actor.type === "user" ? actor.userId : null;
}

/** A manager's save: blue, approved by them. */
export function saveTranslation(
  ctx: Context,
  actor: Actor,
  input: TranslationTarget & { value: TextValue },
): TranslationResult {
  return editTranslation(ctx, actor, { action: "save", input });
}

/** Confirms the existing text for the current English, running its checks again. */
export function approveTranslation(
  ctx: Context,
  actor: Actor,
  input: TranslationTarget,
): TranslationResult {
  return editTranslation(ctx, actor, { action: "approve", input });
}

/** Blue back to green, for the same text and English. Checks don't block it. */
export function unapproveTranslation(
  ctx: Context,
  actor: Actor,
  input: TranslationTarget,
): TranslationResult {
  return editTranslation(ctx, actor, { action: "unapprove", input });
}

/** Deletes a translation: the string becomes red (untranslated) in that language. */
export function deleteTranslation(
  ctx: Context,
  actor: Actor,
  input: TranslationTarget,
): TranslationResult {
  return editTranslation(ctx, actor, { action: "delete", input });
}

function editTranslation(ctx: Context, actor: Actor, edit: TranslationEdit): TranslationResult {
  const { string, language, author } = target(ctx, actor, edit.input);
  const existing = loadTranslation(ctx.sql, string.id, language);
  const input = translationEditInput(edit, existing, author, approverOf(actor), language);
  writeTranslation(ctx, input);
  return result(ctx, string.id, language, author);
}

type TranslationEdit =
  | { action: "save"; input: TranslationTarget & { value: TextValue } }
  | { action: "approve" | "unapprove" | "delete"; input: TranslationTarget };

/** An edit and its stale-suggestion history commit against the same captured revision. */
export async function editTranslationAsync(
  sql: Sql,
  actor: Actor,
  edit: TranslationEdit,
  now: number,
  model: string,
): Promise<TranslationResult> {
  const input = edit.input;
  const language = canonicalLanguageTag(input.language) ?? input.language;
  const actorId = actor.type === "user" ? actor.userId : null;
  const refs: Statement = {
    sql: `SELECT author_type AS actor_type, author_id AS actor_id FROM translations WHERE string_id = ? AND language = ?
      UNION ALL SELECT 'user', approver_id FROM translations WHERE string_id = ? AND language = ?
      UNION ALL SELECT 'user', ?
      UNION ALL SELECT 'user', created_by FROM glossary_terms`,
    params: [input.id, language, input.id, language, actorId],
  };
  return withRetries(
    sql,
    async () => {
      const [
        revision,
        strings,
        translations,
        suggestions,
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
          params: [input.id, language],
        },
        {
          sql: "SELECT id, kind, value, base_revision FROM suggestions WHERE string_id = ? AND language = ? AND status = 'pending'",
          params: [input.id, language],
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
          string: strings[0] as TargetString | undefined,
          existing: translations[0] as TranslationRow | undefined,
          suggestions: suggestions as PendingSuggestion[],
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("edit", language);
      const string = state.string;
      if (string === undefined || string.active !== 1) throw notFound(`String ${input.id}`);
      const author: Author =
        actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
      const existing = state.existing;
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(state.languages.map(toLanguage).map((entry) => [entry.tag, entry])),
        glossary: state.glossary.map((entry) => glossaryTermFromRow(entry, actors)),
      };
      const write = translationEditInput(edit, existing, author, approverOf(actor), language);
      const plan = planTranslationWrite(write, {
        string,
        existing,
        facts,
        actors,
        revision: state.revision + 1,
        now,
      });
      return {
        statements: [
          ...plan.statements,
          ...planStaleSuggestions(
            state.suggestions,
            plan.translation,
            string.id,
            language,
            author,
            now,
          ),
        ],
        result: {
          translation: plan.translation
            ? translationInfo(plan.translation, string.source_hash, actors)
            : null,
        },
      };
    },
  );
}

function translationEditInput(
  edit: TranslationEdit,
  existing: TranslationRow | undefined,
  author: Author,
  approverId: number | null,
  language: string,
): WriteTranslation {
  const input: WriteTranslation = {
    stringId: edit.input.id,
    language,
    baseRevision: edit.input.baseRevision,
    actor: author,
    approverId,
    colour: "blue",
    value: null,
    event: "translation_deleted",
  };
  switch (edit.action) {
    case "save":
      return { ...input, value: edit.input.value, event: "translation_saved" };
    case "delete":
      return input;
    case "approve":
    case "unapprove": {
      if (existing === undefined && edit.input.baseRevision === 0)
        throw badRequest(`There is no translation to ${edit.action}.`);
      const value = existing ? fromJson<TextValue>(existing.value) : "";
      if (edit.action === "approve") return { ...input, value, event: "translation_approved" };
      return {
        ...input,
        value,
        colour: "green",
        event: "translation_unapproved",
        sourceHash: existing?.source_hash,
        allowQaErrors: true,
      };
    }
  }
}
