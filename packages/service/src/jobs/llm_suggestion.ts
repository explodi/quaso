// SPDX-License-Identifier: MIT
/**
 * LLM suggestions for the editor: a few strings translated with a job's prompt, context and
 * quality checks, returned to the person translating them by hand and never saved. The
 * requests' tokens count like a job's, so the usage page and the monthly budget see them.
 *
 * Someone is waiting for the answer, so a request asks for as little thinking as the model
 * allows, never retries, and ends at a deadline.
 */
import {
  canonicalLanguageTag,
  isDocumentKey,
  type LlmSuggestion,
  type LlmSuggestionsRequest,
  type LlmSuggestionsResult,
  MAX_LLM_SUGGESTIONS,
  type TextValue,
  type TranslatableKind,
} from "@quaso/core";
import { ActorDirectory } from "../actors.ts";
import type { Actor } from "../api.ts";
import { fromJson } from "../db.ts";
import { TRANSLATABLE_SQL } from "../entries.ts";
import { notFound, ServiceError } from "../errors.ts";
import type { Facts } from "../facts.ts";
import { glossaryTermFromRow, type GlossaryRow } from "../glossary.ts";
import { toLanguage, type LanguageRow } from "../languages.ts";
import type { TranslationProvider } from "../llm/provider.ts";
import { permissionReadStatements, permissionsFromRows } from "../permissions.ts";
import type { Clock, Logger, Sql } from "../ports.ts";
import { settingsFromData } from "../settings.ts";
import { translateBatch } from "./batch_runner.ts";
import { budgetExceeded, llmUnavailable } from "./jobs.ts";
import { promptContextAsync } from "./prompts.ts";
import { monthlyUsage, type RequestRecord } from "./usage.ts";
import { batchesOf, type WorkItem } from "./work.ts";

/** How long all the requests of one call may take. */
export const SUGGESTION_DEADLINE_MS = 30_000;

export interface LlmSuggestionOptions {
  provider: TranslationProvider | null;
  /** The default model, for settings that don't name one. */
  model: string;
  monthlyTokenBudget: number | null;
  clock: Clock;
  logger: Logger;
  /** Stores the provider request in `llm_requests`; returns its ID. */
  record(entry: RequestRecord): Promise<number> | number;
  /** Default: `SUGGESTION_DEADLINE_MS`. */
  deadlineMs?: number;
}

type StringRow = {
  id: number;
  file_id: number;
  path: string;
  position: number;
  key: string;
  display_key: string;
  kind: TranslatableKind;
  source: string;
  source_hash: string;
  max_length: number | null;
  description: string;
  words: number;
};

/**
 * People who may edit the language. One request per file, because a prompt is about one
 * file's strings; a string that gets no suggestion is in `failed` and doesn't hold up the others.
 */
export async function suggestWithLlm(
  sql: Pick<Sql, "read">,
  actor: Actor,
  input: LlmSuggestionsRequest,
  options: LlmSuggestionOptions,
): Promise<LlmSuggestionsResult> {
  const tag = canonicalLanguageTag(input.language) ?? input.language;
  const [settingsRows, languageRows, glossaryRows, stringRows, monthlyRows, ...permissionRows] =
    await sql.read([
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
      { sql: "SELECT * FROM glossary_terms" },
      {
        sql: `SELECT s.id, s.file_id, f.path, s.position, s.key, s.display_key, s.kind, s.source,
                s.source_hash, s.max_length, s.description, s.words
              FROM strings s JOIN files f ON f.id = s.file_id
              WHERE s.id IN (SELECT value FROM json_each(?)) AND s.active = 1 AND f.active = 1
                AND s.kind IN (${TRANSLATABLE_SQL})
              ORDER BY s.file_id, s.position`,
        params: [JSON.stringify(input.ids)],
      },
      monthlyUsage(options.clock()),
      ...permissionReadStatements(actor),
    ]);
  permissionsFromRows(actor, permissionRows).require("edit", tag);

  const provider = options.provider;
  if (provider === null) throw llmUnavailable();
  const used = Number(monthlyRows[0]?.n ?? 0);
  const budgetUsedUp = options.monthlyTokenBudget !== null && used >= options.monthlyTokenBudget;
  if (budgetUsedUp) throw budgetExceeded();

  const languages = (languageRows as LanguageRow[]).map(toLanguage);
  if (!languages.some((language) => language.tag === tag)) {
    throw notFound(`The language ${input.language}`);
  }

  const settings = settingsFromData(
    (settingsRows[0]?.data as string | undefined) ?? null,
    options.model,
  );
  const facts: Facts = {
    sourceLanguage: settings.sourceLanguage,
    syntax: settings.syntax,
    languages: new Map(languages.map((language) => [language.tag, language])),
    glossary: (glossaryRows as GlossaryRow[]).map((row) =>
      glossaryTermFromRow(row, new ActorDirectory({ users: [], tokens: [] })),
    ),
  };
  const deadline = AbortSignal.timeout(options.deadlineMs ?? SUGGESTION_DEADLINE_MS);
  const suggestions = new Map<number, LlmSuggestion>();
  const reasons = new Map<number, string>();
  let refusedKey = false;

  const items = (stringRows as StringRow[]).map((string) => workItem(string, tag));
  await Promise.all(
    batchesOf(items, MAX_LLM_SUGGESTIONS).map(async (batch) => {
      const context = await promptContextAsync(sql, settings, facts, batch, "");
      const result = await translateBatch({
        provider,
        settings,
        facts,
        context,
        batch,
        model: settings.llm.suggestionModel || settings.llm.model,
        clock: options.clock,
        canRequest: () => true,
        record: (entry) => options.record({ ...entry, jobId: null, provider: provider.name }),
        pauseForAuth(error) {
          refusedKey = true;
          options.logger.error("The provider refused the API key for an LLM suggestion", {
            error: error.message,
          });
        },
        retries: 0,
        thinking: "low",
        signal: deadline,
      });
      for (const [id, success] of result.successes) {
        suggestions.set(id, { id, value: success.value, model: success.model });
      }
      for (const [id, reason] of result.failures) reasons.set(id, reason);
    }),
  );

  if (refusedKey) {
    throw new ServiceError("llm_unavailable", "The LLM provider refused the API key.");
  }
  const whyNot = (id: number) =>
    deadline.aborted
      ? "The LLM took too long to answer."
      : (reasons.get(id) ?? `String ${id} wasn't found, or isn't translated.`);
  return {
    suggestions: input.ids.flatMap((id) => suggestions.get(id) ?? []),
    failed: input.ids
      .filter((id) => !suggestions.has(id))
      .map((id) => ({ id, message: whyNot(id) })),
  };
}

/** Always a fresh translation: the person is writing their own, so the current one isn't shown. */
function workItem(string: StringRow, language: string): WorkItem {
  return {
    stringId: string.id,
    language,
    fileId: string.file_id,
    path: string.path,
    position: string.position,
    key: string.display_key,
    kind: string.kind,
    document: isDocumentKey(string.key),
    english: fromJson<TextValue>(string.source),
    sourceHash: string.source_hash,
    maxLength: string.max_length,
    description: string.description,
    words: string.words,
    action: "translate",
    revision: 0,
    current: null,
    outdatedEnglish: null,
  };
}
