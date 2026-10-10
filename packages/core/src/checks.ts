// SPDX-License-Identifier: MIT
/**
 * Quality checks (design §5.7, QA-1, QA-2, FMT-4). The service runs them on every write,
 * the editor as you type and the CLI on imports: one implementation, so a translation the
 * editor accepts is one the API accepts. Plural rules and grapheme clusters come from the
 * runtime's ICU data, which differs between runtimes (see `plurals.ts`): the editor should
 * pass the categories the service reports as the `pluralOverride`, and the service has the
 * last word.
 */
import { canonicalValue } from "./hash.ts";
import { glossaryMatches } from "./glossary.ts";
import { categoriesFor, coversExactlyOne, type PluralOverride } from "./plurals.ts";
import { graphemeLength, languageName } from "./text.ts";
import {
  MASK_CLOSE,
  MASK_OPEN,
  normalizedPlaceholder,
  placeholderKey,
  placeholdersOf,
  tokenize,
} from "./tokens.ts";
import {
  DEFAULT_SYNTAX,
  type InterpolationSyntax,
  type EntryKind,
  isTranslatable,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type PluralForms,
  type TextValue,
  type TranslatableKind,
} from "./types.ts";

/** Errors refuse a translation (QA-1); warnings only inform (QA-2). */
export type Severity = "error" | "warning";

export const CHECKS = {
  /** The value's shape doesn't match the string: forms for a text string, or text for a plural. */
  invalid_value: "error",
  /** Empty, or only whitespace. */
  empty: "error",
  /** A placeholder of the English is missing, or appears fewer times. */
  placeholder_missing: "error",
  /** A placeholder that isn't in the English, or appears more times. */
  placeholder_extra: "error",
  /** A plural form the language needs is missing. */
  plural_form_missing: "error",
  /** A plural form the language doesn't use. */
  plural_form_unexpected: "error",
  /** A nesting reference of the English is missing, or appears fewer times. */
  reference_missing: "error",
  /** A nesting reference that isn't in the English (changed), or appears more times (repeated). */
  reference_extra: "error",
  /** Longer than the string's maximum length, in grapheme clusters. */
  max_length: "error",
  /** Identical to the English, and the English has letters. */
  identical: "warning",
  /** The numbers differ from the English. */
  numbers_differ: "warning",
  /** An HTML or i18next Trans tag, such as `<b>` or `<1>`, is missing or extra. */
  tags_differ: "warning",
  /** Leading/trailing whitespace or the number of line breaks differs from the source. */
  whitespace: "error",
  /** Two spaces in a row inside the text. */
  double_space: "warning",
  /** Ends with a different question mark, exclamation mark, ellipsis or colon. */
  end_punctuation: "warning",
  /** A glossary translation or a term marked never translate is missing. */
  glossary: "warning",
  /** Different source strings share the same translation within a file. */
  duplicate_translation: "warning",
  /** Identical source strings have different translations in a language. */
  consistency: "warning",
  /** Model-reported changes in meaning, omissions or grammar. */
  meaning: "warning",
} as const satisfies Record<string, Severity>;

export type CheckId = keyof typeof CHECKS;

export interface MeaningNote {
  kind: "changed" | "omission" | "grammar";
  source?: string;
  translation?: string;
  explanation: string;
}
export interface CheckResult {
  meaning?: MeaningNote;
  sourceHash?: string;
  sourceDescription?: string;
  check: CheckId;
  severity: Severity;
  /** A sentence for people, such as `Placeholder {{total}} is missing.` */
  message: string;
  /** For plural strings: the form the result is about. */
  form?: PluralCategory;
  /** The placeholder, reference or number concerned, such as `{{total}}`. */
  value?: string;
  /** For `max_length`: the limit and the length found. */
  limit?: number;
  length?: number;
}

export interface CheckInput {
  kind: TranslatableKind;
  /** The English: text, or forms by category. */
  source: TextValue;
  /** The candidate translation, unmasked (references as `$t(…)`, not `⟦n⟧`). */
  translation: TextValue;
  /** The target language. */
  language: string;
  /** The string's maximum length, if it has one. */
  maxLength?: number | null;
  syntax?: InterpolationSyntax;
  pluralOverride?: PluralOverride;
  glossary?: {
    term: string;
    translation?: string | null;
    kind: "translate" | "keep";
    caseSensitive?: boolean;
  }[];
}

