// SPDX-License-Identifier: MIT
/** File context and string limits use the same guarded snapshot as their permissions. */
import type {
  FileSettings,
  UpdateFileRequest,
  UpdateStringRequest,
  UpdateStringResult,
} from "@quaso/core";
import type { Actor } from "./api.ts";
import { badRequest, notFound } from "./errors.ts";
import { toLanguage, type LanguageRow } from "./languages.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql, Statement } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import { fileSettings, type FileRow } from "./settings_api.ts";
import { planQa, type QaRow } from "./translations.ts";
import { withRetries } from "./write.ts";

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export async function updateFileAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  request: UpdateFileRequest,
  now: number,
): Promise<FileSettings> {
  return withRetries(
    sql,
    async () => {
      const [revision, files, ...permissionRows] = await sql.read([
        REVISION,
        {
          sql: "SELECT id, path, context, generated_context FROM files WHERE id = ?",
          params: [id],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          file: files[0] as FileRow | undefined,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ file, permissions }) => {
      permissions.require("context");
      if (!file) throw notFound(`File ${id}`);
      const context = request.context ?? file.context;
      if (context === file.context) return { statements: [], result: fileSettings(file) };
      return {
        statements: [
          {
            sql: "UPDATE files SET context = ?, updated_at = ? WHERE id = ?",
            params: [context, now, id],
          },
        ],
        result: fileSettings({ ...file, context }),
      };
    },
  );
}

type StringRow = {
  id: number;
  description: string;
  max_length: number | null;
  max_length_locked: number;
};

export async function updateStringAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  request: UpdateStringRequest,
  now: number,
  model: string,
): Promise<UpdateStringResult> {
  return withRetries(
    sql,
    async () => {
      const [revision, strings, stored, languages, glossary, translations, ...permissionRows] =
        await sql.read([
          REVISION,
          {
            sql: "SELECT id, description, max_length, max_length_locked FROM strings WHERE id = ? AND kind IN ('text', 'plural', 'ordinal')",
            params: [id],
          },
          { sql: "SELECT data FROM settings WHERE id = 1" },
          { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
          { sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms" },
          {
            sql: "SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source, s.max_length FROM translations t JOIN strings s ON s.id = t.string_id WHERE s.id = ? AND s.kind IN ('text', 'plural', 'ordinal')",
            params: [id],
          },
          ...permissionReadStatements(actor),
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          string: strings[0] as StringRow | undefined,
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: (languages as LanguageRow[]).map(toLanguage),
          glossary,
          translations: translations as QaRow[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("settings");
      const current = state.string;
      if (!current) throw notFound(`String ${id}`);
      const description = request.description ?? current.description;
      const limitChanged =
        request.maxLength !== undefined && request.maxLength !== current.max_length;
      if (limitChanged && current.max_length_locked === 1)
        throw badRequest(
          "This string's length limit is set by the CLI config: change it there, then upload.",
          [{ path: "maxLength", message: "set by the CLI config" }],
        );
      const maxLength = request.maxLength === undefined ? current.max_length : request.maxLength;
      const result = {
        id,
        description,
        maxLength,
        maxLengthLocked: current.max_length_locked === 1,
      };
      if (description === current.description && !limitChanged) return { statements: [], result };
      const statements: Statement[] = [
        {
          sql: "UPDATE strings SET description = ?, max_length = ?, updated_at = ? WHERE id = ?",
          params: [description, maxLength, now, id],
        },
      ];
      if (limitChanged) {
        const settings = settingsFromData(state.stored, model);
        statements.push(
          ...planQa(
            state.translations.map((row) => ({ ...row, max_length: maxLength })),
            {
              sourceLanguage: settings.sourceLanguage,
              syntax: settings.syntax,
              languages: new Map(state.languages.map((language) => [language.tag, language])),
              glossary: state.glossary.map((row) => ({
                term: row.term as string,
                language: row.language as string | null,
                kind: row.kind as "translate" | "keep",
                translation: row.translation as string | null,
                caseSensitive: row.case_sensitive === 1,
              })),
            },
          ),
        );
      }
      return { statements, result };
    },
  );
}
