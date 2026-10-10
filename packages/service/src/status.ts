// SPDX-License-Identifier: MIT
/**
 * Progress counts (design §5.9, CLI-6) per language and per file. The rows are loaded
 * once, with a few set-based queries, and counted in TypeScript: simpler than one query per
 * count. The counts are kept until the next write, since the public pages ask for them on
 * every view.
 */
import type {
  FileProgress,
  FilesResult,
  SourceFilesResult,
  SourceAmbiguity,
  LanguageProgress,
  Progress,
  StatusResult,
  ProjectSettings,
} from "@quaso/core";
import { canonicalLanguageTag } from "@quaso/core";
import type { Context } from "./context.ts";
import { getRevision, fromJson } from "./db.ts";
import { TRANSLATABLE_SQL } from "./entries.ts";
import {
  type Language,
  type LanguageRow,
  languageFacts,
  loadLanguages,
  requireLanguage,
  toLanguage,
} from "./languages.ts";
import type { Sql, SyncSql } from "./ports.ts";
import { loadSettings, settingsFromData } from "./settings.ts";
import { ServiceError } from "./errors.ts";

/** A translatable, active string in an active file. */
interface StringStat {
  id: number;
  fileId: number;
  words: number;
  sourceHash: string;
}

/** A translation's state. */
interface TranslationStat {
  colour: string;
  outdated: boolean;
  qa: boolean;
}

type CountingRow = { id: number; file_id: number; words: number; source_hash: string };
type TranslationStatRow = {
  string_id: number;
  colour: string;
  source_hash: string;
  qa_errors: number;
  extra_checks?: string;
};

/** The strings and files progress is counted over, loaded once. */
export interface Counting {
  files: {
    id: number;
    path: string;
    repo_path: string;
    source_updated_at: number;
    source_revision: number;
  }[];
  strings: StringStat[];
  /** The strings of each file, by file ID. */
  byFile: Map<number, StringStat[]>;
  /** Each string's English hash, by string ID. */
  hashes: Map<number, string>;
}

const ACTIVE_FILES =
  "SELECT id, path, repo_path, source_updated_at, source_revision FROM files WHERE active = 1 ORDER BY path";
const ACTIVE_STRINGS = `SELECT s.id, s.file_id, s.words, s.source_hash FROM strings s
  JOIN files f ON f.id = s.file_id
  WHERE s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`;

/** Loads the active files and their translatable, active strings. */
export function loadCounting(ctx: Context): Counting {
  const files = ctx.sql.query<Counting["files"][number]>(ACTIVE_FILES);
  const strings = ctx.sql.query<CountingRow>(ACTIVE_STRINGS);
  return countingFromRows(files, strings);
}

function countingFromRows(files: Counting["files"], rows: CountingRow[]): Counting {
  const strings = rows.map((row) => ({
    id: row.id,
    fileId: row.file_id,
    words: row.words,
    sourceHash: row.source_hash,
  }));
  const byFile = new Map<number, StringStat[]>(files.map((file) => [file.id, []]));
  for (const string of strings) byFile.get(string.fileId)?.push(string);
  const hashes = new Map(strings.map((string) => [string.id, string.sourceHash]));
  return { files, strings, byFile, hashes };
}

/** One language's translations and pending suggestions, over the counted strings. */
interface LanguageData {
  translations: Map<number, TranslationStat>;
  pending: Set<number>;
}

function loadLanguageData(ctx: Context, counting: Counting, language: string): LanguageData {
  const rows = ctx.sql.query<TranslationStatRow>(
    "SELECT string_id, colour, source_hash, qa_errors, extra_checks FROM translations WHERE language = ?",
    language,
  );
  const suggestions = ctx.sql.query<{ string_id: number }>(
    "SELECT DISTINCT string_id FROM suggestions WHERE language = ? AND status = 'pending'",
    language,
  );
  return languageDataFromRows(counting, rows, suggestions);
}

function languageDataFromRows(
  counting: Counting,
  rows: TranslationStatRow[],
  suggestions: { string_id: number }[],
): LanguageData {
  const { hashes } = counting;
  const translations = new Map<number, TranslationStat>();
  for (const row of rows) {
    const hash = hashes.get(row.string_id);
    if (hash === undefined) continue;
    translations.set(row.string_id, {
      colour: row.colour,
      outdated: row.source_hash !== hash,
      qa: row.qa_errors > 0 || (row.extra_checks !== undefined && row.extra_checks !== "[]"),
    });
  }
  const pending = new Set<number>();
  for (const row of suggestions) {
    if (hashes.has(row.string_id)) pending.add(row.string_id);
  }
  return { translations, pending };
}

/** Progress counted one string at a time. */
class Tally {
  readonly progress: Progress = {
    strings: 0,
    words: 0,
    untranslated: 0,
    green: 0,
    blue: 0,
    outdated: 0,
    pending: 0,
    qa: 0,
    wordsLeft: 0,
    translatedPercent: 0,
    proofreadPercent: 0,
  };
  #translatedWords = 0;
  #blueWords = 0;

