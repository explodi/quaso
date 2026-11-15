// SPDX-License-Identifier: MIT
/**
 * Progress counts (design §5.9, CLI-6) per language and per file. The database counts: it
 * answers with a row per language and file, where reading every translation to count it
 * here was megabytes on each write of a large project. The counts are kept until the next
 * write, since the public pages ask for them on every view.
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
import type { MemoryCache } from "./cache.ts";
import type { Sql, Statement, SyncSql } from "./ports.ts";
import { loadSettings, settingsFromData } from "./settings.ts";
import { ServiceError } from "./errors.ts";

type FileRow = {
  id: number;
  path: string;
  repo_path: string;
  source_updated_at: number;
  source_revision: number;
};
type SourceCountRow = { file_id: number; strings: number; words: number };
type TranslationCountRow = {
  language: string;
  file_id: number;
  translated: number;
  translated_words: number;
  blue: number;
  blue_words: number;
  outdated: number;
  qa: number;
};
type PendingCountRow = { language: string; file_id: number; pending: number };

/** The files progress is counted over, each with its translatable, active strings and words. */
export interface Counting {
  files: (FileRow & { strings: number; words: number })[];
}

/** What progress counts: the translatable, active strings (`s`) of active files (`f`). */
const COUNTED = `s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`;

const ACTIVE_FILES =
  "SELECT id, path, repo_path, source_updated_at, source_revision FROM files WHERE active = 1 ORDER BY path";
const SOURCE_COUNTS = `SELECT s.file_id, COUNT(*) AS strings, SUM(s.words) AS words FROM strings s
  JOIN files f ON f.id = s.file_id WHERE ${COUNTED} GROUP BY s.file_id`;

/** The translations of the counted strings per language and file; `scope` narrows the languages. */
function translationCounts(scope = ""): string {
  return `SELECT t.language, s.file_id, COUNT(*) AS translated, SUM(s.words) AS translated_words,
    SUM(t.colour = 'blue') AS blue,
    SUM(CASE WHEN t.colour = 'blue' THEN s.words ELSE 0 END) AS blue_words,
    SUM(t.source_hash <> s.source_hash) AS outdated,
    SUM(t.qa_errors > 0 OR t.extra_checks <> '[]') AS qa
    FROM translations t JOIN strings s ON s.id = t.string_id JOIN files f ON f.id = s.file_id
    WHERE ${COUNTED}${scope} GROUP BY t.language, s.file_id`;
}

/** The counted strings with a pending suggestion, per language and file. */
function pendingCounts(scope = ""): string {
  return `SELECT t.language, s.file_id, COUNT(DISTINCT t.string_id) AS pending
    FROM suggestions t JOIN strings s ON s.id = t.string_id JOIN files f ON f.id = s.file_id
    WHERE t.status = 'pending' AND ${COUNTED}${scope} GROUP BY t.language, s.file_id`;
}

/** Narrows either count to one language: both name the rows they count `t`. */
const ONE_LANGUAGE = " AND t.language = ?";

/** Loads the active files with the counts of their translatable, active strings. */
export function loadCounting(ctx: Context): Counting {
  return countingFromRows(
    ctx.sql.query<FileRow>(ACTIVE_FILES),
    ctx.sql.query<SourceCountRow>(SOURCE_COUNTS),
  );
}

function countingFromRows(files: FileRow[], sources: SourceCountRow[]): Counting {
  const counts = new Map(sources.map((row) => [row.file_id, row]));
  return {
    files: files.map((file) => ({
      ...file,
      strings: counts.get(file.id)?.strings ?? 0,
      words: counts.get(file.id)?.words ?? 0,
    })),
  };
}

