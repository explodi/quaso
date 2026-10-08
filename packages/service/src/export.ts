// SPDX-License-Identifier: MIT
/**
 * Download (design §5.5, FMT-2, FMT-3): every file rendered in every language, with its
 * SHA-256. Translations are what downloads read: outdated ones are written (STR-4);
 * pending changes and hidden strings never are.
 */
import {
  canonicalLanguageTag,
  type ExportFile,
  type ExportQuery,
  type ExportResult,
  type JsonFormat,
  renderFile,
  type Untranslated,
  SCHEMA_VERSION,
  sha256Hex,
  type SourceEntry,
  type TextValue,
} from "@quaso/core";
import type { Context } from "./context.ts";
import { fromJson, getRevision, idList, toJson } from "./db.ts";
import { entryFromRow, TRANSLATABLE_SQL } from "./entries.ts";
import { badRequest, notFound } from "./errors.ts";
import { type Language, type LanguageRow, loadLanguages, toLanguage } from "./languages.ts";
import { loadSettings, settingsFromData } from "./settings.ts";
import type { Sql } from "./ports.ts";

type FileRow = { id: number; path: string; format: string };

type StringRow = {
  id: number;
  file_id: number;
  key: string;
  kind: string;
  key_path: string;
  source: string;
};

/** A file's English entries, in order, with their IDs and keys. */
interface FileEntries {
  file: FileRow;
  format: JsonFormat;
  entries: SourceEntry[];
  /** `entryKey()` of each entry, by string ID, for the translatable ones. */
  keys: Map<number, string>;
}

/**
 * Renders the requested files in the requested languages. Languages default to every
 * project language (the source language is never one), files to every active file.
 * The result lists files by language, then path.
 */
export function exportFiles(ctx: Context, query: ExportQuery): ExportResult {
  const { sql } = ctx;
  const settings = loadSettings(ctx);
  const languages = pickLanguages(loadLanguages(sql), query.languages, settings.sourceLanguage);
  const files = pickFiles(
    sql.query<FileRow>("SELECT id, path, format FROM files WHERE active = 1 ORDER BY path"),
    query.files,
  );
  const english = loadEntries(ctx, files);
  const translations = new Map(
    languages.map((language) => [language.tag, loadTranslations(ctx, language.tag, files)]),
  );
  return exportResult(english, languages, translations, {
    revision: getRevision(sql),
    sourceLanguage: settings.sourceLanguage,
    untranslated: query.untranslated,
  });
}

/** Rendering and hashes use one consistent, scoped snapshot. */
export async function exportFilesAsync(
  sql: Sql,
  query: ExportQuery,
  model: string,
): Promise<ExportResult> {
  const selected =
    "SELECT id FROM files WHERE active = 1 AND (? = 1 OR path IN (SELECT value FROM json_each(?)))";
  const fileParams = [query.files === undefined ? 1 : 0, toJson(query.files ?? [])];
  const tags = query.languages?.map((tag) => canonicalLanguageTag(tag) ?? tag);
  const [revision, stored, languageRows, fileRows, strings, translated] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    { sql: "SELECT id, path, format FROM files WHERE active = 1 ORDER BY path" },
    {
      sql: `SELECT id, file_id, key, kind, key_path, source FROM strings WHERE active = 1 AND file_id IN (${selected}) ORDER BY file_id, position`,
      params: fileParams,
    },
    {
      sql: `SELECT t.string_id, t.language, t.value FROM translations t JOIN strings s ON s.id = t.string_id
      WHERE s.active = 1 AND s.kind IN (${TRANSLATABLE_SQL}) AND s.file_id IN (${selected})
      AND (? = 1 OR t.language IN (SELECT value FROM json_each(?)))`,
      params: [...fileParams, tags === undefined ? 1 : 0, toJson(tags ?? [])],
    },
  ]);
  const settings = settingsFromData((stored[0]?.data as string | undefined) ?? null, model);
  const languages = pickLanguages(
    (languageRows as LanguageRow[]).map(toLanguage),
    query.languages,
    settings.sourceLanguage,
  );
  const files = pickFiles(fileRows as FileRow[], query.files);
  const translations = new Map<string, Map<number, TextValue>>();
  for (const row of translated) {
    const tag = row.language as string;
    let values = translations.get(tag);
    if (values === undefined) {
      values = new Map();
      translations.set(tag, values);
    }
    values.set(Number(row.string_id), fromJson<TextValue>(row.value));
  }
  return exportResult(entriesFromRows(files, strings as StringRow[]), languages, translations, {
    revision: Number(revision[0].revision),
    sourceLanguage: settings.sourceLanguage,
    untranslated: query.untranslated,
  });
}

