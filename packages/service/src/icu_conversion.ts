// SPDX-License-Identifier: MIT
/**
 * Converting a project from i18next to ICU MessageFormat (`POST /conversions/icu`). In one
 * commit, every string the English has, its translations in the project's languages and its
 * pending suggestions are rewritten with core's `valueToIcu`, and the project's syntax
 * becomes ICU, so translators translate and proofread nothing again:
 *
 * - A plural group becomes one ICU string under its base key in place: its row keeps its
 *   translations, suggestions, history and comments. A removed string that held that key
 *   keeps its own under a key no upload names (`retiredKey`).
 * - Colours, authors, approvers, timestamps and outdated flags stay. Each changed text gets
 *   a history event, written by whoever converts; past history stays as written.
 * - The checks run again with ICU's rules. A translation that fails them stays, with its
 *   errors, and the result lists it.
 *
 * Nothing changes while anything refuses it: a text ICU can't say (an i18next format, a
 * nesting reference), a plural group whose key another string has, a queued or running
 * translation job. Strings the English no longer has, hidden files and translations in
 * languages the project no longer has stay as they were.
 */
import {
  canonicalValue,
  type ErrorDetail,
  errorsOf,
  type IcuConversionRequest,
  type IcuConversionResult,
  type InterpolationSyntax,
  type KeyPath,
  type ProjectSettings,
  REFERENCE_ONLY,
  type TextValue,
  type TranslatableKind,
  groupNameTaken,
  valueToIcu,
} from "@quaso/core";
import { type Author, SYSTEM_AUTHOR } from "./actors.ts";
import type { Actor } from "./api.ts";
import { fromJson, normalizeSearch, toJson } from "./db.ts";
import { type EntryColumns, entryColumns, valueText } from "./entries.ts";
import type { CheckFacts } from "./facts.ts";
import { type Language, type LanguageRow, toLanguage } from "./languages.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Logger, Sql, SqlRow, Statement } from "./ports.ts";
import { settingsFromData } from "./settings.ts";
import { checkValue, type TranslationRow } from "./translations.ts";
import { withRetries } from "./write.ts";

type StringRow = {
  id: number;
  file_id: number;
  path: string;
  key: string;
  key_path: string;
  display_key: string;
  kind: string;
  source: string;
  source_hash: string;
  max_length: number | null;
  active: number;
};

type SuggestionRow = {
  id: number;
  string_id: number;
  language: string;
  /** Null for a "looks good". */
  value: string | null;
  source_hash: string;
  base_revision: number;
};

/** Everything the conversion reads, from one consistent snapshot. */
export interface ConversionSnapshot {
  settings: ProjectSettings;
  languages: Language[];
  glossary: NonNullable<CheckFacts["glossary"]>;
  /** Every string of the active files, removed ones too (they may hold a merged key). */
  strings: StringRow[];
  /** The translations of the active strings. */
  translations: TranslationRow[];
  /** The pending suggestions of the active strings. */
  suggestions: SuggestionRow[];
  /** Translation jobs that are queued or running. */
  jobs: number[];
}

export async function convertToIcuAsync(
  sql: Sql,
  actor: Actor,
  request: IcuConversionRequest,
  options: { now: number; model: string },
): Promise<IcuConversionResult> {
  return withRetries(
    sql,
    async () => {
      const permissions = permissionReadStatements(actor);
      const rows = await sql.read([...CONVERSION_READS, ...permissions, tokenName(actor)]);
      const reads = CONVERSION_READS.length;
      permissionsFromRows(actor, rows.slice(reads, reads + permissions.length)).require("convert");
      const name = (rows.at(-1)?.[0]?.name as string | undefined) ?? null;
      return {
        revision: Number(rows[0][0].revision),
        state: { snapshot: snapshotFromRows(rows, options.model), author: authorOf(actor, name) },
      };
    },
    (state) =>
      planIcuConversion(state.snapshot, request, state.author, {
        revision: state.snapshot.revision,
        now: options.now,
      }),
  );
}

const ACTIVE_STRINGS =
  "SELECT s.id FROM strings s JOIN files f ON f.id = s.file_id WHERE s.active = 1 AND f.active = 1";

