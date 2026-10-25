// SPDX-License-Identifier: MIT
/**
 * Converting i18next text to ICU MessageFormat, for a project whose app moves to an ICU
 * formatter: the formatter then shows the converted text as i18next showed the original.
 * The service converts a project's stored texts with `valueToIcu`, and the CLI its source
 * files with `sourceFileToIcu`, so both give the same text.
 *
 * - `{{name}}` and `{{- name}}`, in the project's prefix and suffix, become `{name}`.
 *   Placeholders in extra delimiters become `{name}`; those already in `{` and `}` stay as
 *   written. An i18next format (`{{price, number}}`), a name ICU can't hold
 *   (`{{user.name}}`) and a nesting reference (`$t(…)`) can't be converted: the problems
 *   say why, and nothing is converted.
 * - Text stays text: `{`, `}` and, in a plural case, `#` are quoted (`'{'`), and an
 *   apostrophe ICU would read as the start of a quote (one before `{`, `}`, `'`, or `#` in a
 *   plural case) is doubled, so `qu'{{article}}` becomes `qu''{article}`.
 * - Plural forms become one block, `{count, plural, one {…} other {…}}` (`selectordinal`
 *   for ordinal forms), with the value's own forms as cases, in CLDR order. `{{count}}`
 *   becomes `{count}`, not `#`: formatters print an argument as given, as i18next does, but
 *   `#` as a formatted number. A cardinal `zero` form becomes the exact case `=0`, since
 *   i18next uses `key_zero` for 0 in every language; a language whose own rules have `zero`
 *   (Arabic, Latvian) keeps a `zero` case with the same text too, for the other numbers it
 *   covers there.
 *
 * Text already in ICU MessageFormat (`syntax.icu`) stays as it is, so converting twice
 * changes nothing.
 */
import { type FormatName, isMarkdownFormat } from "./documents.ts";
import { entryValue, parsePluralKey, readSource, type SourceEntry } from "./entries.ts";
import { type JsonNode, type JsonObject, parseJson, stringifyJson } from "./json.ts";
import { pluralCategories, type PluralOverride } from "./plurals.ts";
import { type PlaceholderToken, tokenize } from "./tokens.ts";
import {
  formatKeyPath,
  type InterpolationSyntax,
  type KeyPath,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type PluralForms,
  type TextValue,
  type TranslatableKind,
} from "./types.ts";

export interface IcuConversionOptions {
  /** The project's syntax, which the value is written in. */
  syntax: InterpolationSyntax;
  /** The value's language, for the plural categories of its forms. */
  language: string;
  pluralOverride?: PluralOverride;
}

/** A converted value, or why it can't be converted. */
export type IcuConversion =
  | {
      ok: true;
      value: TextValue;
      /** Characters quoted, and apostrophes doubled, so that they stay text. */
      escapes: number;
    }
  | { ok: false; problems: string[] };

/**
 * The ICU MessageFormat of a text string's text, or of a plural or ordinal string's forms
 * (one text with a plural block). A value of the wrong shape for its kind is a problem.
 */
export function valueToIcu(
  kind: TranslatableKind,
  value: TextValue,
  options: IcuConversionOptions,
): IcuConversion {
  if (options.syntax.icu) return { ok: true, value, escapes: 0 };
  const isText = typeof value === "string";
  if (kind === "text") {
    if (!isText) return { ok: false, problems: ["It has plural forms, but its string is a text"] };
    return messageToIcu(value, options.syntax);
  }
  if (isText) return { ok: false, problems: ["It is a text, but its string has plural forms"] };
  return formsToIcu(value, kind, options);
}

/** A message in ICU, as pieces: text to show as it is, and arguments as ICU writes them. */
type Piece = { text: string } | { argument: string };

function messageToIcu(text: string, syntax: InterpolationSyntax): IcuConversion {
  const problems: string[] = [];
  const pieces = piecesOf(text, syntax, problems);
  if (problems.length > 0) return { ok: false, problems };
  const message = writeMessage(pieces, { inPlural: false, closesCase: false });
  return { ok: true, value: message.text, escapes: message.escapes };
}

function formsToIcu(
  forms: PluralForms,
  kind: "plural" | "ordinal",
  options: IcuConversionOptions,
): IcuConversion {
  const ordinal = kind === "ordinal";
  const own = pluralCategories(options.language, { ordinal, override: options.pluralOverride });
  const problems: string[] = [];
  const cases: string[] = [];
  let escapes = 0;
  for (const category of PLURAL_CATEGORIES) {
    const form = forms[category];
    if (form === undefined) continue;
    const pieces = piecesOf(form, options.syntax, problems);
    const message = writeMessage(pieces, { inPlural: true, closesCase: true });
    escapes += message.escapes;
    for (const key of caseKeys(category, ordinal, own)) cases.push(`${key} {${message.text}}`);
  }
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  const blockType = ordinal ? "selectordinal" : "plural";
  return { ok: true, value: `{count, ${blockType}, ${cases.join(" ")}}`, escapes };
}