/**
 * Runs every check and returns the results, errors first, in a stable order: by severity,
 * then in the order of `CHECKS`, then by plural form in CLDR order, then in order of
 * appearance (placeholders and references missing in English order, extra ones in the
 * translation's order).
 *
 * - Text strings: the translation must be a string. Placeholders (by `placeholderKey`) and
 *   references (by raw text) are compared as multisets with the English.
 * - Plural and ordinal strings: the translation must be forms, with exactly the categories
 *   `categoriesFor(language, kind, source)` returns (missing ones are
 *   `plural_form_missing`, others `plural_form_unexpected`). Each form is compared with the
 *   English `other` form: every placeholder of English `other` must be present as many
 *   times, except that a form may leave out `{{count}}` (any placeholder named `count`)
 *   when `coversExactlyOne()` holds for its category (with its `zero` option when English
 *   has a zero form, since i18next then sends 0 to that form); a placeholder that appears
 *   in no English form, or more often than in every English form, is `placeholder_extra`.
 *   References are compared with English `other` the same way. Each form is checked for
 *   `empty` and `max_length`.
 * - A value of the wrong shape is only `invalid_value` (a form that isn't text too), an
 *   empty text or form is only `empty`, and a form the language doesn't use is only
 *   `plural_form_unexpected`: nothing else is checked in them.
 * - A text or form may stay empty, or only whitespace, when its English (the same
 *   category, or `other`) is too, as in i18next's `key_zero: ""` idiom: it is accepted
 *   when its whitespace matches the source (line endings normalized).
 * - `max_length` counts grapheme clusters of the stored text, placeholders and references
 *   included.
 * - `identical`: a text, or a form, equal to the English (the same category, or `other`),
 *   when the English has at least one letter outside placeholders and references.
 *   Canonically equivalent text (the same after NFC normalization) counts as equal.
 * - `numbers_differ`: the multisets of digit sequences outside placeholders and references
 *   differ from the English (the same category, or `other`, for plurals). Digits of every
 *   script count by their value, and leading zeros are ignored: `٤٢` and `042` are `42`.
 * - Whitespace errors compare edges and line-break counts with the same source form
 *   (or `other`). CRLF and LF are equivalent. Typing warnings compare tags as multisets,
 *   double spaces, and final question marks, exclamation marks, ellipses and colons.
 *
 * Messages show placeholders in the project's syntax; `value` holds the `placeholderKey`,
 * the reference's raw text or the number as written. For plural strings, an invalid
 * language tag throws a `RangeError`.
 */
export function checkTranslation(input: CheckInput): CheckResult[] {
  const results = input.kind === "text" ? checkText(input) : checkForms(input, input.kind);
  return results.sort(compareResults);
}

/** The errors among results. */
export function errorsOf(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => result.severity === "error");
}

/** Whether any result is an error. */
export function hasErrors(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.severity === "error");
}

/** Checks a text string. */
function checkText(input: CheckInput): CheckResult[] {
  if (typeof input.translation !== "string") {
    return [result("invalid_value", "Text is expected, not plural forms.")];
  }
  const syntax = input.syntax ?? DEFAULT_SYNTAX;
  const english = analyze(englishText(input.source), syntax);
  const results: CheckResult[] = [];
  checkValue(results, input.translation, {
    required: english,
    allowed: limitsOf([english]),
    counterpart: english,
    countOptional: false,
    optional: optionalPlaceholders(syntax, input.language),
    maxLength: input.maxLength,
    syntax,
    glossary: input.glossary,
  });
  return results;
}

/** Checks a plural or ordinal string: its categories, then each form it needs. */
function checkForms(input: CheckInput, kind: "plural" | "ordinal"): CheckResult[] {
  const { translation, language } = input;
  if (!isForms(translation)) return [result("invalid_value", "Plural forms are expected.")];
  const syntax = input.syntax ?? DEFAULT_SYNTAX;
  const source = englishForms(input.source);
  const expected = categoriesFor(language, kind, source, input.pluralOverride);
  const english = analyzeForms(source, syntax);
  const other = otherOf(english) ?? analyze("", syntax);
  const allowed = limitsOf(english.values());
  const coverage = { ordinal: kind === "ordinal", zero: source.zero !== undefined };
  const results = unexpectedForms(translation, expected, language);
  for (const category of expected) {
    const value: unknown = translation[category];
    if (value === undefined) {
      results.push(
        result("plural_form_missing", `The ${category} form is missing.`, {
          form: category,
        }),
      );
    } else if (typeof value !== "string") {
      results.push(
        result("invalid_value", `The ${category} form must be text.`, {
          form: category,
        }),
      );
    } else {
      checkValue(results, value, {
        required: other,
        allowed,
        counterpart: english.get(category) ?? other,
        countOptional: coversExactlyOne(language, category, coverage),
        optional: optionalPlaceholders(syntax, language),
        maxLength: input.maxLength,
        syntax,
        form: category,
        glossary: input.glossary,
      });
    }
  }
  return results;
}

