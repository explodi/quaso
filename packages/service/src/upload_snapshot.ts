// SPDX-License-Identifier: MIT
import type { PluralOverride, ProjectSettings, UploadRequest } from "@quaso/core";
import { fromJsonOrNull, toJson } from "./db.ts";
import { FOLDER_ROWS, type FolderRow } from "./folders.ts";
import type { Language } from "./languages.ts";
import type { Sql, SqlRow, Statement, SyncSql } from "./ports.ts";
import { PERSON_HISTORY } from "./rename.ts";
import { settingsFromData } from "./settings.ts";
import { RevisionConflict } from "./write.ts";
import type { ExistingSourceString } from "./source_diff.ts";
import type { ProofreadTranslationRow, TranslationRow } from "./translations.ts";

export type UploadFileRow = {
  id: number;
  path: string;
  repo_path: string;
  format: string;
  active: number;
  context: string;
  uploaded_context: string | null;
};
export type UploadSourceRow = ExistingSourceString & {
  file_id: number;
  path: string;
  description?: string;
  file_active: number;
  key_path: string;
  words: number;
  max_length: number | null;
  max_length_locked: number;
  /** JSON `StringArgument[]`, or null for none. */
  arguments: string | null;
};
export type UploadSuggestionRow = {
  string_id: number;
  language: string;
  kind: string;
  status: string;
  source_hash: string;
};
export type UploadGlossaryRow = {
  term: string;
  language: string | null;
  kind: "translate" | "keep";
  translation: string | null;
  case_sensitive: number;
};
export type UploadSnapshot = {
  settings: ProjectSettings;
  hasStrings: boolean;
  files: UploadFileRow[];
  strings: UploadSourceRow[];
  translations: TranslationRow[];
  suggestions: UploadSuggestionRow[];
  humanHistory: { string_id: number; language: string | null; people: number }[];
  renames: { string_id: number; detail: string | null }[];
  languages: Language[];
  glossary: UploadGlossaryRow[];
  nextIds: { file: number; string: number; upload: number; job: number };
  /** Blue translations set aside when their English changed, should it return. */
  proofreadTranslations: ProofreadTranslationRow[];
  folders: FolderRow[];
};

/** String ids per page: a large project's translations are more than one database answer holds. */
export const UPLOAD_PAGE_STRINGS = 500;

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

/**
 * Every row the upload decision can depend on, with `extra` statements read alongside. The
 * strings' own rows (translations, suggestions, history) come in pages of string ids, each
 * checked against the first read's revision: a page that finds the project changed throws
 * `RevisionConflict`, so the upload starts again instead of deciding on two moments at once.
 */
export async function readUploadSnapshot(
  sql: Sql,
  request: UploadRequest,
  model: string,
  options: { extra?: Statement[]; pageStrings?: number } = {},
): Promise<{ revision: number; state: UploadSnapshot; extra: SqlRow[][] }> {
  const base = uploadBaseStatements(request);
  const rows = await sql.read([...base, ...(options.extra ?? [])]);
  const baseRows = rows.slice(0, base.length);
  const revision = baseRows[0][0].revision as number;
  const ids = baseRows[STRINGS].map((row) => row.id as number);
  const pageStrings = options.pageStrings ?? UPLOAD_PAGE_STRINGS;
  const pages: SqlRow[][][] = [];
  for (let offset = 0; offset < ids.length; offset += pageStrings) {
    const page = await sql.read([
      REVISION,
      ...uploadStringStatements(ids.slice(offset, offset + pageStrings)),
    ]);
    const isSameMoment = page[0][0].revision === revision;
    if (!isSameMoment) throw new RevisionConflict();
    pages.push(page.slice(1));
  }
  const snapshot = uploadSnapshotFromRows(baseRows, pages, model);
  return { ...snapshot, extra: rows.slice(base.length) };
}

/** The same rows for the synchronous service, read in one page inside its transaction. */
export function readUploadSnapshotSync(
  sql: SyncSql,
  request: UploadRequest,
  model: string,
): { revision: number; state: UploadSnapshot } {
  const run = (statement: Statement) => sql.query(statement.sql, ...(statement.params ?? []));
  const baseRows = uploadBaseStatements(request).map(run);
  const ids = baseRows[STRINGS].map((row) => row.id as number);
  const pages = ids.length === 0 ? [] : [uploadStringStatements(ids).map(run)];
  return uploadSnapshotFromRows(baseRows, pages, model);
}

/** The index of the strings among `uploadBaseStatements`. */
const STRINGS = 4;