/** The cases a form becomes: its category, but `=0` for i18next's zero form (see above). */
function caseKeys(
  category: PluralCategory,
  ordinal: boolean,
  own: readonly PluralCategory[],
): string[] {
  if (category !== "zero" || ordinal) return [category];
  return own.includes("zero") ? ["=0", "zero"] : ["=0"];
}

/** The pieces of i18next text, adding to `problems` what ICU can't say. */
function piecesOf(text: string, syntax: InterpolationSyntax, problems: string[]): Piece[] {
  const pieces: Piece[] = [];
  for (const token of tokenize(text, syntax)) {
    if (token.type === "text") {
      pieces.push({ text: token.text });
    } else if (token.type === "reference") {
      problems.push(
        `${token.raw} is an i18next nesting reference; ICU MessageFormat has no nesting`,
      );
    } else if (token.type === "placeholder") {
      const argument = argumentOf(token);
      if (typeof argument === "string") pieces.push({ argument });
      else problems.push(argument.problem);
    }
  }
  return pieces;
}

/** The ICU argument for a placeholder, or why there is none. */
function argumentOf(token: PlaceholderToken): string | { problem: string } {
  if (token.format !== undefined) {
    return {
      problem: `${token.raw} has an i18next format, which ICU MessageFormat writes differently`,
    };
  }
  if (!ARGUMENT_NAME.test(token.name)) {
    return {
      problem: `${token.raw} can't become an ICU argument: names are letters, digits and _ only`,
    };
  }
  const inBraces = token.delimiters?.prefix === "{" && token.delimiters.suffix === "}";
  return inBraces ? token.raw : `{${token.name}}`;
}

/**
 * Argument names every ICU formatter reads. `parseIcu` also takes `$`, but FormatJS doesn't,
 * as it refuses all ASCII punctuation but `_`.
 */
const ARGUMENT_NAME = /^[\p{L}\p{N}_]+$/u;

/**
 * Writes pieces as an ICU message. `inPlural`: the message is a plural case, where `#` is
 * syntax. `closesCase`: a `}` follows the message, which an apostrophe at its end must not
 * quote away.
 */
function writeMessage(
  pieces: Piece[],
  where: { inPlural: boolean; closesCase: boolean },
): { text: string; escapes: number } {
  let text = "";
  let escapes = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if ("argument" in piece) {
      text += piece.argument;
      continue;
    }
    // Text is followed by an argument, which starts with `{`, or ends the message.
    const beforeBrace = index < pieces.length - 1 || where.closesCase;
    const literal = quoteText(piece.text, where.inPlural, beforeBrace);
    text += literal.text;
    escapes += literal.escapes;
  }
  return { text, escapes };
}

/**
 * Text as ICU shows it literally: runs of syntax characters in quotes (`'{{'`), and
 * apostrophes doubled where ICU would otherwise start a quote: inside quotes, and before a
 * syntax character or another apostrophe. `beforeBrace`: a `{` or `}` follows the text.
 */
function quoteText(
  text: string,
  inPlural: boolean,
  beforeBrace: boolean,
): { text: string; escapes: number } {
  const isSyntax = (char: string | undefined) =>
    char === "{" || char === "}" || (char === "#" && inPlural);
  let quoted = "";
  let escapes = 0;
  let inQuote = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (isSyntax(char)) {
      if (!inQuote) quoted += "'";
      inQuote = true;
      quoted += char;
      escapes++;
      continue;
    }
    if (char === "'") {
      const next = text[at + 1];
      const startsQuote = next === undefined ? beforeBrace : next === "'" || isSyntax(next);
      const doubled = inQuote || startsQuote;
      quoted += doubled ? "''" : "'";
      if (doubled) escapes++;
      continue;
    }
    if (inQuote) quoted += "'";
    inQuote = false;
    quoted += char;
  }
  if (inQuote) quoted += "'";
  return { text: quoted, escapes };
}

export interface SourceFileConversionOptions extends IcuConversionOptions {
  /** The file's path, for error messages, and for its format when `format` isn't given. */
  file?: string;
  format?: FormatName;
  /** As for `readSource`: groups of keys that only look like plurals. */
  pluralExclusions?: readonly string[];
  /** Keys ending with it describe another key: they are context, not text, and stay. */
  descriptionSuffix?: string;
}

/** A source file converted, or what stops it. */
export interface SourceFileConversion {
  /**
   * The converted file: JSON in the file's formatting and key order, with each merged
   * plural group where its first form was. The text as it was when nothing changed, or
   * when anything was refused.
   */
  text: string;
  /** The displayed keys of the plural groups merged into one string each. */
  merged: string[];
  escapes: number;
  /** What can't be converted, by displayed key: then nothing is converted. */
  refusals: { key: string; message: string }[];
}

