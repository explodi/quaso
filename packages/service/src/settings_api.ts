// SPDX-License-Identifier: MIT
/**
 * What administrators change on the Settings page (S8.4, S8.5): the project's settings,
 * the languages, the files' context for the LLM, and the strings' descriptions and limits.
 * Each change runs in the caller's transaction, raises the revision and, where the checks
 * depend on it, runs them again on the translations it affects (design §5.7). Changes are
 * logged with who made them; the Activity page shows uploads, jobs, reviews, imports and
 * renames only (design §6), so they aren't activity rows.
 */
import {
  type AddLanguageResult,
  canonicalLanguageTag,
  type FileSettings,
  hasPluralRules,
  type LanguageSettings,
  type PluralOverride,
  ProjectSettings,
  PROMPT_PLACEHOLDERS,
  type SettingsResult,
  type UpdateLanguageRequest,
  type UpdateSettingsRequest,
  type UpdateStringRequest,
  type UpdateStringResult,
} from "@quaso/core";
import { type Author, authorFor } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, toJson } from "./db.ts";
import { TRANSLATABLE_SQL } from "./entries.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import {
  addLanguage,
  type Language,
  languageFacts,
  loadLanguages,
  type LanguageRow,
  toLanguage,
  requireLanguage,
} from "./languages.ts";
import {
  DEFAULT_PROMPT_TEMPLATE,
  loadSettings,
  saveSettings,
  settingsFromData,
} from "./settings.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql } from "./ports.ts";
import { withoutNotes } from "./llm/prompt.ts";
import { recomputeQa } from "./translations.ts";
import { validateInput } from "./validation.ts";

/** What the Settings page needs besides the database: the provider's models. */
export interface SettingsExtras {
  models: string[];
  llmAvailable: boolean;
}

/** `GET /settings` */
export function getSettings(ctx: Context, extras: SettingsExtras): SettingsResult {
  return settingsResult(loadSettings(ctx), loadLanguages(ctx.sql), loadFileSettings(ctx), extras);
}

/** Settings data and administrative access are captured in the same read batch. */
export async function getSettingsAsync(
  sql: Sql,
  actor: Actor,
  model: string,
  extras: SettingsExtras,
): Promise<SettingsResult> {
  const [stored, languages, files, ...permissionRows] = await sql.read([
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    {
      sql: "SELECT id, path, context, generated_context FROM files WHERE active = 1 ORDER BY path",
    },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("settings");
  return settingsResult(
    settingsFromData((stored[0]?.data as string | undefined) ?? null, model),
    (languages as LanguageRow[]).map(toLanguage),
    (files as FileRow[]).map(fileSettings),
    extras,
  );
}

export function settingsResult(
  settings: ProjectSettings,
  languages: Language[],
  files: FileSettings[],
  extras: SettingsExtras,
): SettingsResult {
  return {
    settings,
    defaultPromptTemplate: DEFAULT_PROMPT_TEMPLATE,
    languages: languages.map(languageSettings),
    files,
    models: extras.models,
    llmAvailable: extras.llmAvailable,
  };
}

/** A language as the Settings page shows it. */
export function languageSettings(language: Language): LanguageSettings {
  const facts = languageFacts(language);
  return {
    tag: language.tag,
    name: facts.name,
    direction: facts.direction,
    instructions: language.instructions,
    pluralOverride: language.pluralOverride ?? null,
    categories: facts.plural,
  };
}

export type FileRow = {
  id: number;
  path: string;
  context: string;
  generated_context: string | null;
};

/** The active files, with the context a person wrote and the one the LLM generated. */
function loadFileSettings(ctx: Context): FileSettings[] {
  return ctx.sql
    .query<FileRow>(
      "SELECT id, path, context, generated_context FROM files WHERE active = 1 ORDER BY path",
    )
    .map(fileSettings);
}

export function fileSettings(row: FileRow): FileSettings {
  return {
    id: row.id,
    path: row.path,
    context: row.context,
    generatedContext: row.generated_context,
  };
}

const PLACEHOLDER = /%[A-Za-z][A-Za-z0-9]*%/g;
const MODEL_NAME = /^[\w.-]+$/;
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(PROMPT_PLACEHOLDERS);

/**
 * Checks a prompt template (design §5.6): it must send the strings (`%strings%`), and use
 * only the placeholders the service fills in.
 */
export function checkPromptTemplate(template: string): void {
  // Notes (lines starting with %%) are never sent: only what is sent counts.
  const sent = withoutNotes(template);
  if (!sent.includes("%strings%")) {
    throw badRequest(
      "The prompt template must contain %strings% outside the %% notes: without it, the strings never reach the model.",
      [{ path: "llm.promptTemplate", message: "must contain %strings%" }],
    );
  }
  const unknown = [...new Set(sent.match(PLACEHOLDER) ?? [])].filter(
    (name) => !KNOWN_PLACEHOLDERS.has(name),
  );
  if (unknown.length > 0) {
    throw badRequest(
      `The prompt template has unknown placeholders: ${unknown.join(", ")}. The known ones are ${PROMPT_PLACEHOLDERS.join(
        ", ",
      )}.`,
      unknown.map((name) => ({
        path: "llm.promptTemplate",
        value: name,
        message: "unknown placeholder",
      })),
    );
  }
}

/** The settings with a `PATCH /settings` applied: top-level fields replace, `llm` and `llm.context` merge. */
export function mergeSettings(
  current: ProjectSettings,
  request: UpdateSettingsRequest,
): ProjectSettings {
  const { llm, ...rest } = request;
  const merged: ProjectSettings = { ...current };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  if (llm !== undefined) {
    const { context, ...llmRest } = llm;
    const nextLlm = { ...current.llm };
    for (const [key, value] of Object.entries(llmRest)) {
      if (value !== undefined) (nextLlm as Record<string, unknown>)[key] = value;
    }
    if (context !== undefined) {
      const nextContext = { ...current.llm.context };
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) (nextContext as Record<string, unknown>)[key] = value;
      }
      nextLlm.context = nextContext;
    }
    merged.llm = nextLlm;
  }
  return merged;
}