/** The forms of a translation that the language doesn't use, in the translation's order. */
function unexpectedForms(
  forms: PluralForms,
  expected: readonly PluralCategory[],
  language: string,
): CheckResult[] {
  const results: CheckResult[] = [];
  const needed = new Set<string>(expected);
  for (const [name, value] of Object.entries(forms)) {
    if (needed.has(name) || value === undefined) continue;
    const message = `The ${name} form isn't used in ${languageName(language)}.`;
    const details = isCategory(name) ? { form: name } : { value: name };
    results.push(result("plural_form_unexpected", message, details));
  }
  return results;
}

/**
 * The placeholders (by `placeholderKey`) that `language` may leave out, from the syntax's
 * `optional` list. Each is written as in the English, in any of the project's delimiters.
 */
export function optionalPlaceholders(syntax: InterpolationSyntax, language: string): Set<string> {
  const keys = new Set<string>();
  for (const entry of syntax.optional ?? []) {
    if (!entry.languages.includes(language)) continue;
    for (const token of placeholdersOf(entry.placeholder, syntax)) keys.add(placeholderKey(token));
  }
  return keys;
}

/** What a text or a form is compared with. */
interface Comparison {
  /** The English whose placeholders and references must all be there: the text, or `other`. */
  required: Analysis;
  /** The most times each placeholder and reference may appear. */
  allowed: Limits;
  /** The English of the same form, or `other`, for `identical` and `numbers_differ`. */
  counterpart: Analysis;
  /** Whether placeholders named `count` may be left out. */
  countOptional: boolean;
  /** Placeholders (by `placeholderKey`) this language may leave out (`syntax.optional`). */
  optional: ReadonlySet<string>;
  maxLength?: number | null;
  syntax: InterpolationSyntax;
  form?: PluralCategory;
  glossary?: CheckInput["glossary"];
}

/**
 * Runs the checks on one text or form. An empty value is reported as such, and only that,
 * unless the English is empty too.
 */
function checkValue(results: CheckResult[], value: string, comparison: Comparison): void {
  const { form } = comparison;
  if (value.trim() === "") {
    if (comparison.counterpart.text.trim() === "") {
      const sourceWhitespace = comparison.counterpart.text.replace(LINE_BREAK, "\n");
      if (value.replace(LINE_BREAK, "\n") !== sourceWhitespace) {
        results.push(
          result("whitespace", sentence("Whitespace differs from the source", form), { form }),
        );
      }
      return;
    }
    const message = form ? `The ${form} form is empty.` : "The translation is empty.";
    results.push(result("empty", message, { form }));
    return;
  }
  const translation = analyze(value, comparison.syntax);
  compareTokens(results, "placeholders", translation, comparison);
  compareTokens(results, "references", translation, comparison);
  checkLength(results, value, comparison);
  checkIdentical(results, translation, comparison);
  checkNumbers(results, translation, comparison);
  checkTags(results, value, comparison);
  checkWhitespace(results, value, comparison);
  checkEndPunctuation(results, value, comparison);
  for (const entry of comparison.glossary ?? []) {
    if (glossaryMatches(comparison.counterpart.text, entry.term, entry.caseSensitive).length === 0)
      continue;
    const expected = entry.kind === "keep" ? entry.term : entry.translation;
    if (
      !expected ||
      value.normalize("NFC").toLowerCase().includes(expected.normalize("NFC").toLowerCase())
    )
      continue;
    const message =
      entry.kind === "keep"
        ? `Keep the glossary term “${entry.term}” unchanged`
        : `Use “${expected}” for the glossary term “${entry.term}”`;
    results.push(result("glossary", sentence(message, form), { form, value: entry.term }));
  }
}

