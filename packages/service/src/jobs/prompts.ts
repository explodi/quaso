// SPDX-License-Identifier: MIT
/**
 * A batch's prompt context (design §5.6, LLM-5): the project's and the language's
 * instructions, the file and its context, the neighbours with their current translations,
 * the same strings in other languages, proofread translations of identical English, and
 * what each reference stands for. The reads finish before the provider request.
 */
import { type ProjectSettings, referencesOf, type TextValue } from "@quaso/core";
import type { Context } from "../context.ts";
import { chunks, fromJson, placeholders } from "../db.ts";
import { TRANSLATABLE_SQL } from "../entries.ts";
import { glossaryTermFromRow, matchingGlossary, type GlossaryRow } from "../glossary.ts";
import { ActorDirectory } from "../actors.ts";
import type { Sql, SqlRow, Statement } from "../ports.ts";
import { glossaryText } from "../llm/prompt.ts";
import type { Facts } from "../facts.ts";
import type { PromptContext, PromptString, ReferenceHint } from "../llm/prompt.ts";
import type { Batch, WorkItem } from "./work.ts";

/** The most identical-English translations a prompt shows. */
const MAX_IDENTICAL = 30;

/** A work item as the prompt shows it. */
export function promptString(item: WorkItem): PromptString {
  const string: PromptString = {
    id: item.stringId,
    key: item.key,
    kind: item.kind,
    english: item.english,
    description: item.description,
    maxLength: item.maxLength,
  };
  if (item.action !== "translate" && item.current !== null) string.outdated = item.current;
  return string;
}

/** The file's context: written by a person, or generated and cached; "" otherwise. */
export function fileContextOf(
  ctx: Context,
  fileId: number,
): {
  context: string;
  generated: string | null;
} {
  const [row] = ctx.sql.query<{ context: string; generated_context: string | null }>(
    "SELECT context, generated_context FROM files WHERE id = ?",
    fileId,
  );
  return { context: row?.context ?? "", generated: row?.generated_context ?? null };
}

/** Everything a batch's prompt needs besides its strings. */
export function promptContext(
  ctx: Context,
  settings: ProjectSettings,
  facts: Facts,
  batch: Batch,
  customInstruction: string,
): PromptContext {
  const plan = promptContextPlan(settings, facts, batch, customInstruction);
  return plan.build(
    plan.statements.map((statement) => ctx.sql.query(statement.sql, ...(statement.params ?? []))),
  );
}

export async function promptContextAsync(
  sql: Sql,
  settings: ProjectSettings,
  facts: Facts,
  batch: Batch,
  customInstruction: string,
): Promise<PromptContext> {
  const plan = promptContextPlan(settings, facts, batch, customInstruction);
  return plan.build(await sql.read(plan.statements));
}