/**
 * `PATCH /settings`: merges, validates and stores the settings. Refuses a prompt template
 * without `%strings%` or with unknown placeholders, and a new source language once the
 * project has strings. A new placeholder syntax runs the checks again on every
 * translation. Logs the changed top-level fields.
 */
export function updateSettings(
  ctx: Context,
  actor: Actor,
  request: UpdateSettingsRequest,
): { changed: string[] } {
  const author = authorFor(ctx, actor);
  const current = loadSettings(ctx);
  const { next, changed } = planSettingsChange(current, request);
  if (changed.length === 0) return { changed };

  if (next.sourceLanguage !== current.sourceLanguage) {
    if (ctx.sql.query("SELECT 1 AS found FROM strings LIMIT 1").length > 0) {
      throw badRequest(
        `The source language can't change once the project has strings (it is ${current.sourceLanguage}).`,
        [{ path: "sourceLanguage", message: "can't change once the project has strings" }],
      );
    }
    // The source language is never a target language.
    ctx.sql.run("DELETE FROM languages WHERE tag = ?", next.sourceLanguage);
  }
  saveSettings(ctx, next);
  if (changed.includes("syntax")) {
    const ids = ctx.sql
      .query<{ string_id: number }>("SELECT DISTINCT string_id FROM translations")
      .map((row) => row.string_id);
    recomputeQa(ctx, ids);
  }
  logChange(ctx, author, "Settings changed", { changed });
  bumpRevision(ctx.sql);
  return { changed };
}