type TokenKind = "placeholders" | "references";

/** Reports the placeholders or references that are missing, then those that are extra. */
function compareTokens(
  results: CheckResult[],
  kind: TokenKind,
  translation: Analysis,
  comparison: Comparison,
): void {
  const { form } = comparison;
  const found = translation[kind];
  const [missing, extra] =
    kind === "placeholders"
      ? (["placeholder_missing", "placeholder_extra"] as const)
      : (["reference_missing", "reference_extra"] as const);
  for (const [key, english] of comparison.required[kind]) {
    const count = found.get(key)?.count ?? 0;
    if (count >= english.count) continue;
    if (kind === "placeholders" && comparison.countOptional && english.name === "count") continue;
    if (kind === "placeholders" && count === 0 && comparison.optional.has(key)) continue;
    const message = missingMessage(kind, english.label, count, form);
    results.push(result(missing, message, { form, value: key }));
  }
  for (const [key, occurrences] of found) {
    const allowed = comparison.allowed[kind].get(key) ?? 0;
    if (occurrences.count <= allowed) continue;
    const message = extraMessage(kind, occurrences.label, allowed, form);
    results.push(result(extra, message, { form, value: key }));
  }
}

function missingMessage(
  kind: TokenKind,
  label: string,
  count: number,
  form: PluralCategory | undefined,
): string {
  const noun = kind === "placeholders" ? "Placeholder" : "Reference";
  if (count > 0) return sentence(`${noun} ${label} appears less often than in the English`, form);
  return form
    ? `${noun} ${label} is missing from the ${form} form.`
    : `${noun} ${label} is missing.`;
}

function extraMessage(
  kind: TokenKind,
  label: string,
  allowed: number,
  form: PluralCategory | undefined,
): string {
  if (kind === "references") {
    return sentence(`Reference ${label} isn't in the English, or is repeated`, form);
  }
  const problem = allowed === 0 ? "isn't in the English" : "appears more often than in the English";
  return sentence(`Placeholder ${label} ${problem}`, form);
}

/** Reports a value longer than the maximum length, in grapheme clusters. */
function checkLength(results: CheckResult[], value: string, comparison: Comparison): void {
  const { maxLength: limit, form } = comparison;
  if (limit === undefined || limit === null) return;
  const length = graphemeLength(value);
  if (length <= limit) return;
  const characters = limit === 1 ? "character" : "characters";
  const message = sentence(`At most ${limit} ${characters}; this has ${length}`, form);
  results.push(result("max_length", message, { form, limit, length }));
}

/** Warns about a value equal to an English that has letters. */
function checkIdentical(results: CheckResult[], translation: Analysis, comparison: Comparison) {
  const english = comparison.counterpart;
  if (!english.hasLetters || !sameText(translation.text, english.text)) return;
  const { form } = comparison;
  results.push(result("identical", sentence("Identical to the English", form), { form }));
}

/** Equal, or canonically equivalent (such as `é` and `e` with a combining acute accent). */
function sameText(a: string, b: string): boolean {
  return a === b || a.normalize("NFC") === b.normalize("NFC");
}

/** Warns when the numbers differ from the English. */
function checkNumbers(results: CheckResult[], translation: Analysis, comparison: Comparison) {
  const english = comparison.counterpart.numbers;
  const value =
    unmatchedNumber(english, translation.numbers) ?? unmatchedNumber(translation.numbers, english);
  if (value === undefined) return;
  const { form } = comparison;
  const message = sentence("The numbers differ from the English", form);
  results.push(result("numbers_differ", message, { form, value }));
}

/** The first number of `numbers`, as written, that `others` doesn't match, repeats counted. */
function unmatchedNumber(
  numbers: readonly Digits[],
  others: readonly Digits[],
): string | undefined {
  const available = new Map<string, number>();
  for (const { value } of others) available.set(value, (available.get(value) ?? 0) + 1);
  for (const { raw, value } of numbers) {
    const left = available.get(value) ?? 0;
    if (left === 0) return raw;
    available.set(value, left - 1);
  }
  return undefined;
}

