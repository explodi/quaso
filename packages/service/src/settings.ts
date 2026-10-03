// SPDX-License-Identifier: MIT
/**
 * The project's settings (design §5.3): one row of JSON, validated with `ProjectSettings`
 * from core. Fields a stored row lacks (after an upgrade, say) come from the defaults.
 */
import { DEFAULT_SYNTAX, formatIssue, ProjectSettings, sha256Hex, validate } from "@quaso/core";
import type { Context } from "./context.ts";
import { fromJson, toJson } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { validateInput } from "./validation.ts";
import type { Sql } from "./ports.ts";
import { DEFAULT_FILE_HISTORY_DAYS } from "./file_retention.ts";
import { DEFAULT_BACKUP_DAYS } from "./stored_backups.ts";

/**
 * The default prompt for LLM translation (design §5.6), with the `%placeholders%` of
 * `PROMPT_PLACEHOLDERS`, stable parts first so that the provider's prompt caching can reuse
 * them: the fixed rules, then the project's and the language's instructions (the system
 * instruction, above the line `---STRINGS---`), then the file, the optional context, the
 * strings and the run's own instruction. `llm/prompt.ts` renders it: lines starting with
 * `%%` are notes that are never sent, and a paragraph with an empty placeholder is left out.
 */
export const DEFAULT_PROMPT_TEMPLATE = `%% Notes like this one (lines that start with %%) are never sent. Everything above the
%% line ---STRINGS--- is the system instruction: the stable part, which the provider can
%% cache. A paragraph (lines between blank lines) with an empty placeholder is left out.
You are a professional translator of games and apps. You translate the texts of %projectName% from %sourceLanguage% into %targetLanguage%.

Rules:
- Translate each string's English into natural %targetLanguage%, as a native speaker would write it for this game or app, keeping its meaning and tone.
- Keep every placeholder in double braces, such as {{count}} or {{name}}, exactly as written: the same name, spelling, spaces and braces, as many times as in the English. You may move it within the sentence. Never translate what is inside the braces.
- Keep every locked token, such as ⟦1⟧, exactly as often as in the English. It stands for a text inserted later: "references" says which.
- Never translate keys or IDs.
- For a plural string, give exactly the forms listed in its "forms", no more and no fewer, each one grammatical in %targetLanguage% for the example numbers given.
- Respect "maxLength": the translation, placeholders and tokens included, must have at most that many characters. Shorten or rephrase if needed.
- Follow the instructions below, and keep terms consistent with the other translations shown.
- Answer only with JSON in the given schema: for each string, its "id" and its "text", or its "forms" for a plural string.

%pluralForms%

About %projectName%:
%projectDescription%

Instructions for the project:
%projectInstructions%

Instructions for %targetLanguage%:
%languageInstructions%

---STRINGS---
The strings come from the file %fileName%.

About this file:
%fileContext%

Glossary:
%glossary%

The same strings in other languages, for reference ("proofread" ones are checked by people):
%otherLanguages%

Proofread %targetLanguage% translations of the same English elsewhere in the project: use them, unless the context calls for something else.
%identicalStrings%

The strings around them in the file, with their current %targetLanguage% translations, for context:
%neighbours%

The strings to translate, one JSON object per line: "id", "key", "english", the plural "forms" to give with their example numbers, "description", "maxLength", "references" (what each locked token stands for), "outdatedTranslation" (the current translation, made for an older English: update it) and "refused" (why your previous answer was refused: correct it).
%strings%

An instruction for this run, which comes before the others:
%customInstruction%`;

/**
 * The SHA-256 of earlier releases' default templates. An instance stores its template with
 * its settings; one still on an earlier default gets the current one, because nobody
 * chose it (Sprint 2's first version: `%%` notes and `---STRINGS---` came later).
 */
const FORMER_DEFAULT_TEMPLATES: ReadonlySet<string> = new Set([
  "4a42ac32eaba16ffacf8395e2139a0a842818371fab927f8486f7f8f4e9e3efa",
]);

/** The settings of a new instance. */
export function defaultSettings(model: string): ProjectSettings {
  return {
    name: "Untitled project",
    description: "",
    sourceLanguage: "en",
    syntax: { ...DEFAULT_SYNTAX },
    logoUrl: null,
    links: [],
    languageRequestsEnabled: false,
    fileHistoryDays: DEFAULT_FILE_HISTORY_DAYS,
    backupRetentionDays: DEFAULT_BACKUP_DAYS,
    email: { provider: "none", from: "", accountId: "" },
    llm: {
      autoTranslate: true,
      updateOutdated: true,
      proposeForProofread: true,
      model,
      concurrency: 4,
      monthlyTokenBudget: null,
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      projectInstructions: "",
      context: { otherLanguages: [], identicalStrings: true, fileContext: true, glossary: true },
      batchSize: 25,
      neighbours: 3,
      retries: 2,
      safety: "permissive",
    },
  };
}

/** Whether the settings row exists. */
export function hasSettings(ctx: Context): boolean {
  return ctx.sql.query("SELECT 1 AS found FROM settings WHERE id = 1").length > 0;
}

/**
 * The settings: the stored row, with missing fields filled from the defaults and unknown
 * ones dropped, validated. The defaults when there is no row yet.
 */
export function loadSettings(ctx: Pick<Context, "sql" | "defaultModel">): ProjectSettings {
  const rows = ctx.sql.query<{ data: string }>("SELECT data FROM settings WHERE id = 1");
  return settingsFromData(rows[0]?.data ?? null, ctx.defaultModel);
}

export async function loadSettingsAsync(
  sql: Pick<Sql, "read">,
  model: string,
): Promise<ProjectSettings> {
  const [rows] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
  return settingsFromData((rows[0]?.data as string) ?? null, model);
}

/** Decode stored settings from an operation's snapshot, using the same upgrade defaults. */
export function settingsFromData(data: string | null, model: string): ProjectSettings {
  const defaults = defaultSettings(model);
  if (data === null) return defaults;
  const merged = fillFromDefaults(defaults, fromJson(data));
  const result = validate(ProjectSettings, merged);
  if (!result.ok) {
    throw new ServiceError(
      "internal",
      `The stored settings are invalid: ${result.issues.map(formatIssue).join("; ")}`,
    );
  }
  const settings = result.value;
  if (FORMER_DEFAULT_TEMPLATES.has(sha256Hex(settings.llm.promptTemplate))) {
    settings.llm.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
  }
  return settings;
}

/** Validates and stores the settings. */
export function saveSettings(ctx: Context, settings: ProjectSettings): void {
  const valid = validateInput(ProjectSettings, settings);
  ctx.sql.run(
    "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
    toJson(valid),
  );
}

/**
 * The defaults, with each field replaced by the stored one when it has one. Objects merge
 * field by field; other values (arrays included) are taken whole.
 */
function fillFromDefaults(defaults: unknown, stored: unknown): unknown {
  if (!isPlainObject(defaults)) return stored === undefined ? defaults : stored;
  if (!isPlainObject(stored)) return defaults;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = Object.hasOwn(stored, key) ? fillFromDefaults(value, stored[key]) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