/** Merge and validate before either adapter plans storage and quality checks. */
export function planSettingsChange(current: ProjectSettings, request: UpdateSettingsRequest) {
  const merged = mergeSettings(current, request);
  if (request.sourceLanguage !== undefined) {
    merged.sourceLanguage = canonicalLanguageTag(request.sourceLanguage) ?? request.sourceLanguage;
  }
  if (request.llm?.context?.otherLanguages !== undefined) {
    merged.llm.context.otherLanguages = request.llm.context.otherLanguages.map(
      (tag) => canonicalLanguageTag(tag) ?? tag,
    );
  }
  const next = validateInput(ProjectSettings, merged);
  checkPromptTemplate(next.llm.promptTemplate);
  // The model goes into the provider's URL (`llm/gemini.ts` refuses anything else).
  if (next.llm.model !== current.llm.model && !MODEL_NAME.test(next.llm.model)) {
    throw badRequest(`Not a model name: ${next.llm.model}`, [
      { path: "llm.model", message: "must be a model name, such as gemini-flash-latest" },
    ]);
  }
  const changed = changedKeys(current, next);
  return { next, changed };
}

/** The top-level fields that differ, in the settings' order. */
function changedKeys(before: ProjectSettings, after: ProjectSettings): string[] {
  return Object.keys(after).filter(
    (key) =>
      toJson(orderedSettingsValue(before[key as keyof ProjectSettings])) !==
      toJson(orderedSettingsValue(after[key as keyof ProjectSettings])),
  );
}

// Schema parsing orders keys; that must not turn a no-op into a settings write.
function orderedSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedSettingsValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, orderedSettingsValue(field)]),
  );
}

/** Logs a change to the settings, with who made it. */
function logChange(
  ctx: Context,
  author: Author,
  message: string,
  detail: Record<string, unknown>,
): void {
  ctx.logger.info(message, { ...detail, actor: { type: author.type, id: author.id } });
}

/**
 * `POST /languages`: adds a target language. Translations it had before it was removed
 * come back, with their checks run again.
 */
export function addProjectLanguage(ctx: Context, actor: Actor, tag: string): AddLanguageResult {
  const author = authorFor(ctx, actor);
  const canonical = canonicalLanguageTag(tag);
  if (canonical === null) throw badRequest(`${tag} isn't a language tag.`, [{ language: tag }]);
  const source = loadSettings(ctx).sourceLanguage;
  if (canonical === source) {
    throw badRequest(`${canonical} is the source language, so it can't be a target language.`, [
      { language: canonical },
    ]);
  }
  if (!addLanguage(ctx, canonical)) {
    throw conflict(`The project already has ${canonical}.`);
  }
  recomputeLanguage(ctx, canonical, false);
  const warnings: string[] = [];
  if (!hasPluralRules(canonical)) {
    warnings.push(
      `The server's runtime has no plural rules for ${canonical}; set a plural override for it`,
    );
  }
  logChange(ctx, author, "Language added", { language: canonical });
  bumpRevision(ctx.sql);
  return { language: languageSettings(requireLanguage(ctx, canonical)), warnings };
}

/** `PATCH /languages/{tag}`: the language's LLM instructions and plural override. */
export function updateProjectLanguage(
  ctx: Context,
  actor: Actor,
  tag: string,
  request: UpdateLanguageRequest,
): LanguageSettings {
  const author = authorFor(ctx, actor);
  const language = requireLanguage(ctx, tag);
  const changed: string[] = [];
  if (request.instructions !== undefined && request.instructions !== language.instructions) {
    ctx.sql.run(
      "UPDATE languages SET instructions = ? WHERE tag = ?",
      request.instructions,
      language.tag,
    );
    changed.push("instructions");
  }
  if (request.pluralOverride !== undefined) {
    const override = checkOverride(request.pluralOverride);
    const before = toJson(language.pluralOverride ?? null);
    if (toJson(override) !== before) {
      ctx.sql.run(
        "UPDATE languages SET plural_override = ? WHERE tag = ?",
        override === null ? null : toJson(override),
        language.tag,
      );
      recomputeLanguage(ctx, language.tag, true);
      changed.push("pluralOverride");
    }
  }
  if (changed.length > 0) {
    logChange(ctx, author, "Language changed", { language: language.tag, changed });
    bumpRevision(ctx.sql);
  }
  return languageSettings(requireLanguage(ctx, language.tag));
}

/**
 * A plural override as stored: each list given must include `other` (every language has
 * it), and an override with no lists is none.
 */