/** Progress added up one file at a time. */
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

  add(
    file: Counting["files"][number],
    translations: TranslationCountRow | undefined,
    pending: number,
  ): void {
    const translated = translations?.translated ?? 0;
    const translatedWords = translations?.translated_words ?? 0;
    const blue = translations?.blue ?? 0;
    const progress = this.progress;
    progress.strings += file.strings;
    progress.words += file.words;
    progress.untranslated += file.strings - translated;
    progress.wordsLeft += file.words - translatedWords;
    progress.green += translated - blue;
    progress.blue += blue;
    progress.outdated += translations?.outdated ?? 0;
    progress.qa += translations?.qa ?? 0;
    progress.pending += pending;
    this.#translatedWords += translatedWords;
    this.#blueWords += translations?.blue_words ?? 0;
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

/** A language's counts in all and per file, from the database's counts of that language. */
function countLanguage(
  counting: Counting,
  translations: TranslationCountRow[],
  pending: PendingCountRow[],
): LanguageCounts {
  const translationsOf = new Map(translations.map((row) => [row.file_id, row]));
  const pendingOf = new Map(pending.map((row) => [row.file_id, row.pending]));
  const total = new Tally();
  const files = counting.files.map((file) => {
    const tally = new Tally();
    const fileTranslations = translationsOf.get(file.id);
    const filePending = pendingOf.get(file.id) ?? 0;
    tally.add(file, fileTranslations, filePending);
    total.add(file, fileTranslations, filePending);
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
    counts = countLanguage(
      cache.counting,
      ctx.sql.query<TranslationCountRow>(translationCounts(ONE_LANGUAGE), language.tag),
      ctx.sql.query<PendingCountRow>(pendingCounts(ONE_LANGUAGE), language.tag),
    );
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
    files: counting.files.map((file) => ({
      id: file.id,
      path: file.path,
      repoPath: file.repo_path,
      strings: file.strings,
      words: file.words,
      updatedAt: file.source_updated_at,
      revision: file.source_revision,
    })),
  };
}

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export interface ProgressSnapshot {
  revision: number;
  settings: ProjectSettings;
  counting: Counting;
  languages: (LanguageProgress & { files: FileProgress[] })[];
  members: number;
  lastActivity: number | null;
}

/**
 * The project's progress, from `cache` while the revision stays the same: reading it means
 * reading every string and translation, and the editor asks for it every few seconds. A changed
 * revision is a new key, so the snapshot is never older than the revision it's stored under.
 */
export async function readProgressSnapshot(
  sql: Sql,
  model: string,
  language?: string,
  cache?: MemoryCache,
): Promise<ProgressSnapshot> {
  if (cache === undefined) return readProgress(sql, model, language);
  const canonical = language === undefined ? null : canonicalLanguageTag(language);
  const [rows] = await sql.read([REVISION]);
  const key = ["progress", Number(rows[0].revision), model, canonical];
  return cache.remember(key, () => readProgress(sql, model, language));
}

/** The revision and every count come from the same read batch. */
async function readProgress(sql: Sql, model: string, language?: string): Promise<ProgressSnapshot> {
  const canonical = language === undefined ? undefined : canonicalLanguageTag(language);
  const scope = canonical === undefined ? "" : ONE_LANGUAGE;
  const params = canonical === undefined ? [] : [canonical];
  const rows = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    { sql: ACTIVE_FILES },
    { sql: SOURCE_COUNTS },
    { sql: translationCounts(scope), params },
    { sql: pendingCounts(scope), params },
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
  const counting = countingFromRows(rows[3] as FileRow[], rows[4] as SourceCountRow[]);
  const translations = Map.groupBy(rows[5] as TranslationCountRow[], (row) => row.language);
  const pending = Map.groupBy(rows[6] as PendingCountRow[], (row) => row.language);
  return {
    revision: Number(rows[0][0].revision),
    settings: settingsFromData((rows[1][0]?.data as string | undefined) ?? null, model),
    counting,
    languages: selected.map((entry) => {
      const counts = countLanguage(
        counting,
        translations.get(entry.tag) ?? [],
        pending.get(entry.tag) ?? [],
      );
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
  cache?: MemoryCache,
): Promise<StatusResult> {
  const snapshot = await readProgressSnapshot(sql, model, language, cache);
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
  cache?: MemoryCache,
): Promise<FilesResult> {
  if (language === undefined) {
    if (cache === undefined) return readSourceFiles(sql);
    const [rows] = await sql.read([REVISION]);
    return cache.remember(["sourceFiles", Number(rows[0].revision)], () => readSourceFiles(sql));
  }
  const snapshot = await readProgressSnapshot(sql, model, language, cache);
  const found = snapshot.languages[0];
  return { language: found.tag, files: found.files };
}

async function readSourceFiles(sql: Sql): Promise<FilesResult> {
  const rows = await sql.read([
    { sql: ACTIVE_FILES },
    { sql: SOURCE_COUNTS },
    { sql: AMBIGUITIES },
  ]);
  return sourceFiles(
    countingFromRows(rows[0] as FileRow[], rows[1] as SourceCountRow[]),
    ambiguityRows(rows[2]),
  );
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
