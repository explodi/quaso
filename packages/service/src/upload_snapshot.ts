// SPDX-License-Identifier: MIT
import type { PluralOverride, ProjectSettings, UploadRequest } from "@quaso/core";
import { fromJsonOrNull, toJson } from "./db.ts";
import type { Language } from "./languages.ts";
import type { Sql, SqlRow, Statement } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import type { ExistingSourceString } from "./source_diff.ts";
import type { TranslationRow } from "./translations.ts";

export type UploadFileRow = {
  id: number;
  path: string;
  repo_path: string;
  format: string;
  active: number;
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
};

/** One consistent read supplies every row the upload decision can depend on. */
export async function readUploadSnapshot(
  sql: Sql,
  request: UploadRequest,
  model: string,
): Promise<{ revision: number; state: UploadSnapshot }> {
  const rows = await sql.read(uploadReadStatements(request));
  return uploadSnapshotFromRows(rows, model);
}

export function uploadReadStatements(request: UploadRequest): Statement[] {
  const paths = new Set([
    ...request.files.map((file) => file.path),
    ...(request.limits ?? []).map((limit) => limit.file),
    ...(request.renames ?? []).flatMap((rename) =>
      rename.file === undefined ? [] : [rename.file],
    ),
  ]);
  // A rename without a file must detect matching keys in every active file.
  const allActive = (request.renames ?? []).some((rename) => rename.file === undefined);
  const params = [toJson([...paths]), allActive ? 1 : 0];
  const selected = `SELECT s.id FROM strings s JOIN files f ON f.id = s.file_id
    WHERE f.path IN (SELECT value FROM json_each(?)) OR (? = 1 AND f.active = 1)`;
  const scoped = (query: string): Statement => ({ sql: query, params });
  return [
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    { sql: "SELECT data FROM settings WHERE id = 1" },
    { sql: "SELECT EXISTS(SELECT 1 FROM strings) AS has_strings" },
    { sql: "SELECT id, path, repo_path, format, active FROM files ORDER BY id" },
    scoped(`SELECT s.id, s.file_id, f.path, f.active AS file_active, s.key, s.key_path,
      s.display_key, s.kind, s.source, s.source_hash, s.words, s.position, s.active,
      s.max_length, s.max_length_locked, s.description FROM strings s JOIN files f ON f.id = s.file_id
      WHERE s.id IN (${selected}) ORDER BY s.id`),
    scoped(
      `SELECT * FROM translations WHERE string_id IN (${selected}) ORDER BY string_id, language`,
    ),
    scoped(`SELECT string_id, language, kind, status, source_hash FROM suggestions
      WHERE string_id IN (${selected}) ORDER BY id`),
    scoped(`SELECT string_id, language, COUNT(*) AS people FROM history
      WHERE actor_type <> 'llm' AND string_id IN (${selected}) GROUP BY string_id, language`),
    scoped(`SELECT string_id, detail FROM history WHERE event = 'source_renamed'
      AND string_id IN (${selected}) ORDER BY id`),
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
  ];
}

export function uploadSnapshotFromRows(
  rows: SqlRow[][],
  model: string,
): { revision: number; state: UploadSnapshot } {
  const languages = (
    rows[9] as {
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
      strings: rows[4] as UploadSnapshot["strings"],
      translations: rows[5] as UploadSnapshot["translations"],
      suggestions: rows[6] as UploadSnapshot["suggestions"],
      humanHistory: rows[7] as UploadSnapshot["humanHistory"],
      renames: rows[8] as UploadSnapshot["renames"],
      languages,
      glossary: rows[10] as UploadSnapshot["glossary"],
      nextIds: rows[11][0] as UploadSnapshot["nextIds"],
    },
  };
}
