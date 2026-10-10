// SPDX-License-Identifier: MIT
/**
 * LLM suggestions for the editor: one string translated with a job's prompt, context and
 * quality checks, returned to the person translating it by hand and never saved. The
 * request's tokens count like a job's, so the usage page and the monthly budget see them.
 */
import {
  canonicalLanguageTag,
  type LlmSuggestion,
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
import type { Batch } from "./work.ts";

export interface LlmSuggestionOptions {
  provider: TranslationProvider | null;
  /** The default model, for settings that don't name one. */
  model: string;
  monthlyTokenBudget: number | null;
  clock: Clock;
  logger: Logger;
  /** Stores the provider request in `llm_requests`; returns its ID. */
  record(entry: RequestRecord): Promise<number> | number;
}

type StringRow = {
  id: number;
  file_id: number;
  path: string;
  position: number;
  display_key: string;
  kind: TranslatableKind;
  source: string;
  source_hash: string;
  max_length: number | null;
  description: string;
  words: number;
};

/** People who may edit the language: the suggestion is for typing a translation faster. */
export async function suggestWithLlm(
  sql: Pick<Sql, "read">,
  actor: Actor,
  input: { id: number; language: string },
  options: LlmSuggestionOptions,
): Promise<LlmSuggestion> {
  const tag = canonicalLanguageTag(input.language) ?? input.language;
  const permissionStatements = permissionReadStatements(actor);
  const [settingsRows, languageRows, glossaryRows, stringRows, monthlyRows, ...permissionRows] =
    await sql.read([
      { sql: "SELECT data FROM settings WHERE id = 1" },
      { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
      { sql: "SELECT * FROM glossary_terms" },
      {
        sql: `SELECT s.id, s.file_id, f.path, s.position, s.display_key, s.kind, s.source,
                s.source_hash, s.max_length, s.description, s.words
              FROM strings s JOIN files f ON f.id = s.file_id
              WHERE s.id = ? AND s.active = 1 AND f.active = 1 AND s.kind IN (${TRANSLATABLE_SQL})`,
        params: [input.id],
      },
      monthlyUsage(options.clock()),
      ...permissionStatements,
    ]);
  permissionsFromRows(actor, permissionRows).require("edit", tag);

  const provider = options.provider;
  if (provider === null) throw llmUnavailable();
  const used = Number(monthlyRows[0]?.n ?? 0);
  const budgetUsedUp = options.monthlyTokenBudget !== null && used >= options.monthlyTokenBudget;
  if (budgetUsedUp) throw budgetExceeded();

  const string = stringRows[0] as StringRow | undefined;
  if (string === undefined) throw notFound(`String ${input.id}`);
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
  // Always a fresh translation: the person is writing their own, so the current one isn't
  // shown to the LLM as text to update.
  const batch: Batch = {
    language: tag,
    fileId: string.file_id,
    path: string.path,
    items: [
      {
        stringId: string.id,
        language: tag,
        fileId: string.file_id,
        path: string.path,
        position: string.position,
        key: string.display_key,
        kind: string.kind,
        english: fromJson<TextValue>(string.source),
        sourceHash: string.source_hash,
        maxLength: string.max_length,
        description: string.description,
        words: string.words,
        action: "translate",
        revision: 0,
        current: null,
      },
    ],
  };
  const context = await promptContextAsync(sql, settings, facts, batch, "");
  const model = settings.llm.model;
  let refusedKey = false;
  const result = await translateBatch({
    provider,
    settings,
    facts,
    context,
    batch,
    model,
    clock: options.clock,
    canRequest: () => true,
    record: (entry) => options.record({ ...entry, jobId: null, provider: provider.name }),
    pauseForAuth(error) {
      refusedKey = true;
      options.logger.error("The provider refused the API key for an LLM suggestion", {
        error: error.message,
      });
    },
  });

  const success = result.successes.get(string.id);
  if (success !== undefined) return { value: success.value, model: success.model };
  if (refusedKey) {
    throw new ServiceError("llm_unavailable", "The LLM provider refused the API key.");
  }
  const reason = result.failures.get(string.id) ?? "No translation was returned.";
  throw new ServiceError("unavailable", `The LLM has no suggestion: ${reason}`);
}