/** Both ports use the same query plan and decoding, including optional context. */
function promptContextPlan(
  settings: ProjectSettings,
  facts: Facts,
  batch: Batch,
  customInstruction: string,
) {
  const statements: Statement[] = [];
  const select = (statement: Statement) => {
    const index = statements.length;
    statements.push(statement);
    return index;
  };
  const language = facts.languages.get(batch.language);
  const ids = batch.items.map((item) => item.stringId);
  const file = select({
    sql: "SELECT context, generated_context FROM files WHERE id = ?",
    params: [batch.fileId],
  });
  const otherTags = settings.llm.context.otherLanguages.filter(
    (tag) => tag !== batch.language && facts.languages.has(tag),
  );
  const other = select({
    sql: `SELECT t.string_id, t.language, t.value, t.colour FROM translations t
      JOIN strings s ON s.id = t.string_id AND s.source_hash = t.source_hash
      WHERE t.string_id IN (SELECT value FROM json_each(?))
        AND t.language IN (SELECT value FROM json_each(?)) ORDER BY t.string_id, t.language`,
    params: [JSON.stringify(ids), JSON.stringify(otherTags)],
  });
  const identical: number[] = [];
  if (settings.llm.context.identicalStrings) {
    for (const hashes of chunks([...new Set(batch.items.map((item) => item.sourceHash))], 97)) {
      identical.push(
        select({
          sql: `SELECT s.source, t.value FROM strings s JOIN translations t ON t.string_id = s.id AND t.language = ?
          WHERE s.source_hash IN (${placeholders(hashes.length)}) AND s.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})
            AND t.colour = 'blue' AND t.source_hash = s.source_hash
            AND s.id NOT IN (SELECT value FROM json_each(?)) ORDER BY s.id LIMIT ?`,
          params: [batch.language, ...hashes, JSON.stringify(ids), MAX_IDENTICAL],
        }),
      );
    }
  }
  const neighbours: number[] = [];
  if (settings.llm.neighbours > 0 && batch.items.length > 0) {
    for (const edge of [
      { condition: "<", order: "DESC", position: batch.items[0].position },
      { condition: ">", order: "ASC", position: batch.items.at(-1)!.position },
    ]) {
      neighbours.push(
        select({
          sql: `SELECT s.display_key, s.source, t.value FROM strings s
          LEFT JOIN translations t ON t.string_id = s.id AND t.language = ?
          WHERE s.file_id = ? AND s.active = 1 AND s.kind IN (${TRANSLATABLE_SQL}) AND s.position ${edge.condition} ?
          ORDER BY s.position ${edge.order} LIMIT ?`,
          params: [batch.language, batch.fileId, edge.position, settings.llm.neighbours],
        }),
      );
    }
  }
  const references = new Map<string, number>();
  const texts = batch.items.flatMap((item) =>
    typeof item.english === "string" ? [item.english] : Object.values(item.english),
  );
  for (const text of texts) {
    for (const reference of referencesOf(text ?? "", facts.syntax)) {
      if (references.has(reference.raw)) continue;
      const target = reference.namespace !== undefined ? `${reference.namespace}.json` : batch.path;
      references.set(
        reference.raw,
        select({
          sql: `SELECT s.source, t.value FROM strings s JOIN files f ON f.id = s.file_id
          LEFT JOIN translations t ON t.string_id = s.id AND t.language = ?
          WHERE f.path = ? AND s.display_key = ? AND s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})
          ORDER BY s.kind = 'text' DESC LIMIT 1`,
          params: [batch.language, target, reference.key],
        }),
      );
    }
  }
  const glossary = settings.llm.context.glossary
    ? select({
        sql: "SELECT * FROM glossary_terms WHERE language IS NULL OR language = ? ORDER BY term_normalized, language, kind, id",
        params: [batch.language],
      })
    : null;

  return {
    statements,
    build(rows: SqlRow[][]): PromptContext {
      const fileRow = rows[file][0];
      const writtenContext = String(fileRow?.context ?? "");
      const fileContext =
        writtenContext.trim() !== ""
          ? writtenContext
          : settings.llm.context.fileContext
            ? String(fileRow?.generated_context ?? "")
            : "";
      const identicalStrings: PromptContext["identicalStrings"] = [];
      const seen = new Set<string>();
      for (const index of identical) {
        for (const row of rows[index]) {
          const key = `${row.source}\n${row.value}`;
          if (seen.has(key) || identicalStrings.length >= MAX_IDENTICAL) continue;
          seen.add(key);
          identicalStrings.push({
            english: fromJson<TextValue>(row.source),
            translation: fromJson<TextValue>(row.value),
          });
        }
      }
      const hints = new Map<string, ReferenceHint>();
      for (const [raw, index] of references) {
        const found = rows[index][0];
        hints.set(raw, {
          english: found ? textOf(fromJson<TextValue>(found.source)) : null,
          translation: found?.value ? textOf(fromJson<TextValue>(found.value)) : null,
        });
      }
      const neighbourRows =
        neighbours.length === 0
          ? []
          : [...[...rows[neighbours[0]]].reverse(), ...rows[neighbours[1]]];
      const actors = new ActorDirectory({ users: [], tokens: [] });
      const terms =
        glossary === null
          ? []
          : (rows[glossary] as GlossaryRow[]).map((row) => glossaryTermFromRow(row, actors));
      return {
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: batch.language,
        syntax: facts.syntax,
        pluralOverride: language?.pluralOverride,
        projectName: settings.name,
        projectDescription: settings.description,
        projectInstructions: settings.llm.projectInstructions,
        languageInstructions: language?.instructions ?? "",
        fileName: batch.path,
        fileContext,
        otherLanguages: rows[other].map((row) => ({
          id: Number(row.string_id),
          language: String(row.language),
          value: fromJson<TextValue>(row.value),
          proofread: row.colour === "blue",
        })),
        identicalStrings,
        neighbours: neighbourRows.map((row) => ({
          key: String(row.display_key),
          english: fromJson<TextValue>(row.source),
          translation: row.value === null ? null : fromJson<TextValue>(row.value),
        })),
        references: hints,
        glossary: glossaryText(matchingGlossary(terms, batch.language, texts)),
        customInstruction: customInstruction.trim(),
      };
    },
  };
}

function textOf(value: TextValue): string | null {
  return typeof value === "string" ? value : (value.other ?? null);
}

/** The English of a file's first strings, for generating its context. */
export function fileEnglish(ctx: Context, fileId: number, limit = 200): string {
  const statement = fileEnglishStatement(fileId, limit);
  return fileEnglishFromRows(ctx.sql.query(statement.sql, ...(statement.params ?? [])));
}

export function fileEnglishStatement(fileId: number, limit = 200): Statement {
  return {
    sql: `SELECT display_key, source FROM strings
     WHERE file_id = ? AND active = 1 AND kind IN (${TRANSLATABLE_SQL})
     ORDER BY position LIMIT ?`,
    params: [fileId, limit],
  };
}

export function fileEnglishFromRows(rows: SqlRow[]): string {
  return rows
    .map((row) => JSON.stringify({ key: row.display_key, english: fromJson(row.source) }))
    .join("\n");
}