/** The project-wide rows, and the strings the upload's files, limits and renames reach. */
function uploadBaseStatements(request: UploadRequest): Statement[] {
  const paths = new Set([
    ...request.files.map((file) => file.path),
    ...(request.limits ?? []).map((limit) => limit.file),
    ...(request.renames ?? []).flatMap((rename) =>
      rename.file === undefined ? [] : [rename.file],
    ),
  ]);
  // A rename without a file must detect matching keys in every active file.
  const allActive = (request.renames ?? []).some((rename) => rename.file === undefined);
  return [
    REVISION,
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT EXISTS(SELECT 1 FROM strings) AS has_strings" },
    {
      sql: "SELECT id, path, repo_path, format, active, context, uploaded_context FROM files ORDER BY id",
    },
    {
      sql: `SELECT s.id, s.file_id, f.path, f.active AS file_active, s.key, s.key_path,
      s.display_key, s.kind, s.source, s.source_hash, s.words, s.position, s.active,
      s.max_length, s.max_length_locked, s.arguments, s.description FROM strings s JOIN files f ON f.id = s.file_id
      WHERE f.path IN (SELECT value FROM json_each(?)) OR (? = 1 AND f.active = 1) ORDER BY s.id`,
      params: [toJson([...paths]), allActive ? 1 : 0],
    },
    { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
    {
      sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms ORDER BY term_normalized, language, kind, id",
    },
    {
      sql: `SELECT
      COALESCE((SELECT MAX(id) FROM files), 0) + 1 AS file,
      COALESCE((SELECT MAX(id) FROM strings), 0) + 1 AS string,
      COALESCE((SELECT MAX(id) FROM uploads), 0) + 1 AS upload,
      COALESCE((SELECT MAX(id) FROM jobs), 0) + 1 AS job`,
    },
    FOLDER_ROWS,
  ];
}

/** The rows that belong to these strings; every row of a string is in its page. */
function uploadStringStatements(ids: number[]): Statement[] {
  const selected = "SELECT value FROM json_each(?)";
  const scoped = (query: string): Statement => ({ sql: query, params: [toJson(ids)] });
  return [
    scoped(
      `SELECT * FROM translations WHERE string_id IN (${selected}) ORDER BY string_id, language`,
    ),
    scoped(`SELECT string_id, language, kind, status, source_hash FROM suggestions
      WHERE string_id IN (${selected}) ORDER BY id`),
    scoped(`SELECT string_id, language, COUNT(*) AS people FROM history
      WHERE ${PERSON_HISTORY} AND string_id IN (${selected}) GROUP BY string_id, language`),
    scoped(`SELECT string_id, detail FROM history WHERE event = 'source_renamed'
      AND string_id IN (${selected}) ORDER BY id`),
    scoped(`SELECT * FROM proofread_translations WHERE string_id IN (${selected})
      ORDER BY string_id, language, source_hash`),
  ];
}

function uploadSnapshotFromRows(
  rows: SqlRow[][],
  pages: SqlRow[][][],
  model: string,
): { revision: number; state: UploadSnapshot } {
  const paged = (index: number) => pages.flatMap((page) => page[index]);
  const languages = (
    rows[5] as {
      tag: string;
      instructions: string;
      plural_override: string | null;
      created_at: number;
    }[]
  ).map(
    (row): Language => ({
      tag: row.tag,
      instructions: row.instructions,
      pluralOverride: fromJsonOrNull<PluralOverride>(row.plural_override) ?? undefined,
      createdAt: row.created_at,
    }),
  );
  return {
    revision: rows[0][0].revision as number,
    state: {
      settings: settingsFromData((rows[1][0]?.data as string | undefined) ?? null, model),
      hasStrings: rows[2][0].has_strings === 1,
      files: rows[3] as UploadSnapshot["files"],
      strings: rows[STRINGS] as UploadSnapshot["strings"],
      translations: paged(0) as UploadSnapshot["translations"],
      suggestions: paged(1) as UploadSnapshot["suggestions"],
      humanHistory: paged(2) as UploadSnapshot["humanHistory"],
      renames: paged(3) as UploadSnapshot["renames"],
      languages,
      glossary: rows[6] as UploadSnapshot["glossary"],
      nextIds: rows[7][0] as UploadSnapshot["nextIds"],
      proofreadTranslations: paged(4) as UploadSnapshot["proofreadTranslations"],
      folders: rows[8] as FolderRow[],
    },
  };
}
