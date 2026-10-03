// SPDX-License-Identifier: MIT
/**
 * Counting words and characters (design §5.2, §5.9, FMT-4), and language tags, with the
 * `Intl` APIs every runtime has.
 */
import { tokenize } from "./tokens.ts";
import type { EntryKind, InterpolationSyntax, TextValue } from "./types.ts";

/** Counts user-perceived characters (grapheme clusters), as length limits do (FMT-4). */
export function graphemeLength(text: string): number {
  if (!NON_ASCII.test(text) && !text.includes("\r\n")) return text.length;
  let length = 0;
  for (const _ of graphemeSegmenter().segment(text)) length++;
  return length;
}

/** In ASCII text every character is a grapheme of its own, except `\r\n`. */
const NON_ASCII = /[\u0080-\uffff]/;

let graphemes: Intl.Segmenter | undefined;

function graphemeSegmenter(): Intl.Segmenter {
  return (graphemes ??= new Intl.Segmenter("en", { granularity: "grapheme" }));
}

/**
 * Counts words with `Intl.Segmenter` (word-like segments), leaving out placeholders and
 * nesting references. `locale` is the text's language (default `en`).
 */
export function countWords(
  text: string,
  options: { syntax?: InterpolationSyntax; locale?: string } = {},
): number {
  if (text.trim() === "") return 0;
  let words = 0;
  for (const segment of wordSegmenter(options.locale ?? "en").segment(plainText(text, options))) {
    if (segment.isWordLike) words++;
  }
  return words;
}

/** The text with each placeholder and reference replaced by a space. */
function plainText(text: string, options: { syntax?: InterpolationSyntax }): string {
  return tokenize(text, options.syntax)
    .map((token) => (token.type === "text" ? token.text : " "))
    .join("");
}

const wordSegmenters = new Map<string, Intl.Segmenter>();

/** A cached word segmenter for a locale; English for tags that aren't valid. */
function wordSegmenter(locale: string): Intl.Segmenter {
  return cached(wordSegmenters, locale, () => {
    try {
      return new Intl.Segmenter(locale, { granularity: "word" });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return new Intl.Segmenter("en", { granularity: "word" });
    }
  });
}

/**
 * The words of an English entry: `countWords` for text; for plural strings, the sum over
 * its forms; 0 for references and literals.
 */
export function sourceWords(
  kind: EntryKind,
  value: TextValue | undefined,
  options: { syntax?: InterpolationSyntax; locale?: string } = {},
): number {
  if (kind === "reference" || kind === "literal" || value === undefined) return 0;
  if (typeof value === "string") return countWords(value, options);
  let words = 0;
  for (const form of Object.values(value)) {
    if (typeof form === "string") words += countWords(form, options);
  }
  return words;
}

/**
 * The canonical form of a BCP 47 language tag (`pt-br` → `pt-BR`, `zh-hans` → `zh-Hans`),
 * or `null` if it isn't a valid tag.
 */
export function canonicalLanguageTag(tag: string): string | null {
  if (typeof tag !== "string" || tag === "" || /[\s_]/.test(tag)) return null;
  try {
    const canonical = Intl.getCanonicalLocales(tag)[0];
    if (!canonical) return null;
    // JavaScriptCore leaves these CLDR language aliases unexpanded.
    if (/^tl(?:-|$)/.test(canonical)) return canonical.replace(/^tl/, "fil");
    if (/^sh(?:-|$)/.test(canonical)) {
      const script = new Intl.Locale(canonical).script;
      return canonical.replace(/^sh/, script ? "sr" : "sr-Latn");
    }
    return canonical;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Whether a tag is a valid BCP 47 language tag. */
export function isValidLanguageTag(tag: string): boolean {
  return canonicalLanguageTag(tag) !== null;
}

/**
 * The language's text direction, from `Intl.Locale` text info when the runtime has it, and
 * from a list of right-to-left scripts and languages otherwise (Arabic, Hebrew, Persian,
 * Urdu, Pashto, Sindhi, Yiddish, Dhivehi, Uyghur, Central Kurdish, and tags with the
 * `Arab`, `Aran`, `Hebr`, `Thaa`, `Syrc`, `Nkoo`, `Adlm` or `Rohg` script).
 */
export function textDirection(tag: string): "ltr" | "rtl" {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(canonicalLanguageTag(tag) ?? tag);
  } catch {
    return "ltr";
  }
  return directionFromTextInfo(locale) ?? directionFromScript(locale);
}

/** `Intl.Locale` text info: `getTextInfo()` in newer runtimes, `textInfo` in Node 22. */
interface WithTextInfo {
  getTextInfo?: () => { direction?: string } | undefined;
  textInfo?: { direction?: string };
}

function directionFromTextInfo(locale: Intl.Locale): "ltr" | "rtl" | undefined {
  const withInfo = locale as unknown as WithTextInfo;
  const info =
    typeof withInfo.getTextInfo === "function" ? withInfo.getTextInfo() : withInfo.textInfo;
  const direction = info?.direction;
  return direction === "ltr" || direction === "rtl" ? direction : undefined;
}

const RTL_SCRIPTS = new Set(["Arab", "Aran", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg"]);
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "ps", "sd", "yi", "dv", "ug", "ckb"]);

/** The direction of the tag's script, or of its likely script, or of its language. */
function directionFromScript(locale: Intl.Locale): "ltr" | "rtl" {
  const script = locale.script ?? likelyScript(locale);
  if (script !== undefined) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  return RTL_LANGUAGES.has(locale.language) ? "rtl" : "ltr";
}

function likelyScript(locale: Intl.Locale): string | undefined {
  try {
    return locale.maximize().script;
  } catch {
    return undefined;
  }
}

/**
 * The language's name with `Intl.DisplayNames`, in `displayLanguage` (default English),
 * such as "German" or "Portuguese (Brazil)". Falls back to the tag.
 */
export function languageName(tag: string, displayLanguage = "en"): string {
  try {
    return displayNames(displayLanguage).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const displayNamesCache = new Map<string, Intl.DisplayNames>();

/** Cached language names: "Portuguese (Brazil)" rather than "Brazilian Portuguese". */
function displayNames(displayLanguage: string): Intl.DisplayNames {
  return cached(
    displayNamesCache,
    displayLanguage,
    () =>
      new Intl.DisplayNames([displayLanguage], {
        type: "language",
        languageDisplay: "standard",
        fallback: "code",
      }),
  );
}

const CACHE_LIMIT = 100;

/** The cached value for `key`, created on a miss. The cache is emptied when it grows too big. */
function cached<V>(cache: Map<string, V>, key: string, create: () => V): V {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, value);
  }
  return value;
}
