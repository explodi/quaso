// SPDX-License-Identifier: MIT
/**
 * The tokenizer shared by the editor, the quality checks and the LLM prompts (design §5.2).
 *
 * It finds interpolation placeholders (`{{count}}`, `{{name, uppercase}}`, `{{- html}}`, or
 * with the project's own prefix and suffix) and nesting references (`$t(key)`,
 * `$t(ns:key)`, `$t(key, {"count": {{n}}})`). A placeholder inside a reference's options
 * belongs to the reference, not to the text.
 */
import { DEFAULT_SYNTAX, type InterpolationSyntax } from "./types.ts";

export interface TextToken {
  type: "text";
  text: string;
  /** Offset of the first character, in UTF-16 code units. */
  start: number;
  /** Offset after the last character. */
  end: number;
}

export interface PlaceholderToken {
  type: "placeholder";
  /** Exactly as written, such as `{{ count }}` or `{{- html}}`. */
  raw: string;
  /**
   * The variable, trimmed: `count`, `html`, `user.name`. In `{{ - html}}` it is `- html`,
   * since i18next only unescapes when the `-` comes right after the prefix.
   */
  name: string;
  /** The format after the first comma, trimmed, such as `uppercase` or `datetime`. */
  format?: string;
  /** `{{- x}}`, with the `-` right after the prefix: i18next's unescaped interpolation. */
  unescaped: boolean;
  start: number;
  end: number;
}

export interface ReferenceToken {
  type: "reference";
  /** Exactly as written, such as `$t(common:back)`. */
  raw: string;
  /** The key, without its namespace, trimmed: `back`. */
  key: string;
  /** The namespace before the first `:`, if any: `common`. */
  namespace?: string;
  /** The options after the first top-level comma, trimmed, such as `{"count": {{n}}}`. */
  options?: string;
  start: number;
  end: number;
}

export type Token = TextToken | PlaceholderToken | ReferenceToken;

/** Opens a masked reference in the editor and in LLM prompts: `⟦1⟧`. */
export const MASK_OPEN = "⟦";
/** Closes a masked reference. */
export const MASK_CLOSE = "⟧";

/** The nesting prefix and suffix i18next uses by default. */
export const NESTING_PREFIX = "$t(";
export const NESTING_SUFFIX = ")";

/**
 * Splits text into text, placeholder and reference tokens, in order. Adjacent text is one
 * token; empty text tokens are omitted. The tokens cover the whole text, so joining their
 * raw text (`text` for text tokens) gives the input back.
 *
 * - Placeholders follow i18next's interpolation pattern (`{{(.+?)}}`): a placeholder
 *   starts at `syntax.prefix` and ends at the first `syntax.suffix` after at least one
 *   character, all on one line (no `\n`, `\r`, U+2028 or U+2029 before the suffix). A
 *   prefix without such a suffix is plain text. The inner text may start with `-`, right
 *   after the prefix (unescaped); the rest splits at the first comma into name and format.
 *   A span with an empty name, such as `{{ }}` or `{{, number}}`, is plain text that
 *   i18next never fills in, and a prefix inside it starts no placeholder. `{{}} {{count}}`
 *   is one placeholder, named `}} {{count`, as i18next reads it.
 * - A reference starts at `$t(` and ends at the matching `)`, skipping parentheses and
 *   braces nested inside it and anything inside double or single quotes. Without a
 *   matching `)`, `$t(` is plain text.
 */
export function tokenize(text: string, syntax: InterpolationSyntax = DEFAULT_SYNTAX): Token[] {
  const tokens: Token[] = [];
  const references = new ReferenceFinder(text);
  const placeholders = new PlaceholderFinder(text, syntax);
  let pending = 0;
  let at = 0;
  while (at < text.length) {
    const reference = references.next(at);
    const placeholder = placeholders.next(at);
    const start = earliest(reference, placeholder);
    if (start === -1) break;
    const token =
      (start === reference ? references.match(start) : null) ??
      (start === placeholder ? placeholders.match(start) : null);
    if (token === null) {
      at = start + 1; // Plain text; a reference may still start inside a blank placeholder.
      continue;
    }
    if (start > pending) tokens.push(textToken(text, pending, start));
    tokens.push(token);
    at = pending = token.end;
  }
  if (pending < text.length) tokens.push(textToken(text, pending, text.length));
  return tokens;
}