  add(string: StringStat, translation: TranslationStat | undefined, pending: boolean): void {
    const progress = this.progress;
    progress.strings++;
    progress.words += string.words;
    if (pending) progress.pending++;
    if (translation === undefined) {
      progress.untranslated++;
      progress.wordsLeft += string.words;
      return;
    }
    this.#translatedWords += string.words;
    if (translation.colour === "blue") {
      progress.blue++;
      this.#blueWords += string.words;
    } else {
      progress.green++;
    }
    if (translation.outdated) progress.outdated++;
    if (translation.qa) progress.qa++;
  }

  /** The counts, with the percentages. */
  finish(): Progress {
    const progress = this.progress;
    const translated = progress.green + progress.blue;
    progress.translatedPercent = percent(
      this.#translatedWords,
      progress.words,
      translated,
      progress.strings,
    );
    progress.proofreadPercent = percent(
      this.#blueWords,
      progress.words,
      progress.blue,
      progress.strings,
    );
    return progress;
  }
}

/** A percentage by words, rounded down; by strings when there are no words. */
function percent(words: number, totalWords: number, strings: number, totalStrings: number): number {
  if (totalWords > 0) return Math.floor((words * 100) / totalWords);
  if (totalStrings > 0) return Math.floor((strings * 100) / totalStrings);
  return 0;
}

/** A language's counts, in all and per file. */
interface LanguageCounts {
  progress: Progress;
  files: FileProgress[];
}

/**
 * Counts at one state of the database. Counting reads every translation of a language, so
 * the public pages would repeat that work on every view: the counts are kept until the
 * next write. `total_changes()` rises with every write on the connection, even one rolled
 * back later, and the revision with every change the service makes to what is counted (so
 * counts taken inside a transaction that raised it and then rolled back are never reused).
 */
interface CountCache {
  key: string;
  counting: Counting;
  languages: Map<string, LanguageCounts>;
}

const caches = new WeakMap<SyncSql, CountCache>();

/** The counts cache for the database as it is now. */
function countCache(ctx: Context): CountCache {
  const [{ changes }] = ctx.sql.query<{ changes: number }>("SELECT total_changes() AS changes");
  const key = `${getRevision(ctx.sql)}:${changes}`;
  let cache = caches.get(ctx.sql);
  if (cache === undefined || cache.key !== key) {
    cache = { key, counting: loadCounting(ctx), languages: new Map() };
    caches.set(ctx.sql, cache);
  }
  return cache;
}

/** The active files and their translatable, active strings, as the counts see them. */
export function currentCounting(ctx: Context): Counting {
  return countCache(ctx).counting;
}

/** Counts a language in all and per file, in one pass over the strings. */
function countLanguage(counting: Counting, data: LanguageData): LanguageCounts {
  const total = new Tally();
  const files = counting.files.map((file) => {
    const tally = new Tally();
    for (const string of counting.byFile.get(file.id) ?? []) {
      const translation = data.translations.get(string.id);
      const pending = data.pending.has(string.id);
      tally.add(string, translation, pending);
      total.add(string, translation, pending);
    }
    return { id: file.id, path: file.path, repoPath: file.repo_path, ...tally.finish() };
  });
  return { progress: total.finish(), files };
}

/** A language's progress, with its name, direction and plural categories, and its files. */
export function languageProgress(
  ctx: Context,
  language: Language,
): { progress: LanguageProgress; files: FileProgress[] } {
  const cache = countCache(ctx);
  let counts = cache.languages.get(language.tag);
  if (counts === undefined) {
    counts = countLanguage(cache.counting, loadLanguageData(ctx, cache.counting, language.tag));
    cache.languages.set(language.tag, counts);
  }
  return {
    progress: { ...languageFacts(language), ...counts.progress },
    files: counts.files.map((file) => ({ ...file })),
  };
}

/** `GET /status`: every language (or one), with its files. */
export function getStatus(ctx: Context, language?: string): StatusResult {
  const languages =
    language === undefined ? loadLanguages(ctx.sql) : [requireLanguage(ctx, language)];
  return {
    revision: getRevision(ctx.sql),
    sourceLanguage: loadSettings(ctx).sourceLanguage,
    languages: languages.map((entry) => {
      const { progress, files } = languageProgress(ctx, entry);
      return { ...progress, files };
    }),
  };
}

/** `GET /files?language=`: the active files, with their progress in one language. */
export function listFiles(ctx: Context, language?: string): FilesResult {
  if (language === undefined)
    return sourceFiles(loadCounting(ctx), ambiguityRows(ctx.sql.query(AMBIGUITIES)));
  const found = requireLanguage(ctx, language);
  const { files } = languageProgress(ctx, found);
  return { language: found.tag, files };
}

