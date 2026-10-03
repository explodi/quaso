// SPDX-License-Identifier: MIT
/** Administrative changes plan their QA updates from the same snapshot as permissions. */
import {
  canonicalLanguageTag,
  hasPluralRules,
  type AddLanguageResult,
  type LanguageSettings,
  type UpdateLanguageRequest,
  type UpdateSettingsRequest,
  type SettingsResult,
} from "@quaso/core";
import type { Actor } from "./api.ts";
import { toJson } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import type { CheckFacts } from "./facts.ts";
import { type Language, type LanguageRow, toLanguage } from "./languages.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { type Logger, silentLogger, type Sql, type Statement } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import {
  languageSettings,
  checkOverride,
  planSettingsChange,
  settingsResult,
  fileSettings,
  type FileRow,
  type SettingsExtras,
} from "./settings_api.ts";
import { planQa, type QaRow } from "./translations.ts";
import { withRetries } from "./write.ts";

export interface SettingsWriteOptions {
  model: string;
  now: number;
  logger?: Logger;
}

export async function updateSettingsAsync(
  sql: Sql,
  actor: Actor,
  request: UpdateSettingsRequest,
  options: SettingsWriteOptions,
  extras: SettingsExtras,
): Promise<SettingsResult> {
  const result = await withRetries(
    sql,
    async () => {
      const [
        revision,
        stored,
        languages,
        files,
        strings,
        glossary,
        translations,
        ...permissionRows
      ] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT data FROM settings WHERE id = 1" },
        {
          sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
        },
        {
          sql: "SELECT id, path, context, generated_context FROM files WHERE active = 1 ORDER BY path",
        },
        { sql: "SELECT 1 AS found FROM strings LIMIT 1" },
        { sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms" },
        {
          sql: "SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source, s.max_length FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.kind IN ('text', 'plural', 'ordinal')",
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: (languages as LanguageRow[]).map(toLanguage),
          files: (files as FileRow[]).map(fileSettings),
          hasStrings: strings.length > 0,
          glossary,
          translations: translations as QaRow[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("settings");
      const current = settingsFromData(state.stored, options.model);
      const { next, changed } = planSettingsChange(current, request);
      const sourceChanged = next.sourceLanguage !== current.sourceLanguage;
      if (sourceChanged && state.hasStrings)
        throw badRequest(
          `The source language can't change once the project has strings (it is ${current.sourceLanguage}).`,
          [{ path: "sourceLanguage", message: "can't change once the project has strings" }],
        );
      const languages = sourceChanged
        ? state.languages.filter((language) => language.tag !== next.sourceLanguage)
        : state.languages;
      const statements: Statement[] = [];
      if (changed.length > 0) {
        if (sourceChanged)
          statements.push({
            sql: "DELETE FROM languages WHERE tag = ?",
            params: [next.sourceLanguage],
          });
        statements.push({
          sql: "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
          params: [toJson(next)],
        });
        if (changed.includes("syntax"))
          statements.push(
            ...planQa(state.translations, {
              sourceLanguage: next.sourceLanguage,
              syntax: next.syntax,
              languages: new Map(languages.map((language) => [language.tag, language])),
              glossary: state.glossary.map((row) => ({
                term: row.term as string,
                language: row.language as string | null,
                kind: row.kind as "translate" | "keep",
                translation: row.translation as string | null,
                caseSensitive: row.case_sensitive === 1,
              })),
            }),
          );
      }
      return {
        statements,
        result: { saved: settingsResult(next, languages, state.files, extras), changed },
      };
    },
  );
  if (result.changed.length > 0)
    logChange(options, actor, "Settings changed", { changed: result.changed });
  return result.saved;
}

async function readLanguageChange(sql: Sql, actor: Actor, tag: string) {
  const [revision, stored, languages, glossary, translations, ...permissionRows] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    { sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms" },
    {
      sql: "SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source, s.max_length FROM translations t JOIN strings s ON s.id = t.string_id WHERE t.language = ? AND s.kind IN ('text', 'plural', 'ordinal')",
      params: [canonicalLanguageTag(tag)],
    },
    ...permissionReadStatements(actor),
  ]);
  return {
    revision: Number(revision[0].revision),
    state: {
      stored: (stored[0]?.data as string | undefined) ?? null,
      languages: (languages as LanguageRow[]).map(toLanguage),
      glossary: glossary.map((row) => ({
        term: row.term as string,
        language: row.language as string | null,
        kind: row.kind as "translate" | "keep",
        translation: row.translation as string | null,
        caseSensitive: row.case_sensitive === 1,
      })),
      translations: translations as QaRow[],
      permissions: permissionsFromRows(actor, permissionRows),
    },
  };
}

type LanguageState = Awaited<ReturnType<typeof readLanguageChange>>["state"];

function languageQa(state: LanguageState, language: Language, model: string, pluralOnly: boolean) {
  const settings = settingsFromData(state.stored, model);
  const facts: CheckFacts = {
    sourceLanguage: settings.sourceLanguage,
    syntax: settings.syntax,
    glossary: state.glossary,
    languages: new Map([...state.languages, language].map((entry) => [entry.tag, entry])),
  };
  const rows = state.translations.filter((row) => {
    const sameLanguage = row.language === language.tag;
    const selectedKind = !pluralOnly || row.kind === "plural" || row.kind === "ordinal";
    return sameLanguage && selectedKind;
  });
  return planQa(rows, facts);
}

function languageIn(state: LanguageState, tag: string): Language {
  const canonical = canonicalLanguageTag(tag);
  const language = state.languages.find((entry) => entry.tag === canonical);
  if (!language) throw notFound(`The project has no language ${tag}.`);
  return language;
}

function logChange(
  options: SettingsWriteOptions,
  actor: Actor,
  message: string,
  detail: Record<string, unknown>,
) {
  const id = actor.type === "user" ? actor.userId : actor.type === "token" ? actor.tokenId : null;
  (options.logger ?? silentLogger).info(message, { ...detail, actor: { type: actor.type, id } });
}

export async function addProjectLanguageAsync(
  sql: Sql,
  actor: Actor,
  tag: string,
  options: SettingsWriteOptions,
): Promise<AddLanguageResult> {
  const result = await withRetries(
    sql,
    () => readLanguageChange(sql, actor, tag),
    (state) => {
      state.permissions.require("settings");
      const canonical = canonicalLanguageTag(tag);
      if (canonical === null) throw badRequest(`${tag} isn't a language tag.`, [{ language: tag }]);
      const source = settingsFromData(state.stored, options.model).sourceLanguage;
      if (canonical === source)
        throw badRequest(`${canonical} is the source language, so it can't be a target language.`, [
          { language: canonical },
        ]);
      if (state.languages.some((language) => language.tag === canonical))
        throw conflict(`The project already has ${canonical}.`);
      const language: Language = {
        tag: canonical,
        instructions: "",
        pluralOverride: undefined,
        createdAt: options.now,
      };
      const warnings = hasPluralRules(canonical)
        ? []
        : [
            `The server's runtime has no plural rules for ${canonical}; set a plural override for it`,
          ];
      return {
        statements: [
          {
            sql: "INSERT INTO languages (tag, created_at) VALUES (?, ?)",
            params: [canonical, options.now],
          },
          ...languageQa(state, language, options.model, false),
        ],
        result: { language: languageSettings(language), warnings },
      };
    },
  );
  logChange(options, actor, "Language added", { language: result.language.tag });
  return result;
}

export async function updateProjectLanguageAsync(
  sql: Sql,
  actor: Actor,
  tag: string,
  request: UpdateLanguageRequest,
  options: SettingsWriteOptions,
): Promise<LanguageSettings> {
  const result = await withRetries(
    sql,
    () => readLanguageChange(sql, actor, tag),
    (state) => {
      state.permissions.require("settings");
      const current = languageIn(state, tag);
      const language = { ...current };
      const changed: string[] = [];
      if (request.instructions !== undefined && request.instructions !== current.instructions) {
        language.instructions = request.instructions;
        changed.push("instructions");
      }
      if (request.pluralOverride !== undefined) {
        const override = checkOverride(request.pluralOverride);
        if (toJson(override) !== toJson(current.pluralOverride ?? null)) {
          language.pluralOverride = override ?? undefined;
          changed.push("pluralOverride");
        }
      }
      if (changed.length === 0)
        return { statements: [], result: { language: languageSettings(language), changed } };
      return {
        statements: [
          {
            sql: "UPDATE languages SET instructions = ?, plural_override = ? WHERE tag = ?",
            params: [
              language.instructions,
              language.pluralOverride === undefined ? null : toJson(language.pluralOverride),
              language.tag,
            ],
          },
          ...(changed.includes("pluralOverride")
            ? languageQa(state, language, options.model, true)
            : []),
        ],
        result: { language: languageSettings(language), changed },
      };
    },
  );
  if (result.changed.length > 0)
    logChange(options, actor, "Language changed", {
      language: result.language.tag,
      changed: result.changed,
    });
  return result.language;
}

export async function removeProjectLanguageAsync(
  sql: Sql,
  actor: Actor,
  tag: string,
  options: SettingsWriteOptions,
): Promise<{ ok: true }> {
  const canonical = await withRetries(
    sql,
    () => readLanguageChange(sql, actor, tag),
    (state) => {
      state.permissions.require("settings");
      const language = languageIn(state, tag);
      return {
        statements: [{ sql: "DELETE FROM languages WHERE tag = ?", params: [language.tag] }],
        result: language.tag,
      };
    },
  );
  logChange(options, actor, "Language removed", { language: canonical });
  return { ok: true };
}