function exportResult(
  english: FileEntries[],
  languages: Language[],
  translated: Map<string, Map<number, TextValue>>,
  project: { revision: number; sourceLanguage: string; untranslated?: Untranslated },
): ExportResult {
  const out: ExportFile[] = [];
  for (const language of languages) {
    const translations = translated.get(language.tag) ?? new Map<number, TextValue>();
    for (const file of english) {
      const values = new Map<string, TextValue>();
      for (const [id, key] of file.keys) {
        const value = translations.get(id);
        if (value !== undefined) values.set(key, value);
      }
      const content = renderFile(file.entries, values, {
        language: language.tag,
        format: file.format,
        pluralOverride: language.pluralOverride,
        untranslated: project.untranslated,
      });
      out.push({
        path: file.file.path,
        language: language.tag,
        content,
        sha256: sha256Hex(content),
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: project.revision,
    sourceLanguage: project.sourceLanguage,
    files: out,
  };
}

/** The requested languages, or every one; `bad_request` naming an unknown one. */
function pickLanguages(
  all: Language[],
  requested: string[] | undefined,
  source: string,
): Language[] {
  if (requested === undefined) return all;
  const byTag = new Map(all.map((language) => [language.tag, language]));
  const picked = new Map<string, Language>();
  for (const tag of requested) {
    const canonical = canonicalLanguageTag(tag) ?? tag;
    if (canonical === source) {
      throw badRequest(`${tag} is the source language; its files are never written.`, [
        { language: tag },
      ]);
    }
    const language = byTag.get(canonical);
    if (language === undefined) {
      throw badRequest(`The project has no language ${tag}.`, [{ language: tag }]);
    }
    picked.set(canonical, language);
  }
  return [...picked.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** The requested files, or every active one; `not_found` for an unknown one. */
function pickFiles(all: FileRow[], requested: string[] | undefined): FileRow[] {
  if (requested === undefined) return all;
  const wanted = new Set(requested);
  for (const path of wanted) {
    if (!all.some((file) => file.path === path)) throw notFound(`The file ${path}`);
  }
  return all.filter((file) => wanted.has(file.path));
}

/** The active English entries of the files, in position order, with one query. */
function loadEntries(ctx: Context, files: FileRow[]): FileEntries[] {
  if (files.length === 0) return [];
  const rows = ctx.sql.query<StringRow>(
    `SELECT id, file_id, key, kind, key_path, source FROM strings
     WHERE active = 1 AND file_id IN (${idList(files.map((file) => file.id))})
     ORDER BY file_id, position`,
  );
  return entriesFromRows(files, rows);
}

function entriesFromRows(files: FileRow[], rows: StringRow[]): FileEntries[] {
  const byFile = new Map<number, FileEntries>();
  for (const file of files) {
    byFile.set(file.id, {
      file,
      format: fromJson<JsonFormat>(file.format),
      entries: [],
      keys: new Map(),
    });
  }
  for (const row of rows) {
    const file = byFile.get(row.file_id)!;
    file.entries.push(entryFromRow(row));
    if (row.kind === "text" || row.kind === "plural" || row.kind === "ordinal") {
      file.keys.set(row.id, row.key);
    }
  }
  return [...byFile.values()];
}

/** A language's translations of the active strings of the files, by string ID. */
function loadTranslations(
  ctx: Context,
  language: string,
  files: FileRow[],
): Map<number, TextValue> {
  const values = new Map<number, TextValue>();
  if (files.length === 0) return values;
  const rows = ctx.sql.query<{ string_id: number; value: string }>(
    `SELECT t.string_id, t.value FROM translations t JOIN strings s ON s.id = t.string_id
     WHERE t.language = ? AND s.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})
       AND s.file_id IN (${idList(files.map((file) => file.id))})`,
    language,
  );
  for (const row of rows) values.set(row.string_id, fromJson<TextValue>(row.value));
  return values;
}
