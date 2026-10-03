// SPDX-License-Identifier: MIT
/**
 * English entries as the `strings` table stores them (design §5.3), and back: uploads
 * turn core's entries into rows; downloads and imports rebuild the entries from rows.
 */
import {
  canonicalValue,
  entryKey,
  entryValue,
  formatKeyPath,
  hashValue,
  type InterpolationSyntax,
  isTranslatable,
  type KeyPath,
  sha256Hex,
  type SourceEntry,
  sourceWords,
  type TextValue,
  type TranslatableKind,
} from "@quaso/core";
import { fromJson, normalizeSearch } from "./db.ts";

/** An entry's columns in the `strings` table. */
export interface EntryColumns {
  kind: SourceEntry["kind"];
  /** `entryKey()`: the identity within the file. */
  key: string;
  keyPath: string;
  displayKey: string;
  source: string;
  sourceHash: string;
  words: number;
  searchText: string;
}

/**
 * An entry's columns: the source as JSON (the text, the forms, or the JSON string of a
 * reference's value or a literal's raw JSON), its hash (`hashValue` for translatable kinds,
 * SHA-256 of the source column otherwise), its words and its search text.
 */
export function entryColumns(
  entry: SourceEntry,
  options: { syntax: InterpolationSyntax; locale: string },
): EntryColumns {
  const value = entryValue(entry);
  const displayKey = formatKeyPath(entry.keyPath);
  let source: string;
  let sourceHash: string;
  let text: string;
  if (value !== undefined) {
    source = canonicalValue(value);
    sourceHash = hashValue(value);
    text = valueText(value);
  } else {
    text = entry.kind === "literal" ? entry.raw : entry.kind === "reference" ? entry.value : "";
    source = JSON.stringify(text);
    sourceHash = sha256Hex(source);
  }
  return {
    kind: entry.kind,
    key: entryKey(entry.kind, entry.keyPath),
    keyPath: JSON.stringify(entry.keyPath),
    displayKey,
    source,
    sourceHash,
    words: sourceWords(entry.kind, value, options),
    searchText: normalizeSearch(`${displayKey}\n${text}`),
  };
}

/** A row's columns that make an entry. */
export interface EntryRow {
  kind: string;
  key_path: string;
  source: string;
}

/** Rebuilds a core entry from its row. */
export function entryFromRow(row: EntryRow): SourceEntry {
  const keyPath = fromJson<KeyPath>(row.key_path);
  switch (row.kind) {
    case "text":
      return { kind: "text", keyPath, value: fromJson<string>(row.source) };
    case "plural":
    case "ordinal":
      return { kind: row.kind, keyPath, forms: fromJson(row.source) };
    case "reference":
      return { kind: "reference", keyPath, value: fromJson<string>(row.source) };
    case "literal":
      return { kind: "literal", keyPath, raw: fromJson<string>(row.source) };
    default:
      throw new Error(`Unknown kind of string: ${row.kind}`);
  }
}

/** The English value of a translatable string's source column. */
export function sourceValue(source: string): TextValue {
  return fromJson<TextValue>(source);
}

/** Whether a stored kind is one translators translate. */
export function isTranslatableKind(kind: string): kind is TranslatableKind {
  return isTranslatable(kind as SourceEntry["kind"]);
}

/** A value as one text, for search: the text, or the forms on lines of their own. */
export function valueText(value: TextValue): string {
  return typeof value === "string" ? value : Object.values(value).join("\n");
}

/** The kinds translators see, for SQL: `'text', 'plural', 'ordinal'`. */
export const TRANSLATABLE_SQL = "'text', 'plural', 'ordinal'";