/** Warns about the first tag that is missing, or else the first that is extra. */
function checkTags(results: CheckResult[], value: string, comparison: Comparison) {
  const english = tagsOf(comparison.counterpart.text);
  const translation = tagsOf(value);
  const { form } = comparison;
  const missing = firstUnmatched(english, translation);
  if (missing !== undefined) {
    const message = sentence(`Tag ${missing} is missing`, form);
    results.push(result("tags_differ", message, { form, value: missing }));
    return;
  }
  const extra = firstUnmatched(translation, english);
  if (extra === undefined) return;
  const message = sentence(`Tag ${extra} isn't in the English, or is repeated`, form);
  results.push(result("tags_differ", message, { form, value: extra }));
}

/** The tags of a text, without attributes: `<a href="…">` is `<a>`, `<br />` is `<br/>`. */
function tagsOf(text: string): string[] {
  return Array.from(text.matchAll(TAG), ([, closing, name, selfClosing]) => {
    return `<${closing}${name.toLowerCase()}${selfClosing}>`;
  });
}

const TAG = /<(\/?)([A-Za-z][\w.:-]*|[0-9]+)(?:\s[^<>]*?)?\s*(\/?)>/g;

/** The first item of `items` that `others` doesn't match, repeats counted. */
function firstUnmatched(items: readonly string[], others: readonly string[]): string | undefined {
  const available = new Map<string, number>();
  for (const item of others) available.set(item, (available.get(item) ?? 0) + 1);
  for (const item of items) {
    const left = available.get(item) ?? 0;
    if (left === 0) return item;
    available.set(item, left - 1);
  }
  return undefined;
}

/**
 * Rejects whitespace slips that change layout: a line break or space at either end
 * that the English doesn't have (or the other way round), a different number of line
 * breaks inside, and two spaces in a row.
 */
function checkWhitespace(results: CheckResult[], value: string, comparison: Comparison) {
  const english = comparison.counterpart.text;
  const { form } = comparison;
  for (const edge of ["start", "end"] as const) {
    const foundWhitespace = edgeWhitespace(value, edge).replace(LINE_BREAK, "\n");
    const expectedWhitespace = edgeWhitespace(english, edge).replace(LINE_BREAK, "\n");
    if (foundWhitespace === expectedWhitespace) continue;
    const found = describeWhitespace(foundWhitespace);
    const expected = describeWhitespace(expectedWhitespace);
    const message = mismatchMessage(edge === "start" ? "starts" : "ends", found, expected);
    results.push(result("whitespace", sentence(message, form), { form }));
  }
  const foundBreaks = lineBreaks(value.trim());
  const englishBreaks = lineBreaks(english.trim());
  if (foundBreaks !== englishBreaks) {
    const message = `The English has ${countOf(englishBreaks, "line break")} inside; the translation has ${foundBreaks}`;
    results.push(result("whitespace", sentence(message, form), { form }));
  }
  const doubleSpace = DOUBLE_SPACE.test(value.trim());
  if (doubleSpace) {
    results.push(result("double_space", sentence("Two spaces in a row", form), { form }));
  }
}

/** The whitespace before the first visible character, or after the last one. */
function edgeWhitespace(text: string, edge: "start" | "end"): string {
  if (text.trim() === "") return "";
  const match = edge === "start" ? LEADING_WHITESPACE.exec(text) : TRAILING_WHITESPACE.exec(text);
  return match?.[0] ?? "";
}

/**
 * Whitespace in words: "a line break", "2 line breaks", "a space", "3 spaces", or "" for
 * none. Line breaks win over spaces: they are what changes the layout.
 */
export function describeWhitespace(whitespace: string): string {
  const breaks = lineBreaks(whitespace);
  if (breaks > 0) return breaks === 1 ? "a line break" : `${breaks} line breaks`;
  const spaces = Array.from(whitespace).length;
  if (spaces === 0) return "";
  return spaces === 1 ? "a space" : `${spaces} spaces`;
}

/** Line breaks, counting `\r\n` as one. */
function lineBreaks(text: string): number {
  return text.match(LINE_BREAK)?.length ?? 0;
}

