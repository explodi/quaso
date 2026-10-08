// SPDX-License-Identifier: MIT
/**
 * Import (design §5.10, CLI-7): existing translation files, read against the English on
 * the server, written through the write path as green or blue. Values identical to the
 * English are skipped (tools such as Crowdin write the English into untranslated
 * entries), values that fail QA-1 are refused and reported, and blue translations stay
 * unless `overwrite`. One guarded commit; a dry run returns the plan without writing.
 */
import {
  canonicalLanguageTag,
  canonicalValue,
  categoriesFor,
  type ErrorDetail,
  errorsOf,
  type ImportRequest,
  type ImportResult,
  JsonSyntaxError,
  type PluralForms,
  readTranslation,
  SourceError,
  type TextValue,
} from "@quaso/core";
import {
  ActorDirectory,
  actorReadStatements,
  type ActorRows,
  type Author,
  authorFor,
  IMPORT_AUTHOR,
} from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, writeRevision, fromJson, toJson, transaction } from "./db.ts";
import { entryFromRow } from "./entries.ts";
import { badRequest, ServiceError } from "./errors.ts";
import { type Facts, loadFacts, overrideOf } from "./facts.ts";
import {
  checkValue,
  planTranslationWrite,
  TRANSLATION_COLUMNS,
  type TranslationRow,
  type TargetString,
} from "./translations.ts";
import type { Sql, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { settingsFromData } from "./settings.ts";
import { type LanguageRow, toLanguage } from "./languages.ts";
import { type GlossaryRow, glossaryTermFromRow } from "./glossary.ts";

type StringRow = TargetString & { file_id: number; key: string; key_path: string };
type ImportSnapshot = {
  files: { id: number; path: string }[];
  strings: StringRow[];
  translations: TranslationRow[];
};

function importReadStatements(request: ImportRequest): Statement[] {
  const paths = toJson(request.files.map((file) => file.path));
  const language = canonicalLanguageTag(request.language) ?? request.language;
  const files =
    "SELECT id FROM files WHERE path IN (SELECT value FROM json_each(?)) AND active = 1";
  return [
    {
      sql: "SELECT id, path FROM files WHERE path IN (SELECT value FROM json_each(?)) AND active = 1",
      params: [paths],
    },
    {
      sql: `SELECT s.id, s.file_id, f.path, s.key, s.key_path, s.display_key, s.kind, s.source, s.source_hash, s.max_length, s.active FROM strings s JOIN files f ON f.id = s.file_id WHERE s.active = 1 AND s.file_id IN (${files}) ORDER BY s.file_id, s.position`,
      params: [paths],
    },
    {
      sql: `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE language = ? AND string_id IN (SELECT id FROM strings WHERE file_id IN (${files}))`,
      params: [language, paths],
    },
  ];
}

/**
 * Imports translation files for one language. Files the instance doesn't know and keys
 * its English doesn't have are reported and skipped. API keys are recorded as the author;
 * anyone else's imports as "Import".
 */
export function importTranslations(
  ctx: Context,
  actor: Actor,
  request: ImportRequest,
): ImportResult {
  const author = actor.type === "token" ? authorFor(ctx, actor) : IMPORT_AUTHOR;
  return transaction(ctx.sql, () => {
    const [files, strings, translations] = importReadStatements(request).map((statement) =>
      ctx.sql.query(statement.sql, ...(statement.params ?? [])),
    );
    const plan = planImport(
      {
        files: files as ImportSnapshot["files"],
        strings: strings as StringRow[],
        translations: translations as TranslationRow[],
      },
      loadFacts(ctx),
      author,
      request,
      writeRevision(ctx.sql),
      ctx.clock(),
    );
    if (plan.statements.length > 0) {
      bumpRevision(ctx.sql);
      for (const statement of plan.statements)
        ctx.sql.run(statement.sql, ...(statement.params ?? []));
    }
    return plan.result;
  });
}

export async function importTranslationsAsync(
  sql: Sql,
  actor: Actor,
  request: ImportRequest,
  now: number,
  model: string,
): Promise<ImportResult> {
  const refs: Statement = {
    sql: "SELECT 'user' AS actor_type, created_by AS actor_id FROM glossary_terms",
  };
  return withRetries(
    sql,
    async () => {
      const [
        revision,
        files,
        strings,
        translations,
        stored,
        languages,
        glossary,
        users,
        tokens,
        authorTokens,
        ...permissionRows
      ] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        ...importReadStatements(request),
        { sql: "SELECT data FROM settings WHERE id = 1" },
        {
          sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
        },
        { sql: "SELECT * FROM glossary_terms ORDER BY term_normalized, language, kind, id" },
        ...actorReadStatements(refs),
        {
          sql: "SELECT name FROM api_tokens WHERE id = ?",
          params: [actor.type === "token" ? actor.tokenId : null],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          revision: Number(revision[0].revision),
          snapshot: {
            files: files as ImportSnapshot["files"],
            strings: strings as StringRow[],
            translations: translations as TranslationRow[],
          },
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: languages as LanguageRow[],
          glossary: glossary as GlossaryRow[],
          actors: { users: users as ActorRows["users"], tokens: tokens as ActorRows["tokens"] },
          author:
            actor.type === "token"
              ? {
                  type: "token" as const,
                  id: actor.tokenId,
                  label: (authorTokens[0]?.name as string | undefined) ?? null,
                }
              : IMPORT_AUTHOR,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("upload");
      const actors = new ActorDirectory(state.actors);
      const settings = settingsFromData(state.stored, model);
      const facts: Facts = {
        sourceLanguage: settings.sourceLanguage,
        syntax: settings.syntax,
        languages: new Map(state.languages.map(toLanguage).map((entry) => [entry.tag, entry])),
        glossary: state.glossary.map((entry) => glossaryTermFromRow(entry, actors)),
      };
      return planImport(state.snapshot, facts, state.author, request, state.revision + 1, now);
    },
  );
}

function planImport(
  snapshot: ImportSnapshot,
  facts: Facts,
  author: Author,
  request: ImportRequest,
  revision: number,
  now: number,
): { statements: Statement[]; result: ImportResult } {
  const language = projectLanguage(facts, request.language);
  const context: ImportFileContext = { snapshot, facts, author, request, language, revision, now };
  const statements: Statement[] = [];
  const result: ImportResult = {
    dryRun: request.dryRun === true,
    language,
    imported: 0,
    unchanged: 0,
    skippedIdentical: 0,
    droppedForms: 0,
    skippedBlue: 0,
    refused: [],
    unknownKeys: [],
    unknownFiles: [],
  };
  const problems: { detail: ErrorDetail; message: string }[] = [];
  const seen = new Set<string>();
  for (const file of request.files) {
    if (seen.has(file.path)) throw badRequest(`The import has ${file.path} twice.`);
    seen.add(file.path);
    try {
      statements.push(...planImportFile(context, file, result));
    } catch (error) {
      if (!(error instanceof JsonSyntaxError || error instanceof SourceError)) throw error;
      const detail: ErrorDetail = { file: file.path, message: error.detail };
      if (error.line !== undefined) detail.line = error.line;
      if (error.column !== undefined) detail.column = error.column;
      problems.push({ detail, message: error.message });
    }
  }
  if (problems.length > 0) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
    throw new ServiceError("invalid_source", `${problems[0].message}${more}`, {
      details: problems.map((problem) => problem.detail),
    });
  }
  if (result.imported > 0) statements.push(importActivity(author, request, result, now));
  return { statements: request.dryRun ? [] : statements, result };
}

/** The request's language, which must be a project language. */
function projectLanguage(facts: Facts, tag: string): string {
  const canonical = canonicalLanguageTag(tag) ?? tag;
  if (canonical === facts.sourceLanguage) {
    throw badRequest(`${tag} is the source language; upload its files instead.`, [
      { language: tag },
    ]);
  }
  if (!facts.languages.has(canonical)) {
    throw badRequest(`The project has no language ${tag}.`, [{ language: tag }]);
  }
  return canonical;
}

type ImportFileContext = {
  snapshot: ImportSnapshot;
  facts: Facts;
  author: Author;
  request: ImportRequest;
  language: string;
  revision: number;
  now: number;
};

function planImportFile(
  context: ImportFileContext,
  file: { path: string; content: string },
  result: ImportResult,
): Statement[] {
  const { snapshot, facts, author, request, language, revision, now } = context;
  const statements: Statement[] = [];
  const fileRow = snapshot.files.find((row) => row.path === file.path);
  if (fileRow === undefined) {
    result.unknownFiles.push(file.path);
    return statements;
  }
  const rows = snapshot.strings.filter((row) => row.file_id === fileRow.id);
  const read = readTranslation(file.content, rows.map(entryFromRow), {
    language,
    file: file.path,
    pluralOverride: facts.languages.get(language)?.pluralOverride,
  });
  for (const key of read.unknownKeys) result.unknownKeys.push({ file: file.path, key });
  const existing = new Map(snapshot.translations.map((row) => [row.string_id, row]));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const actors = new ActorDirectory({ users: [], tokens: [] });
  for (const [key, readValue] of read.values) {
    const row = byKey.get(key);
    if (row === undefined) continue;
    const english = fromJson<TextValue>(row.source);
    const { value, dropped } = withoutUnusedForms(readValue, row, english, facts, language);
    result.droppedForms += dropped;
    if (!request.keepIdentical && identical(value, english)) {
      result.skippedIdentical++;
      continue;
    }
    const errors = errorsOf(checkValue(facts, row, language, value));
    if (errors.length > 0) {
      result.refused.push({ file: file.path, key: row.display_key, language, checks: errors });
      continue;
    }
    const current = existing.get(row.id);
    if (current?.value === canonicalValue(value) && current.colour === request.as) {
      result.unchanged++;
      continue;
    }
    if (current?.colour === "blue" && !request.overwrite) {
      result.skippedBlue++;
      continue;
    }
    const plan = planTranslationWrite(
      {
        stringId: row.id,
        language,
        value,
        colour: request.as,
        actor: author,
        event: "translation_imported",
        detail: { file: file.path },
      },
      {
        string: row,
        existing: current,
        facts,
        actors,
        revision,
        now,
      },
    );
    statements.push(...plan.statements);
    if (plan.result.status === "written") result.imported++;
    else result.unchanged++;
  }
  return statements;
}

/**
 * A plural value without the forms its language doesn't use: tools that copy the English
 * categories write `_one` beside `_other` in Japanese, say. No download ever writes them,
 * so the rest of the value is still a complete translation.
 */
function withoutUnusedForms(
  value: TextValue,
  row: StringRow,
  english: TextValue,
  facts: Facts,
  language: string,
): { value: TextValue; dropped: number } {
  const isPlural = row.kind === "plural" || row.kind === "ordinal";
  if (!isPlural || typeof value === "string" || typeof english === "string") {
    return { value, dropped: 0 };
  }
  const kind = row.kind as "plural" | "ordinal";
  const used = new Set<string>(
    categoriesFor(language, kind, english as PluralForms, overrideOf(facts, language)),
  );
  const forms = Object.entries(value as PluralForms);
  const kept = forms.filter(([category]) => used.has(category));
  return { value: Object.fromEntries(kept) as PluralForms, dropped: forms.length - kept.length };
}

/**
 * Whether a value only repeats the English: the same text, or every form equal to the
 * English form of its category (or the English `other` when English lacks it).
 */
function identical(value: TextValue, english: TextValue): boolean {
  if (typeof value === "string" || typeof english === "string") return value === english;
  const forms = Object.entries(value as PluralForms);
  return (
    forms.length > 0 &&
    forms.every(
      ([category, form]) => form === (english[category as keyof PluralForms] ?? english.other),
    )
  );
}

function importActivity(
  author: Author,
  request: ImportRequest,
  result: ImportResult,
  now: number,
): Statement {
  const summary =
    `Import (${result.language}, ${request.as}): ${result.imported} imported` +
    (result.refused.length > 0 ? `, ${result.refused.length} refused` : "");
  return {
    sql: `INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at)
     VALUES ('import', ?, ?, ?, ?, ?, ?)`,
    params: [
      author.type,
      author.id,
      author.label,
      summary,
      toJson({
        language: result.language,
        as: request.as,
        files: request.files.map((file) => file.path),
        imported: result.imported,
        unchanged: result.unchanged,
        skippedIdentical: result.skippedIdentical,
        skippedBlue: result.skippedBlue,
        refused: result.refused.length,
      }),
      now,
    ],
  };
}