/** The smaller of two positions, where -1 means "none". */
function earliest(a: number, b: number): number {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function textToken(text: string, start: number, end: number): TextToken {
  return { type: "text", text: text.slice(start, end), start, end };
}

/**
 * Finds placeholders. Positions only move forward, so the next prefix, suffix and line
 * break are searched once and remembered, which keeps tokenizing linear.
 */
class PlaceholderFinder {
  readonly #text: string;
  readonly #prefix: string;
  readonly #suffix: string;
  #nextPrefix: number;
  #nextSuffix: number;
  /** The next line terminator at or after the last position searched, or the text's length. */
  #nextBreak = -1;
  /** The end of the last blank placeholder: prefixes before it start no placeholder. */
  #blockedUntil = 0;

  constructor(text: string, syntax: InterpolationSyntax) {
    this.#text = text;
    this.#prefix = syntax.prefix;
    this.#suffix = syntax.suffix;
    const enabled = syntax.prefix !== "" && syntax.suffix !== "";
    this.#nextPrefix = enabled ? text.indexOf(syntax.prefix) : -1;
    this.#nextSuffix = enabled ? text.indexOf(syntax.suffix) : -1;
  }

  /** The position of the next prefix at or after `at` that may start a placeholder, or -1. */
  next(at: number): number {
    const from = Math.max(at, this.#blockedUntil);
    if (this.#nextPrefix !== -1 && this.#nextPrefix < from) {
      this.#nextPrefix = this.#text.indexOf(this.#prefix, from);
    }
    return this.#nextPrefix;
  }

  /**
   * The placeholder whose prefix is at `start`, or null if the prefix is plain text: no
   * suffix follows on the same line, or the name is blank.
   */
  match(start: number): PlaceholderToken | null {
    const innerStart = start + this.#prefix.length;
    // Like i18next's `(.+?)`, the inner text has at least one character.
    if (this.#nextSuffix !== -1 && this.#nextSuffix < innerStart + 1) {
      this.#nextSuffix = this.#text.indexOf(this.#suffix, innerStart + 1);
    }
    if (this.#nextSuffix === -1) {
      this.#nextPrefix = -1; // No suffix follows, so no later prefix can match either.
      return null;
    }
    if (this.#lineBreakFrom(innerStart) < this.#nextSuffix) return null;
    const end = this.#nextSuffix + this.#suffix.length;
    const token = parsePlaceholder(this.#text, start, innerStart, this.#nextSuffix, end);
    if (token === null) this.#blockedUntil = end;
    return token;
  }

  /** The position of the first line terminator at or after `at`, or the text's length. */
  #lineBreakFrom(at: number): number {
    if (this.#nextBreak < at) {
      LINE_TERMINATOR.lastIndex = at;
      this.#nextBreak = LINE_TERMINATOR.exec(this.#text)?.index ?? this.#text.length;
    }
    return this.#nextBreak;
  }
}

/** What `.` in a regular expression doesn't match, as in i18next's `(.+?)`. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

/**
 * The placeholder from `start` to `end`, whose inner text runs from `innerStart` to
 * `innerEnd`, or null if its name is blank.
 */
function parsePlaceholder(
  text: string,
  start: number,
  innerStart: number,
  innerEnd: number,
  end: number,
): PlaceholderToken | null {
  const inner = text.slice(innerStart, innerEnd);
  const unescaped = inner.startsWith("-");
  const body = unescaped ? inner.slice(1) : inner;
  const comma = body.indexOf(",");
  const name = (comma === -1 ? body : body.slice(0, comma)).trim();
  if (name === "") return null;
  const format = comma === -1 ? "" : body.slice(comma + 1).trim();
  const token: PlaceholderToken = {
    type: "placeholder",
    raw: text.slice(start, end),
    name,
    unescaped,
    start,
    end,
  };
  if (format !== "") token.format = format;
  return token;
}

/** Marks an open `(` that doesn't start a reference, on the bracket stack. */
const PAREN = -1;
/** Marks an open `{` on the bracket stack. */
const BRACE = -2;

/**
 * Finds nesting references. A failed search for the `)` that closes a `$t(` runs to the end
 * of the text; on the way it learns where every `$t(` it passes outside quotes ends (or
 * that it doesn't), and remembers it. That keeps text such as `$t($t($t(…` linear.
 */
class ReferenceFinder {
  readonly #text: string;
  readonly #ends = new Map<number, number>();
  #next: number;

  constructor(text: string) {
    this.#text = text;
    this.#next = text.indexOf(NESTING_PREFIX);
  }

  /** The position of the next `$t(` at or after `at`, or -1. */
  next(at: number): number {
    if (this.#next !== -1 && this.#next < at) this.#next = this.#text.indexOf(NESTING_PREFIX, at);
    return this.#next;
  }

  /** The reference that starts at `start`, or null if its `)` is missing. */
  match(start: number): ReferenceToken | null {
    let end = this.#ends.get(start);
    if (end === undefined) end = findReferenceEnd(this.#text, start, this.#ends);
    return end === -1 ? null : parseReference(this.#text, start, end);
  }
}

/**
 * The end (after the `)`) of the reference that starts at `start`, or -1. Brackets nest:
 * `(` with `)` and `{` with `}`; a closing bracket that doesn't match the innermost open one
 * is ignored, and so is everything inside double or single quotes. Records in `ends` the
 * end of every `$t(` it opened, -1 for those it never closed.
 */
function findReferenceEnd(text: string, start: number, ends: Map<number, number>): number {
  const open: number[] = [start];
  let quote = "";
  for (let at = start + NESTING_PREFIX.length; at < text.length; at++) {
    const char = text[at];
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      const opener = at - NESTING_PREFIX.length + 1;
      open.push(text.startsWith(NESTING_PREFIX, opener) ? opener : PAREN);
    } else if (char === "{") {
      open.push(BRACE);
    } else if (char === "}" && open[open.length - 1] === BRACE) {
      open.pop();
    } else if (char === ")" && open[open.length - 1] !== BRACE) {
      const opener = open.pop()!;
      if (opener >= 0) ends.set(opener, at + 1);
      if (open.length === 0) return at + 1;
    }
  }
  for (const opener of open) if (opener >= 0) ends.set(opener, -1);
  return -1;
}

/** Splits a reference into key, namespace and options. */
function parseReference(text: string, start: number, end: number): ReferenceToken {
  const raw = text.slice(start, end);
  const inner = raw.slice(NESTING_PREFIX.length, raw.length - NESTING_SUFFIX.length);
  const comma = topLevelComma(inner);
  const target = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const options = comma === -1 ? "" : inner.slice(comma + 1).trim();
  const colon = target.indexOf(":");
  const token: ReferenceToken = {
    type: "reference",
    raw,
    key: colon === -1 ? target : target.slice(colon + 1).trim(),
    start,
    end,
  };
  const namespace = colon === -1 ? "" : target.slice(0, colon).trim();
  if (namespace !== "") token.namespace = namespace;
  if (options !== "") token.options = options;
  return token;
}

/** The first comma outside brackets and quotes, or -1. */
function topLevelComma(text: string): number {
  let depth = 0;
  let quote = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "{") {
      depth++;
    } else if ((char === ")" || char === "}") && depth > 0) {
      depth--;
    } else if (char === "," && depth === 0) {
      return at;
    }
  }
  return -1;
}

/**
 * A placeholder's identity for comparisons: `{{count}}`, `{{- html}}` or
 * `{{date, datetime}}`, with the default delimiters, whatever the project's syntax. Two
 * placeholders are "the same" when their keys are equal. Spacing is normalized, and so is
 * the format, as i18next reads it: each comma-separated format trimmed, format names in
 * lowercase, and options trimmed around `:` and `;`, without quotes around values
 * (`{{val, Number(minimumFractionDigits:2)}}` is `{{val, number(minimumFractionDigits: 2)}}`).
 * A name that starts with `-` without being unescaped keeps a space before it
 * (`{{ - html}}`), so it differs from `{{- html}}`.
 */
export function placeholderKey(token: PlaceholderToken): string {
  return normalizedPlaceholder(token, DEFAULT_SYNTAX);
}

/**
 * A placeholder written in a syntax, normalized as `placeholderKey` does: `%{count}` or
 * `__date, datetime__`. For messages that show placeholders in the project's syntax.
 */
export function normalizedPlaceholder(
  token: PlaceholderToken,
  syntax: InterpolationSyntax = DEFAULT_SYNTAX,
): string {
  const dash = token.unescaped ? "- " : token.name.startsWith("-") ? " " : "";
  const format = token.format === undefined ? "" : normalizeFormat(token.format);
  const formatted = format === "" ? "" : `, ${format}`;
  return `${syntax.prefix}${dash}${token.name}${formatted}${syntax.suffix}`;
}

/**
 * A placeholder's format as i18next reads it: formats split at commas outside parentheses,
 * empty ones dropped, each normalized by `normalizeFormatPart`, joined with `, `.
 */
function normalizeFormat(format: string): string {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at <= format.length; at++) {
    const char = format[at];
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if ((char === "," && depth === 0) || at === format.length) {
      const part = normalizeFormatPart(format.slice(start, at));
      if (part !== "") parts.push(part);
      start = at + 1;
    }
  }
  return parts.join(", ");
}

/**
 * One format, such as ` Number( minimumFractionDigits:2 )`: trimmed, the name in lowercase
 * (i18next's format names are case-insensitive), and each option of `name(key: value;
 * key: value)` trimmed, as `key: value`, with quotes around the value removed.
 */
function normalizeFormatPart(part: string): string {
  const trimmed = part.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) return trimmed.toLowerCase();
  const name = trimmed.slice(0, open).trim().toLowerCase();
  if (!trimmed.endsWith(")")) return `${name}${trimmed.slice(open)}`;
  const options = trimmed
    .slice(open + 1, -1)
    .split(";")
    .map(normalizeFormatOption);
  return `${name}(${options.filter((option) => option !== "").join("; ")})`;
}

/** `key: value`, trimmed, without quotes around the value; or the option trimmed. */
function normalizeFormatOption(option: string): string {
  const colon = option.indexOf(":");
  if (colon === -1) return option.trim();
  const key = option.slice(0, colon).trim();
  const value = option
    .slice(colon + 1)
    .trim()
    .replace(QUOTES_AROUND, "");
  return `${key}: ${value}`;
}

/** Quotes i18next strips from format option values. */
const QUOTES_AROUND = /^'+|'+$/g;

/** The placeholder tokens of a text, in order. */
export function placeholdersOf(
  text: string,
  syntax: InterpolationSyntax = DEFAULT_SYNTAX,
): PlaceholderToken[] {
  return tokenize(text, syntax).filter((t): t is PlaceholderToken => t.type === "placeholder");
}

/** The reference tokens of a text, in order. */
export function referencesOf(
  text: string,
  syntax: InterpolationSyntax = DEFAULT_SYNTAX,
): ReferenceToken[] {
  return tokenize(text, syntax).filter((t): t is ReferenceToken => t.type === "reference");
}

/** The masked form of the `n`th reference (1-based): `⟦n⟧`. */
export function maskToken(n: number): string {
  return `${MASK_OPEN}${n}${MASK_CLOSE}`;
}

/**
 * Replaces each nesting reference with a numbered token, `⟦1⟧`, `⟦2⟧`, …, in order of
 * appearance, and returns the references so `unmaskReferences` can put them back.
 * The same reference appearing twice gets two numbers. Text that already looks like a
 * masked reference (`⟦2⟧`) is locked the same way, with itself as its "reference", so that
 * unmasking gives the text back.
 */
export function maskReferences(
  text: string,
  syntax: InterpolationSyntax = DEFAULT_SYNTAX,
): { text: string; references: string[] } {
  const parts: string[] = [];
  const references: string[] = [];
  const lock = (raw: string): string => {
    references.push(raw);
    return maskToken(references.length);
  };
  for (const token of tokenize(text, syntax)) {
    if (token.type === "reference") {
      parts.push(lock(token.raw));
    } else {
      const raw = token.type === "text" ? token.text : token.raw;
      parts.push(raw.includes(MASK_OPEN) ? raw.replace(MASKED, lock) : raw);
    }
  }
  return { text: parts.join(""), references };
}

/**
 * Turns every `⟦n⟧` back into `references[n - 1]`. Tokens whose number has no reference
 * are left as they are, so the quality checks can report them.
 */
export function unmaskReferences(text: string, references: readonly string[]): string {
  if (!text.includes(MASK_OPEN)) return text;
  return text.replace(MASKED, (masked, n: string) => references[Number(n) - 1] ?? masked);
}

/** A masked reference as `maskToken` writes it: `⟦n⟧`, with no leading zeros. */
const MASKED = new RegExp(`${MASK_OPEN}([1-9][0-9]*)${MASK_CLOSE}`, "g");