export function checkOverride(override: PluralOverride | null): PluralOverride | null {
  if (override === null) return null;
  const out: PluralOverride = {};
  for (const kind of ["cardinal", "ordinal"] as const) {
    const categories = override[kind];
    if (categories === undefined) continue;
    if (!categories.includes("other")) {
      throw badRequest(`A plural override's ${kind} categories must include other.`, [
        { path: `pluralOverride.${kind}`, message: "must include other" },
      ]);
    }
    out[kind] = categories;
  }
  return out.cardinal === undefined && out.ordinal === undefined ? null : out;
}

/**
 * `DELETE /languages/{tag}`: the language leaves the project, its downloads and its
 * progress. Its translations, suggestions and history stay in the database, and come
 * back if the language is added again (its instructions and override don't).
 */
export function removeProjectLanguage(ctx: Context, actor: Actor, tag: string): { ok: true } {
  const author = authorFor(ctx, actor);
  const language = requireLanguage(ctx, tag);
  ctx.sql.run("DELETE FROM languages WHERE tag = ?", language.tag);
  logChange(ctx, author, "Language removed", { language: language.tag });
  bumpRevision(ctx.sql);
  return { ok: true };
}

/** Runs the checks again on a language's translations: all, or the plural ones. */
function recomputeLanguage(ctx: Context, tag: string, pluralOnly: boolean): void {
  const ids = ctx.sql
    .query<{ string_id: number }>(
      `SELECT t.string_id FROM translations t JOIN strings s ON s.id = t.string_id
     WHERE t.language = ? ${pluralOnly ? "AND s.kind IN ('plural', 'ordinal')" : ""}`,
      tag,
    )
    .map((row) => row.string_id);
  if (ids.length > 0) recomputeQa(ctx, ids);
}

/** `PATCH /files/{id}`: the context a person writes for the LLM (managers too). */
export function updateFile(ctx: Context, id: number, request: { context?: string }): FileSettings {
  const rows = ctx.sql.query<FileRow>(
    "SELECT id, path, context, generated_context FROM files WHERE id = ?",
    id,
  );
  if (rows.length === 0) throw notFound(`File ${id}`);
  const row = rows[0];
  if (request.context !== undefined && request.context !== row.context) {
    ctx.sql.run(
      "UPDATE files SET context = ?, updated_at = ? WHERE id = ?",
      request.context,
      ctx.clock(),
      id,
    );
    row.context = request.context;
    bumpRevision(ctx.sql);
  }
  return fileSettings(row);
}

type StringRow = {
  id: number;
  description: string;
  max_length: number | null;
  max_length_locked: number;
};

/**
 * `PATCH /strings/{id}`: a string's description and length limit. A limit from the CLI
 * config (locked) can't be changed here; a new limit runs the checks again on the
 * string's translations.
 */
export function updateString(
  ctx: Context,
  id: number,
  request: UpdateStringRequest,
): UpdateStringResult {
  const rows = ctx.sql.query<StringRow>(
    `SELECT id, description, max_length, max_length_locked FROM strings
     WHERE id = ? AND kind IN (${TRANSLATABLE_SQL})`,
    id,
  );
  if (rows.length === 0) throw notFound(`String ${id}`);
  const row = rows[0];
  let changed = false;
  if (request.description !== undefined && request.description !== row.description) {
    row.description = request.description;
    changed = true;
  }
  const limitChanged = request.maxLength !== undefined && request.maxLength !== row.max_length;
  if (limitChanged) {
    if (row.max_length_locked === 1) {
      throw badRequest(
        "This string's length limit is set by the CLI config: change it there, then upload.",
        [{ path: "maxLength", message: "set by the CLI config" }],
      );
    }
    row.max_length = request.maxLength ?? null;
    changed = true;
  }
  if (changed) {
    ctx.sql.run(
      "UPDATE strings SET description = ?, max_length = ?, updated_at = ? WHERE id = ?",
      row.description,
      row.max_length,
      ctx.clock(),
      id,
    );
    if (limitChanged) recomputeQa(ctx, [id]);
    bumpRevision(ctx.sql);
  }
  return {
    id: row.id,
    description: row.description,
    maxLength: row.max_length,
    maxLengthLocked: row.max_length_locked === 1,
  };
}