function sourceFiles(counting: Counting, ambiguities: SourceAmbiguity[] = []): SourceFilesResult {
  return {
    ...(ambiguities.length > 0 ? { ambiguities } : {}),
    files: counting.files.map((file) => {
      const strings = counting.byFile.get(file.id) ?? [];
      return {
        id: file.id,
        path: file.path,
        repoPath: file.repo_path,
        strings: strings.length,
        words: strings.reduce((total, string) => total + string.words, 0),
        updatedAt: file.source_updated_at,
        revision: file.source_revision,
      };
    }),
  };
}

export interface ProgressSnapshot {
  revision: number;
  settings: ProjectSettings;
  counting: Counting;
  languages: (LanguageProgress & { files: FileProgress[] })[];
  members: number;
  lastActivity: number | null;
}

/** The revision and every count come from the same read batch. */
export async function readProgressSnapshot(
  sql: Sql,
  model: string,
  language?: string,
): Promise<ProgressSnapshot> {
  const canonical = language === undefined ? undefined : canonicalLanguageTag(language);
  const scope = canonical === undefined ? "" : " AND language = ?";
  const params = canonical === undefined ? [] : [canonical];
  const active = `SELECT s.id FROM strings s JOIN files f ON f.id = s.file_id
    WHERE s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`;
  const rows = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    { sql: ACTIVE_FILES },
    { sql: `SELECT id, file_id, words, source_hash FROM strings WHERE id IN (${active})` },
    {
      sql: `SELECT string_id, language, colour, source_hash, qa_errors, extra_checks FROM translations WHERE string_id IN (${active})${scope}`,
      params,
    },
    {
      sql: `SELECT DISTINCT string_id, language FROM suggestions WHERE status = 'pending' AND string_id IN (${active})${scope}`,
      params,
    },
    {
      sql: `SELECT (SELECT COUNT(*) FROM users WHERE role <> 'none' AND deleted_at IS NULL) AS members,
      (SELECT MAX(created_at) FROM activity) AS last_activity`,
    },
  ]);
  const languages = (rows[2] as LanguageRow[]).map(toLanguage);
  const selected =
    canonical === undefined ? languages : languages.filter((entry) => entry.tag === canonical);
  if (language !== undefined && selected.length === 0)
    throw new ServiceError("not_found", `The project has no language ${language}.`);
  const counting = countingFromRows(rows[3] as Counting["files"], rows[4] as CountingRow[]);
  const translations = rows[5] as (TranslationStatRow & { language: string })[];
  const suggestions = rows[6] as { string_id: number; language: string }[];
  return {
    revision: Number(rows[0][0].revision),
    settings: settingsFromData((rows[1][0]?.data as string | undefined) ?? null, model),
    counting,
    languages: selected.map((entry) => {
      const data = languageDataFromRows(
        counting,
        translations.filter((row) => row.language === entry.tag),
        suggestions.filter((row) => row.language === entry.tag),
      );
      const counts = countLanguage(counting, data);
      return { ...languageFacts(entry), ...counts.progress, files: counts.files };
    }),
    members: Number(rows[7][0].members),
    lastActivity: rows[7][0].last_activity as number | null,
  };
}

export async function getStatusAsync(
  sql: Sql,
  model: string,
  language?: string,
): Promise<StatusResult> {
  const snapshot = await readProgressSnapshot(sql, model, language);
  return {
    revision: snapshot.revision,
    sourceLanguage: snapshot.settings.sourceLanguage,
    languages: snapshot.languages,
  };
}

export async function listFilesAsync(
  sql: Sql,
  model: string,
  language?: string,
): Promise<FilesResult> {
  if (language === undefined) {
    const rows = await sql.read([
      { sql: ACTIVE_FILES },
      { sql: ACTIVE_STRINGS },
      { sql: AMBIGUITIES },
    ]);
    return sourceFiles(
      countingFromRows(rows[0] as Counting["files"], rows[1] as CountingRow[]),
      ambiguityRows(rows[2]),
    );
  }
  const snapshot = await readProgressSnapshot(sql, model, language);
  const found = snapshot.languages[0];
  return { language: found.tag, files: found.files };
}

const AMBIGUITIES = `SELECT s.id, f.path AS file, s.display_key AS key, s.source, w.message FROM source_warnings w
  JOIN strings s ON s.id = w.string_id JOIN files f ON f.id = s.file_id
  WHERE s.active = 1 AND f.active = 1 AND w.source_hash = s.source_hash AND trim(s.description) = ''
  ORDER BY f.path, s.position LIMIT 200`;
function ambiguityRows(rows: import("./ports.ts").SqlRow[]): SourceAmbiguity[] {
  return rows.map((row) => ({
    id: Number(row.id),
    file: String(row.file),
    key: String(row.key),
    source: fromJson(row.source),
    message: String(row.message),
  }));
}