function countOf(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

const LEADING_WHITESPACE = /^\s+/;
const TRAILING_WHITESPACE = /\s+$/;
const LINE_BREAK = /\r\n|\r|\n/g;
const DOUBLE_SPACE = / {2}/;

/** Warns when the English and the translation end with different punctuation. */
function checkEndPunctuation(results: CheckResult[], value: string, comparison: Comparison) {
  const found = endPunctuation(value);
  const expected = endPunctuation(comparison.counterpart.text);
  if (found === expected) return;
  const { form } = comparison;
  const message = mismatchMessage("ends", found, expected);
  results.push(result("end_punctuation", sentence(message, form), { form }));
}

/** The punctuation that ends a text, in words, or "" for none of those compared. */
function endPunctuation(text: string): string {
  const end = text.trimEnd();
  if (end.endsWith("...") || end.endsWith("…") || end.endsWith("⋯")) return "an ellipsis";
  const last = end.slice(-1);
  if (QUESTION_MARKS.includes(last)) return "a question mark";
  if (EXCLAMATION_MARKS.includes(last)) return "an exclamation mark";
  if (COLONS.includes(last)) return "a colon";
  return "";
}

// Greek writes its question mark as a semicolon (U+037E, often typed as `;`).
const QUESTION_MARKS = ["?", "？", "؟", "\u037E", ";"];
const EXCLAMATION_MARKS = ["!", "！"];
const COLONS = [":", "："];

/** "The translation ends with a line break; the English doesn't", from both descriptions. */
function mismatchMessage(verb: "starts" | "ends", found: string, english: string): string {
  if (found === "") return `The English ${verb} with ${english}; the translation doesn't`;
  if (english === "") return `The translation ${verb} with ${found}; the English doesn't`;
  return `The translation ${verb} with ${found}; the English with ${english}`;
}

/** `Text (few form).` for a form, `Text.` otherwise. */
function sentence(text: string, form: PluralCategory | undefined): string {
  return form ? `${text} (${form} form).` : `${text}.`;
}

/** The optional fields of a result; those left undefined are omitted. */
type Details = Pick<CheckResult, "form" | "value" | "limit" | "length">;

function result(check: CheckId, message: string, details: Details = {}): CheckResult {
  const result: CheckResult = { check, severity: CHECKS[check], message };
  if (details.form !== undefined) result.form = details.form;
  if (details.value !== undefined) result.value = details.value;
  if (details.limit !== undefined) result.limit = details.limit;
  if (details.length !== undefined) result.length = details.length;
  return result;
}

const CHECK_ORDER = new Map(Object.keys(CHECKS).map((check, index) => [check, index]));
const FORM_ORDER = new Map<string, number>(PLURAL_CATEGORIES.map((form, index) => [form, index]));

/** Errors first; then in the order of `CHECKS`; then by form in CLDR order, no form last. */
function compareResults(a: CheckResult, b: CheckResult): number {
  return (
    severityRank(a) - severityRank(b) ||
    CHECK_ORDER.get(a.check)! - CHECK_ORDER.get(b.check)! ||
    formRank(a) - formRank(b)
  );
}

function severityRank(result: CheckResult): number {
  return result.severity === "error" ? 0 : 1;
}

function formRank(result: CheckResult): number {
  return result.form === undefined ? PLURAL_CATEGORIES.length : FORM_ORDER.get(result.form)!;
}

/** What the checks need to know about a text, from one pass of the tokenizer. */
interface Analysis {
  text: string;
  /** Placeholders by `placeholderKey`, in order of first appearance. */
  placeholders: Map<string, Occurrences>;
  /** References by raw text, in order of first appearance. */
  references: Map<string, Occurrences>;
  /** Digit sequences outside placeholders and references, in order. */
  numbers: Digits[];
  /** Whether a letter appears outside placeholders and references. */
  hasLetters: boolean;
}

interface Occurrences {
  count: number;
  /** A placeholder's name; a reference's raw text. */
  name: string;
  /** How messages show it: placeholders in the project's syntax, references as written. */
  label: string;
}

/** A sequence of digits: as written, and its value in ASCII digits without leading zeros. */
interface Digits {
  raw: string;
  value: string;
}

/** The most times each placeholder and reference may appear, by key. */
interface Limits {
  placeholders: Map<string, number>;
  references: Map<string, number>;
}

function analyze(text: string, syntax: InterpolationSyntax): Analysis {
  const analysis: Analysis = {
    text,
    placeholders: new Map(),
    references: new Map(),
    numbers: [],
    hasLetters: false,
  };
  for (const token of tokenize(text, syntax)) {
    if (token.type === "placeholder") {
      const key = placeholderKey(token);
      addOccurrence(analysis.placeholders, key, token.name, () =>
        normalizedPlaceholder(token, syntax),
      );
    } else if (token.type === "reference") {
      addOccurrence(analysis.references, token.raw, token.raw, () => token.raw);
    } else {
      addText(analysis, token.text);
    }
  }
  return analysis;
}

/**
 * Records the letters and numbers of plain text, and the masked references (`⟦3⟧`) left in
 * it: `unmaskReferences` leaves those whose number has no reference, and they count as
 * references that aren't in the English.
 */
function addText(analysis: Analysis, text: string): void {
  let plain = text;
  if (text.includes(MASK_OPEN)) {
    plain = text.replace(LEFTOVER_MASK, (mask) => {
      addOccurrence(analysis.references, mask, mask, () => mask);
      return " ";
    });
  }
  if (!analysis.hasLetters) analysis.hasLetters = LETTER.test(plain);
  for (const [raw] of plain.matchAll(DIGIT_SEQUENCE)) {
    analysis.numbers.push({ raw, value: numericValue(raw) });
  }
}

const LEFTOVER_MASK = new RegExp(`${MASK_OPEN}[0-9]+${MASK_CLOSE}`, "g");
const LETTER = /\p{L}/u;
const DIGIT_SEQUENCE = /\p{Nd}+/gu;

/** Counts one more occurrence of `key`. */
function addOccurrence(
  map: Map<string, Occurrences>,
  key: string,
  name: string,
  label: () => string,
): void {
  const occurrences = map.get(key);
  if (occurrences !== undefined) occurrences.count++;
  else map.set(key, { count: 1, name, label: label() });
}

/** The analysis of each English form, in CLDR order. */
function analyzeForms(
  forms: PluralForms,
  syntax: InterpolationSyntax,
): Map<PluralCategory, Analysis> {
  const analyses = new Map<PluralCategory, Analysis>();
  for (const [category, form] of stringForms(forms)) {
    analyses.set(category, analyze(form, syntax));
  }
  return analyses;
}

/** For each placeholder and reference, the most times any of the analyses has it. */
function limitsOf(analyses: Iterable<Analysis>): Limits {
  const limits: Limits = { placeholders: new Map(), references: new Map() };
  for (const analysis of analyses) {
    for (const kind of ["placeholders", "references"] as const) {
      for (const [key, { count }] of analysis[kind]) {
        limits[kind].set(key, Math.max(limits[kind].get(key) ?? 0, count));
      }
    }
  }
  return limits;
}

/** A digit sequence's value, in ASCII digits without leading zeros: `٠٤٢` gives `42`. */
function numericValue(digits: string): string {
  const ascii = ASCII_DIGITS.test(digits) ? digits : Array.from(digits, digitValue).join("");
  return ascii.replace(LEADING_ZEROS, "");
}

const ASCII_DIGITS = /^[0-9]+$/;
const LEADING_ZEROS = /^0+(?=[0-9])/;
const DIGIT = /^\p{Nd}$/u;
const digitValues = new Map<number, number>();

/**
 * The value, 0 to 9, of a decimal digit of any script, cached. Unicode assigns decimal digits
 * in runs of ten, from 0 to 9, and runs that sit next to one another are whole (the
 * mathematical digits are five runs in a row), so a digit's value is its distance from the
 * first of the digits around it, modulo 10.
 */
function digitValue(digit: string): number {
  const code = digit.codePointAt(0)!;
  let value = digitValues.get(code);
  if (value === undefined) {
    let zero = code;
    while (DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    value = (code - zero) % 10;
    digitValues.set(code, value);
  }
  return value;
}

/** Text for a text string; a mismatched value (forms) gives its `other` form. */
function englishText(source: TextValue): string {
  if (typeof source === "string") return source;
  return otherOf(stringForms(englishForms(source))) ?? "";
}

/** Forms for a plural string; a mismatched value (text) becomes the `other` form. */
function englishForms(source: TextValue): PluralForms {
  if (typeof source === "string") return { other: source };
  return isForms(source) ? source : {};
}

/** The forms that are strings, in CLDR order. */
function stringForms(forms: PluralForms): Map<PluralCategory, string> {
  const strings = new Map<PluralCategory, string>();
  for (const category of PLURAL_CATEGORIES) {
    const form: unknown = forms[category];
    if (typeof form === "string") strings.set(category, form);
  }
  return strings;
}

function isForms(value: unknown): value is PluralForms {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCategory(name: string): name is PluralCategory {
  return FORM_ORDER.has(name);
}

/**
 * The `other` form of forms in CLDR order. English always has one; should it be missing,
 * the last form stands in for it.
 */
function otherOf<V>(forms: Map<PluralCategory, V>): V | undefined {
  let last: V | undefined;
  for (const value of forms.values()) last = value;
  return forms.get("other") ?? last;
}

export interface FileTranslation {
  id: number;
  fileId: number;
  language: string;
  file?: string;
  key: string;
  kind: EntryKind;
  source: TextValue;
  translation: TextValue;
}

/** One warning per colliding value/form, grouped in linear time for large files. */
export function checkDuplicateTranslations(
  entries: readonly FileTranslation[],
): Map<string, CheckResult[]> {
  type FormEntry = { entry: FileTranslation; source: string; form?: PluralCategory };
  const groups = new Map<string, FormEntry[]>();
  for (const entry of entries) {
    if (!isTranslatable(entry.kind)) continue;
    const textShape = entry.kind === "text" && typeof entry.translation === "string";
    const pluralShape = entry.kind !== "text" && typeof entry.translation !== "string";
    if (!textShape && !pluralShape) continue;
    const forms =
      typeof entry.translation === "string"
        ? [[undefined, entry.translation] as const]
        : Object.entries(entry.translation);
    for (const [form, text] of forms) {
      if (typeof text !== "string") continue;
      if (form !== undefined && !(PLURAL_CATEGORIES as readonly string[]).includes(form)) continue;
      const value = text.normalize("NFC").trim().toLowerCase();
      if (graphemeLength(value) <= 2) continue;
      const source =
        typeof entry.source === "string"
          ? entry.source
          : (entry.source[form as PluralCategory] ?? entry.source.other ?? "");
      const key = JSON.stringify([entry.fileId, entry.language, entry.kind, form, value]);
      const group = groups.get(key) ?? [];
      group.push({
        entry,
        source: source.normalize("NFC"),
        form: form as PluralCategory | undefined,
      });
      groups.set(key, group);
    }
  }
  const checks = new Map<string, CheckResult[]>();
  for (const group of groups.values()) {
    const first = group[0];
    const different = group.find((row) => row.source !== first.source);
    if (!different) continue;
    for (const row of group) {
      const peer = row.source === first.source ? different : first;
      const key = JSON.stringify([row.entry.id, row.entry.language]);
      const results = checks.get(key) ?? [];
      results.push(
        result(
          "duplicate_translation",
          `Same as ${peer.entry.key}, whose English is ${JSON.stringify(peer.source)}.`,
          { form: row.form, value: peer.entry.key },
        ),
      );
      checks.set(key, results);
    }
  }
  return checks;
}

/** Identical sources, including their kind and plural shape, should agree across files. */
export function checkTranslationConsistency(
  entries: readonly FileTranslation[],
): Map<string, CheckResult[]> {
  const groups = new Map<string, FileTranslation[]>();
  for (const entry of entries) {
    if (!isTranslatable(entry.kind)) continue;
    const source = canonicalValue(entry.source);
    const key = JSON.stringify([entry.language, entry.kind, source]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const valueOf = (entry: FileTranslation) => canonicalValue(entry.translation);
  const checks = new Map<string, CheckResult[]>();
  for (const group of groups.values()) {
    const first = group[0];
    const firstValue = valueOf(first);
    const different = group.find((entry) => valueOf(entry) !== firstValue);
    if (!different) continue;
    for (const entry of group) {
      const peer = valueOf(entry) === firstValue ? different : first;
      const key = peer.file ? `${peer.file} › ${peer.key}` : peer.key;
      checks.set(JSON.stringify([entry.id, entry.language]), [
        result("consistency", `Different from ${key}, which has the same English.`, { value: key }),
      ]);
    }
  }
  return checks;
}

export function meaningWarnings(
  notes: readonly MeaningNote[],
  sourceHash?: string,
  sourceDescription?: string,
): CheckResult[] {
  return notes.map((note) => ({
    check: "meaning",
    severity: "warning",
    message: note.explanation,
    meaning: note,
    ...(sourceHash ? { sourceHash } : {}),
    ...(sourceDescription === undefined ? {} : { sourceDescription }),
  }));
}