const CONVERSION_READS: Statement[] = [
  {
    sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
  },
  { sql: "SELECT data FROM settings WHERE id = 1" },
  { sql: "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag" },
  { sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms" },
  {
    sql: `SELECT s.id, s.file_id, f.path, s.key, s.key_path, s.display_key, s.kind, s.source,
      s.source_hash, s.max_length, s.active FROM strings s JOIN files f ON f.id = s.file_id
      WHERE f.active = 1 ORDER BY f.path, s.position, s.id`,
  },
  {
    sql: `SELECT * FROM translations WHERE string_id IN (${ACTIVE_STRINGS})
      ORDER BY string_id, language`,
  },
  {
    sql: `SELECT id, string_id, language, value, source_hash, base_revision FROM suggestions
      WHERE status = 'pending' AND string_id IN (${ACTIVE_STRINGS}) ORDER BY id`,
  },
  { sql: "SELECT id FROM jobs WHERE status IN ('queued', 'running') ORDER BY id" },
];

function tokenName(actor: Actor): Statement {
  return {
    sql: "SELECT name FROM api_tokens WHERE id = ?",
    params: [actor.type === "token" ? actor.tokenId : null],
  };
}

function authorOf(actor: Actor, tokenName: string | null): Author {
  if (actor.type === "user") return { type: "user", id: actor.userId, label: null };
  if (actor.type === "token") return { type: "token", id: actor.tokenId, label: tokenName };
  return SYSTEM_AUTHOR;
}

function snapshotFromRows(
  rows: SqlRow[][],
  model: string,
): ConversionSnapshot & { revision: number } {
  return {
    revision: Number(rows[0][0].revision),
    settings: settingsFromData((rows[1][0]?.data as string | undefined) ?? null, model),
    languages: (rows[2] as LanguageRow[]).map(toLanguage),
    glossary: rows[3].map((row) => ({
      term: row.term as string,
      language: row.language as string | null,
      kind: row.kind as "translate" | "keep",
      translation: row.translation as string | null,
      caseSensitive: row.case_sensitive === 1,
    })),
    strings: rows[4] as StringRow[],
    translations: rows[5] as TranslationRow[],
    suggestions: rows[6] as SuggestionRow[],
    jobs: rows[7].map((row) => Number(row.id)),
  };
}

/** A translation, or a pending suggestion, as it will be stored. */
interface ConvertedText {
  value: string;
  sourceHash: string;
  changed: boolean;
}

/** An active string, converted. */
interface ConvertedString {
  row: StringRow;
  columns: EntryColumns;
  /** A plural or ordinal group that became one string. */
  merged: boolean;
}

/**
 * Decides the whole conversion without I/O: the result, and the statements that make it
 * (none for a dry run, with refusals, or for a project already on ICU).
 */
export function planIcuConversion(
  snapshot: ConversionSnapshot,
  request: IcuConversionRequest,
  author: Author,
  at: { revision: number; now: number },
): { statements: Statement[]; result: IcuConversionResult } {
  const result: IcuConversionResult = {
    dryRun: request.dryRun === true,
    converted: false,
    alreadyIcu: false,
    strings: 0,
    translations: 0,
    suggestions: 0,
    merged: [],
    escapes: 0,
    escaped: [],
    refusals: [],
    failing: [],
    revision: at.revision,
  };
  const { settings } = snapshot;
  if (settings.syntax.icu) return { statements: [], result: { ...result, alreadyIcu: true } };
  const from = settings.syntax;
  const to: InterpolationSyntax = { ...from, optional: optionalToIcu(settings), icu: true };
  const sourceLanguage = settings.sourceLanguage;
  const languages = new Map(snapshot.languages.map((language) => [language.tag, language]));
  const facts: CheckFacts = { sourceLanguage, syntax: to, languages, glossary: snapshot.glossary };
  for (const job of snapshot.jobs) {
    result.refusals.push({
      message: `Translation job ${job} is queued or running: let it finish, or cancel it`,
    });
  }

  const converted: ConvertedString[] = [];
  for (const row of snapshot.strings) {
    if (row.active !== 1 || row.kind === "literal") continue;
    const where = { file: row.path, key: row.display_key };
    if (row.kind === "reference") {
      result.refusals.push({ ...where, message: REFERENCE_ONLY });
      continue;
    }
    const english = valueToIcu(row.kind as TranslatableKind, fromJson<TextValue>(row.source), {
      syntax: from,
      language: sourceLanguage,
    });
    if (!english.ok) {
      result.refusals.push(...english.problems.map((message) => ({ ...where, message })));
      continue;
    }
    const keyPath = fromJson<KeyPath>(row.key_path);
    const entry = { kind: "text" as const, keyPath, value: english.value as string };
    const columns = entryColumns(entry, { syntax: to, locale: sourceLanguage });
    const merged = row.kind !== "text";
    converted.push({ row, columns, merged });
    if (merged) result.merged.push(where);
    if (columns.source !== row.source) result.strings++;
    result.escapes += english.escapes;
    if (english.escapes > 0) result.escaped.push(where);
  }
  const retired = planMergedKeys(snapshot.strings, converted, result.refusals);

  const strings = new Map(converted.map((string) => [string.row.id, string]));
  const translations = new Map<string, TranslationRow & ConvertedText>();
  const qaUpdates: unknown[] = [];
  const history: unknown[] = [];
  for (const translation of snapshot.translations) {
    const string = strings.get(translation.string_id);
    const language = languages.get(translation.language);
    if (string === undefined || language === undefined) continue;
    const where = { file: string.row.path, key: string.row.display_key, language: language.tag };
    const icu = valueToIcu(
      string.row.kind as TranslatableKind,
      fromJson<TextValue>(translation.value),
      { syntax: from, language: language.tag, pluralOverride: language.pluralOverride },
    );
    if (!icu.ok) {
      result.refusals.push(...icu.problems.map((message) => ({ ...where, message })));
      continue;
    }
    const text = convertedText(translation, icu.value, string);
    translations.set(pairKey(translation.string_id, language.tag), { ...translation, ...text });
    const target = { ...string.columns, max_length: string.row.max_length };
    const checks = checkValue(facts, target, language.tag, icu.value);
    const errors = errorsOf(checks);
    if (errors.length > 0) {
      result.failing.push({ ...where, check: errors[0].check, message: errors[0].message });
    }
    result.escapes += icu.escapes;
    if (icu.escapes > 0) result.escaped.push(where);
    const unchanged =
      !text.changed &&
      text.sourceHash === translation.source_hash &&
      errors.length === translation.qa_errors &&
      checks.length - errors.length === translation.qa_warnings;
    if (unchanged) continue;
    if (text.changed) result.translations++;
    qaUpdates.push({
      stringId: translation.string_id,
      language: translation.language,
      value: text.value,
      sourceHash: text.sourceHash,
      searchText: normalizeSearch(valueText(icu.value)),
      revision: text.changed ? at.revision + 1 : translation.revision,
      errors: errors.length,
      warnings: checks.length - errors.length,
    });
    if (text.changed)
      history.push({
        stringId: translation.string_id,
        language: translation.language,
        event: "translation_converted",
        before: translation.value,
        after: text.value,
        colour: translation.colour,
      });
  }

  const suggestionUpdates: unknown[] = [];
  for (const suggestion of snapshot.suggestions) {
    const string = strings.get(suggestion.string_id);
    const language = languages.get(suggestion.language);
    if (string === undefined || language === undefined) continue;
    const current = translations.get(pairKey(suggestion.string_id, suggestion.language));
    const outgrown = current === undefined || current.revision !== suggestion.base_revision;
    const baseRevision = outgrown || !current.changed ? suggestion.base_revision : at.revision + 1;
    const sourceHash =
      suggestion.source_hash === string.row.source_hash
        ? string.columns.sourceHash
        : suggestion.source_hash;
    let value = suggestion.value;
    if (value !== null) {
      const icu = valueToIcu(string.row.kind as TranslatableKind, fromJson<TextValue>(value), {
        syntax: from,
        language: language.tag,
        pluralOverride: language.pluralOverride,
      });
      if (!icu.ok) {
        const where = {
          file: string.row.path,
          key: string.row.display_key,
          language: language.tag,
        };
        result.refusals.push(
          ...icu.problems.map((message) => ({
            ...where,
            message: `A pending suggestion: ${message}`,
          })),
        );
        continue;
      }
      result.escapes += icu.escapes;
      value = canonicalValue(icu.value);
      if (value !== suggestion.value) result.suggestions++;
    }
    const unchanged =
      value === suggestion.value &&
      sourceHash === suggestion.source_hash &&
      baseRevision === suggestion.base_revision;
    if (!unchanged) suggestionUpdates.push({ id: suggestion.id, value, sourceHash, baseRevision });
  }

  if (result.refusals.length > 0 || result.dryRun) return { statements: [], result };
  const changedStrings = converted.filter(
    (string) => string.columns.source !== string.row.source || string.merged,
  );
  const statements: Statement[] = [
    ...retired.map((row) => ({
      sql: "UPDATE strings SET key = ?, updated_at = ? WHERE id = ?",
      params: [retiredKey(row.key, row.id), at.now, row.id],
    })),
    ...jsonStatements(STRINGS_UPDATE, [at.now], changedStrings.map(stringUpdate)),
    ...jsonStatements(
      SOURCE_WARNINGS_UPDATE,
      [],
      changedStrings.map((string) => ({
        id: string.row.id,
        before: string.row.source_hash,
        after: string.columns.sourceHash,
      })),
    ),
    {
      sql: "UPDATE files SET source_updated_at = ?, source_revision = ? WHERE id IN (SELECT value FROM json_each(?))",
      params: [
        at.now,
        at.revision + 1,
        toJson([...new Set(changedStrings.map((string) => string.row.file_id))]),
      ],
    },
    ...jsonStatements(TRANSLATIONS_UPDATE, [], qaUpdates),
    ...jsonStatements(SUGGESTIONS_UPDATE, [], suggestionUpdates),
    ...jsonStatements(
      HISTORY_INSERT,
      [author.type, author.id, author.label, at.now],
      [
        ...changedStrings.map((string) => ({
          stringId: string.row.id,
          language: null,
          event: "source_converted",
          before: string.row.source,
          after: string.columns.source,
          colour: null,
        })),
        ...history,
      ],
    ),
    {
      sql: "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      params: [toJson({ ...settings, syntax: to })],
    },
    conversionActivity(result, author, at.now),
  ];
  return { statements, result: { ...result, converted: true, revision: at.revision + 1 } };
}

export function logConversion(logger: Logger, result: IcuConversionResult): void {
  logger.info("Converted to ICU MessageFormat", {
    strings: result.strings,
    translations: result.translations,
    suggestions: result.suggestions,
    merged: result.merged.length,
    failing: result.failing.length,
    revision: result.revision,
  });
}

/**
 * The key a removed string keeps when a converted plural group takes its key: no upload
 * names it, so it stays removed, with its translations and history.
 */
export function retiredKey(key: string, id: number): string {
  return `${key}#retired-${id}`;
}

/**
 * Checks that each merged group's new key is free in its file, adding refusals for those
 * another active string has, and returns the removed strings to retire for the rest.
 */
function planMergedKeys(
  strings: StringRow[],
  converted: ConvertedString[],
  refusals: ErrorDetail[],
): StringRow[] {
  const byKey = new Map<string, StringRow[]>();
  for (const row of strings) {
    const key = `${row.file_id} ${row.key}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const claimed = new Map<string, number>();
  for (const string of converted) {
    const key = `${string.row.file_id} ${string.columns.key}`;
    claimed.set(key, (claimed.get(key) ?? 0) + 1);
  }
  const retired: StringRow[] = [];
  for (const string of converted) {
    if (!string.merged) continue;
    const key = `${string.row.file_id} ${string.columns.key}`;
    const holders = (byKey.get(key) ?? []).filter((row) => row.id !== string.row.id);
    const takenByActive = holders.some((row) => row.active === 1) || claimed.get(key)! > 1;
    if (takenByActive) {
      refusals.push({
        file: string.row.path,
        key: string.row.display_key,
        message: groupNameTaken(string.row.display_key),
      });
      continue;
    }
    retired.push(...holders);
  }
  return retired;
}

/** A translation's or suggestion's new value, and the English hash it is for. */
function convertedText(
  translation: Pick<TranslationRow, "value" | "source_hash">,
  value: TextValue,
  string: ConvertedString,
): ConvertedText {
  const stored = canonicalValue(value);
  const current = translation.source_hash === string.row.source_hash;
  return {
    value: stored,
    sourceHash: current ? string.columns.sourceHash : translation.source_hash,
    changed: stored !== translation.value,
  };
}

function pairKey(stringId: number, language: string): string {
  return `${stringId} ${language}`;
}

/** The optional placeholders, written in ICU, so they still name the English's. */
function optionalToIcu(settings: ProjectSettings): InterpolationSyntax["optional"] {
  return settings.syntax.optional?.map((entry) => {
    const icu = valueToIcu("text", entry.placeholder, {
      syntax: settings.syntax,
      language: settings.sourceLanguage,
    });
    return icu.ok ? { ...entry, placeholder: icu.value as string } : entry;
  });
}

function stringUpdate(string: ConvertedString) {
  const { columns } = string;
  return {
    id: string.row.id,
    key: columns.key,
    kind: columns.kind,
    source: columns.source,
    sourceHash: columns.sourceHash,
    words: columns.words,
    searchText: columns.searchText,
  };
}

function conversionActivity(result: IcuConversionResult, author: Author, now: number): Statement {
  const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const counts = [
    counted(result.strings, "string"),
    counted(result.translations, "translation"),
    `${counted(result.merged.length, "plural group")} merged`,
  ];
  const detail = {
    strings: result.strings,
    translations: result.translations,
    suggestions: result.suggestions,
    merged: result.merged.length,
    escapes: result.escapes,
    failing: result.failing.length,
  };
  return {
    sql: `INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at)
      VALUES ('conversion', ?, ?, ?, ?, ?, ?)`,
    params: [
      author.type,
      author.id,
      author.label,
      `Converted to ICU MessageFormat: ${counts.join(", ")}`,
      toJson(detail),
      now,
    ],
  };
}

// Bulk writes read their rows from one JSON parameter, so that a project's every
// translation takes a few statements rather than one each.

const STRINGS_UPDATE = `UPDATE strings SET key = json_extract(r.value, '$.key'),
  kind = json_extract(r.value, '$.kind'), source = json_extract(r.value, '$.source'),
  source_hash = json_extract(r.value, '$.sourceHash'), words = json_extract(r.value, '$.words'),
  search_text = json_extract(r.value, '$.searchText'), updated_at = ?
  FROM json_each(?) r WHERE strings.id = json_extract(r.value, '$.id')`;

const SOURCE_WARNINGS_UPDATE = `UPDATE source_warnings SET source_hash = json_extract(r.value, '$.after')
  FROM json_each(?) r WHERE source_warnings.string_id = json_extract(r.value, '$.id')
    AND source_warnings.source_hash = json_extract(r.value, '$.before')`;

const TRANSLATIONS_UPDATE = `UPDATE translations SET value = json_extract(r.value, '$.value'),
  source_hash = json_extract(r.value, '$.sourceHash'),
  search_text = json_extract(r.value, '$.searchText'),
  revision = json_extract(r.value, '$.revision'), qa_errors = json_extract(r.value, '$.errors'),
  qa_warnings = json_extract(r.value, '$.warnings')
  FROM json_each(?) r WHERE translations.string_id = json_extract(r.value, '$.stringId')
    AND translations.language = json_extract(r.value, '$.language')`;

const SUGGESTIONS_UPDATE = `UPDATE suggestions SET value = json_extract(r.value, '$.value'),
  source_hash = json_extract(r.value, '$.sourceHash'),
  base_revision = json_extract(r.value, '$.baseRevision')
  FROM json_each(?) r WHERE suggestions.id = json_extract(r.value, '$.id')`;

const HISTORY_INSERT = `INSERT INTO history (string_id, language, event, before_value, after_value,
  before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at)
  SELECT json_extract(value, '$.stringId'), json_extract(value, '$.language'),
    json_extract(value, '$.event'), json_extract(value, '$.before'),
    json_extract(value, '$.after'), json_extract(value, '$.colour'),
    json_extract(value, '$.colour'), ?, ?, ?, NULL, ? FROM json_each(?)`;

/**
 * The most UTF-16 code units of rows in one JSON parameter, at most 3 bytes each in UTF-8:
 * D1 refuses values over 2 MB.
 */
const JSON_CHUNK_LENGTH = 500_000;

/** A statement for each chunk of rows, with `params` before the rows' JSON. */
function jsonStatements(
  sql: string,
  params: (string | number | null)[],
  rows: unknown[],
): Statement[] {
  const statements: Statement[] = [];
  let chunk: string[] = [];
  let length = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    statements.push({ sql, params: [...params, `[${chunk.join(",")}]`] });
    chunk = [];
    length = 0;
  };
  for (const row of rows) {
    const json = toJson(row);
    if (length + json.length > JSON_CHUNK_LENGTH) flush();
    chunk.push(json);
    length += json.length;
  }
  flush();
  return statements;
}