/**
 * Converts an English source file as the service converts its strings (`valueToIcu`, with
 * the entries `readSource` finds): an i18next JSON file string by string, merging plural
 * groups into one key named by their base, and a Markdown document whole. A plural group
 * whose base another key of its object already has is refused. JSON syntax errors throw as
 * in `readSource`.
 */
export function sourceFileToIcu(
  text: string,
  options: SourceFileConversionOptions,
): SourceFileConversion {
  const unchanged: SourceFileConversion = { text, merged: [], escapes: 0, refusals: [] };
  if (options.syntax.icu) return unchanged;
  const source = readSource(text, options);
  if (isMarkdownFormat(source.format)) {
    if (source.entries[0]?.kind !== "text") return unchanged;
    // The whole file, not the stored value, so that its line endings stay as they are.
    const converted = valueToIcu("text", text, options);
    if (!converted.ok) return { ...unchanged, refusals: refusalsOf("", converted.problems) };
    return { ...unchanged, text: converted.value as string, escapes: converted.escapes };
  }
  const { root, format } = parseJson(text, { file: options.file });
  const result: SourceFileConversion = { text, merged: [], escapes: 0, refusals: [] };
  let changed = false;
  for (const entry of source.entries) {
    if (isDescription(entry, options.descriptionSuffix)) continue;
    if (entry.kind === "literal") continue;
    const key = formatKeyPath(entry.keyPath);
    if (entry.kind === "reference") {
      result.refusals.push({ key, message: REFERENCE_ONLY });
      continue;
    }
    const value = entryValue(entry)!;
    const converted = valueToIcu(entry.kind, value, options);
    if (!converted.ok) {
      result.refusals.push(...refusalsOf(key, converted.problems));
      continue;
    }
    const icu = converted.value as string;
    result.escapes += converted.escapes;
    const container = nodeAt(root, entry.keyPath.slice(0, -1));
    const name = entry.keyPath[entry.keyPath.length - 1];
    if (entry.kind === "text") {
      changed ||= icu !== value;
      setString(container, name, icu);
      continue;
    }
    const merged = mergeGroup(container as JsonObject, entry.kind, name as string, icu);
    if (!merged) {
      result.refusals.push({ key, message: groupNameTaken(key) });
      continue;
    }
    changed = true;
    result.merged.push(key);
  }
  if (result.refusals.length > 0) return { ...unchanged, refusals: result.refusals };
  if (!changed) return { ...unchanged, escapes: result.escapes };
  return { ...result, text: stringifyJson(root, format) };
}

/** Why an entry made only of nesting references can't be converted. */
export const REFERENCE_ONLY =
  "It is made of i18next nesting references only; ICU MessageFormat has no nesting";

/** Why a plural group can't become one string. */
export function groupNameTaken(key: string): string {
  return `Its forms would become one string named ${key}, but another key has that name: rename one of them first`;
}

function refusalsOf(key: string, problems: string[]): { key: string; message: string }[] {
  return problems.map((message) => ({ key, message }));
}

function isDescription(entry: SourceEntry, suffix: string | undefined): boolean {
  const last = entry.keyPath[entry.keyPath.length - 1];
  return suffix !== undefined && suffix !== "" && typeof last === "string" && last.endsWith(suffix);
}

/** The node at a key path, which `readSource` found. */
function nodeAt(root: JsonNode, path: KeyPath): JsonNode {
  let node = root;
  for (const segment of path) {
    if (node.type === "array") node = node.items[segment as number];
    else if (node.type === "object") node = node.members.find((m) => m.key === segment)!.value;
  }
  return node;
}

function setString(container: JsonNode, name: string | number, value: string): void {
  const node: JsonNode = { type: "string", value };
  if (container.type === "array") container.items[name as number] = node;
  if (container.type !== "object") return;
  const member = container.members.find((candidate) => candidate.key === name)!;
  member.value = node;
}

/**
 * Replaces a plural group's keys in its object with one key, `base`, where its first key
 * was. False, changing nothing, when another key of the object already has that name.
 */
function mergeGroup(
  object: JsonObject,
  kind: "plural" | "ordinal",
  base: string,
  value: string,
): boolean {
  const isForm = (key: string) => {
    const parts = parsePluralKey(key);
    return parts !== undefined && parts.kind === kind && parts.base === base;
  };
  if (object.members.some((member) => member.key === base)) return false;
  const first = object.members.findIndex((member) => isForm(member.key));
  object.members[first] = { key: base, value: { type: "string", value } };
  object.members = object.members.filter((member, index) => index === first || !isForm(member.key));
  return true;
}
