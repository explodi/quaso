// SPDX-License-Identifier: MIT
/**
 * Plural rules from the ICU data built into every JavaScript runtime (design §5.2).
 *
 * `Intl.PluralRules(language).resolvedOptions().pluralCategories` lists the categories a
 * language needs; i18next uses the same API at runtime. Runtimes disagree on the order they
 * list categories in, so everything here returns CLDR order:
 * `zero, one, two, few, many, other`.
 *
 * Runtimes also differ in which languages their ICU data covers, and in its CLDR version:
 * Some ICU builds have no rules for `cv`, `kok` or `ie`. Where the
 * runtime has no rules, everything here uses CLDR's root rules (only `other`), the same on
 * every machine, and `hasPluralRules` says so; a plural override then gives the categories.
 * The service's results are the reference: the editor should check with the categories the
 * service reports (as the override), so that both expect the same forms.
 */
import { canonicalLanguageTag } from "./text.ts";
import { PLURAL_CATEGORIES, type PluralCategory, type PluralForms } from "./types.ts";

/** A per-language override of the categories, in case the app's runtime has older CLDR data. */
export interface PluralOverride {
  cardinal?: PluralCategory[];
  ordinal?: PluralCategory[];
}

export interface PluralOptions {
  /** Ordinal rules (`place_ordinal_one`) instead of cardinal ones. */
  ordinal?: boolean;
  /**
   * Add `zero` even if the language doesn't need it: when English has an explicit `_zero`
   * form, every language gets one, because i18next looks up `key_zero` for a count of 0 in
   * any language.
   */
  zero?: boolean;
  /** Replaces the categories from `Intl.PluralRules`. */
  override?: PluralOverride;
}

/** Options of `exampleNumbers` and `coversExactlyOne`. */
export interface CoverageOptions {
  /** Ordinal rules instead of cardinal ones. */
  ordinal?: boolean;
  /**
   * The string has a `zero` form (cardinal strings whose English has one): i18next then
   * uses `key_zero` for a count of 0 in any language, so 0 leaves every other category.
   * Punjabi `one` covers 0 and 1, but only 1 when the string has a zero form.
   */
  zero?: boolean;
}

/** Sorts categories into CLDR order, dropping duplicates and unknown names. */
export function sortCategories(categories: Iterable<string>): PluralCategory[] {
  const set = new Set(categories);
  return PLURAL_CATEGORIES.filter((category) => set.has(category));
}

/**
 * The categories a language needs, in CLDR order. Always includes `other`. Invalid
 * language tags throw a `RangeError`.
 */
export function pluralCategories(language: string, options: PluralOptions = {}): PluralCategory[] {
  const ordinal = options.ordinal === true;
  const rules = pluralRules(language, ordinal);
  const override = ordinal ? options.override?.ordinal : options.override?.cardinal;
  const categories = new Set<string>(override ?? rules.categories);
  categories.add("other");
  if (options.zero) categories.add("zero");
  return sortCategories(categories);
}

/**
 * The categories a plural or ordinal string needs in a language: the language's
 * categories, plus `zero` for cardinal strings whose English has a `zero` form.
 */
export function categoriesFor(
  language: string,
  kind: "plural" | "ordinal",
  english: PluralForms,
  override?: PluralOverride,
): PluralCategory[] {
  return pluralCategories(language, {
    ordinal: kind === "ordinal",
    zero: kind === "plural" && english.zero !== undefined,
    override,
  });
}

/**
 * Example numbers for a category, for the editor and the prompts: integer ranges from 0 to
 * 1000 joined with an en dash, the first few of them, then an ellipsis if there are more;
 * plus a decimal example (such as `1.5`) if decimals also fall in the category.
 *
 * Examples: Polish `one` gives `"1"`; Polish `few` gives `"2–4, 22–24, 32–34, …"`; English
 * `other` gives `"0, 2–1000, …, 1.5"`. A `zero` category the language doesn't have natively
 * (added because English has `_zero`) gives `"0"`.
 *
 * The ellipsis also follows when the category goes on after 1000. A category with no integer
 * up to 1000 shows `1000000` if that falls in it (French `many` gives `"1000000"`). The
 * decimal is the first of 1.5, 0.5, 2.5 and 10.5 in the category; ordinals have none. With
 * `zero`, 0 is left out of every other category (Punjabi `one` gives `"1"`, not `"0–1"`).
 * A category the runtime's rules don't have (because it doesn't know the language, say)
 * gives `""`: its numbers are unknown.
 */
export function exampleNumbers(
  language: string,
  category: PluralCategory,
  options: CoverageOptions & { maxRanges?: number } = {},
): string {
  const ordinal = options.ordinal === true;
  const rules = pluralRules(language, ordinal);
  if (!rules.categories.includes(category)) return category === "zero" ? "0" : "";
  const ranges = integerRanges(rules, category, hasZeroForm(options));
  const maxRanges = Math.max(1, options.maxRanges ?? 3);
  const parts = ranges.slice(0, maxRanges).map(formatRange);
  const continues = ranges.length > maxRanges || rules.beyond.has(category);
  if (continues) parts.push("…");
  else if (rules.select(LARGE_NUMBER) === category) parts.push(String(LARGE_NUMBER));
  const decimal = ordinal ? undefined : EXAMPLE_DECIMALS.find((n) => rules.select(n) === category);
  if (decimal !== undefined) parts.push(String(decimal));
  return parts.join(", ");
}

/**
 * Whether a category covers exactly one number in a language, integers and decimals
 * included, so a form may leave out `{{count}}` (design §5.7). Polish `one` covers only 1;
 * Russian `one` covers 1, 21, 31, …; French `one` covers 0, 1 and 1.5. A `zero` category the
 * language doesn't have natively covers only 0. With `zero`, 0 is left out of every other
 * category: Punjabi `one` covers 0 and 1, but only 1 when the string has a zero form. A
 * category the runtime's rules don't have is assumed to cover many numbers.
 */
export function coversExactlyOne(
  language: string,
  category: PluralCategory,
  options: CoverageOptions = {},
): boolean {
  const ordinal = options.ordinal === true;
  const rules = pluralRules(language, ordinal);
  if (!rules.categories.includes(category)) return category === "zero";
  const integers = integerRanges(rules, category, hasZeroForm(options));
  let count = integers.reduce((sum, [first, last]) => sum + last - first + 1, 0);
  if (!ordinal) count += COVERAGE_DECIMALS.filter((n) => rules.select(n) === category).length;
  return count === 1;
}

/**
 * Whether the runtime's ICU data has plural rules for the language. Without them, every
 * function here uses CLDR's root rules (only `other`), whatever the runtime's default
 * locale; since i18next in an app whose runtime knows the language will look up its real
 * categories, a plural override should then set them. Invalid tags throw a `RangeError`.
 */
export function hasPluralRules(language: string, options: { ordinal?: boolean } = {}): boolean {
  return pluralRules(language, options.ordinal === true).known;
}

/** Whether 0 goes to a zero form of its own: only for cardinal strings (see `CoverageOptions`). */
function hasZeroForm(options: CoverageOptions): boolean {
  return options.zero === true && options.ordinal !== true;
}

/**
 * The runs of integers of a category, from 0 to `MAX_INTEGER`; with `zero`, without 0
 * unless the category is `zero`.
 */
function integerRanges(rules: Rules, category: PluralCategory, zero: boolean): [number, number][] {
  const ranges = rules.ranges.get(category) ?? [];
  if (!zero || category === "zero" || ranges[0]?.[0] !== 0) return ranges;
  const [[, last], ...rest] = ranges;
  return last === 0 ? rest : [[1, last], ...rest];
}

/** Integers from 0 to this are sampled for examples and coverage. */
const MAX_INTEGER = 1000;
/** Integers above `MAX_INTEGER` up to this tell whether a category continues past it. */
const BEYOND_INTEGER = 1100;
/** A larger sample, for categories with no integer up to `MAX_INTEGER`, such as French `many`. */
const LARGE_NUMBER = 1_000_000;
/** The decimals an example may show, most familiar first. */
const EXAMPLE_DECIMALS = [1.5, 0.5, 2.5, 10.5];
/** The decimals `coversExactlyOne` counts. */
const COVERAGE_DECIMALS = [0.5, 1.5, 2.5, 10.5, 100.5];

/** A language's rules for one type, with the integers of each category as ranges. */
interface Rules {
  /** Whether the runtime has rules for the language (else these are CLDR's root rules). */
  known: boolean;
  /** The categories, in CLDR order. */
  categories: PluralCategory[];
  select(n: number): PluralCategory;
  /** Runs of consecutive integers from 0 to `MAX_INTEGER`, as `[first, last]`, by category. */
  ranges: Map<PluralCategory, [number, number][]>;
  /** The categories of the integers after `MAX_INTEGER`, up to `BEYOND_INTEGER`. */
  beyond: Set<PluralCategory>;
}

/**
 * Rules by type and language tag, least recently used first. Both the tag as given and its
 * canonical form are keys, so `pt-br` and `pt-BR` share rules. Entries are small; the limit
 * is far above twice the number of languages a project has, so loops over strings and
 * languages never rebuild rules.
 */
const rulesCache = new Map<string, Rules>();
const CACHE_LIMIT = 2000;

/** The rules of a language, cached. Invalid language tags throw a `RangeError`. */
function pluralRules(language: string, ordinal: boolean): Rules {
  const type = ordinal ? "ordinal" : "cardinal";
  const key = `${type}:${language}`;
  let rules = rulesCache.get(key);
  if (rules !== undefined) {
    remember(key, rules);
    return rules;
  }
  const canonicalLanguage = canonicalLanguageTag(language);
  if (canonicalLanguage === null) throw new RangeError(`Invalid language tag: ${language}`);
  const canonical = `${type}:${canonicalLanguage}`;
  // JavaScriptCore does not canonicalize every alias in Intl.Locale or PluralRules.
  rules = rulesCache.get(canonical) ?? createRules(canonicalLanguage, ordinal);
  remember(canonical, rules);
  if (key !== canonical) remember(key, rules);
  return rules;
}

/** Caches rules as the most recently used, evicting the least recently used when full. */
function remember(key: string, rules: Rules): void {
  if (!rulesCache.delete(key) && rulesCache.size >= CACHE_LIMIT) {
    rulesCache.delete(rulesCache.keys().next().value!);
  }
  rulesCache.set(key, rules);
}

function createRules(language: string, ordinal: boolean): Rules {
  const intl = new Intl.PluralRules(language, { type: ordinal ? "ordinal" : "cardinal" });
  if (!supports(intl, language)) return ROOT_RULES;
  const select = (n: number) => intl.select(n) as PluralCategory;
  const beyond = new Set<PluralCategory>();
  for (let n = MAX_INTEGER + 1; n <= BEYOND_INTEGER; n++) beyond.add(select(n));
  return {
    known: true,
    categories: sortCategories(intl.resolvedOptions().pluralCategories),
    select,
    ranges: rangesByCategory(select),
    beyond,
  };
}

/** CLDR's root rules: every number is `other`. */
const ROOT_RULES: Rules = {
  known: false,
  categories: ["other"],
  select: () => "other",
  ranges: new Map([["other", [[0, MAX_INTEGER]]]]),
  beyond: new Set(["other"]),
};

/**
 * Whether the runtime has rules for the language. For a language it doesn't know,
 * `Intl.PluralRules` quietly uses the runtime's default locale, which differs from one
 * machine to the next; CLDR's root rules (only `other`) are used instead, so that results
 * are the same on every machine with the same runtime.
 */
function supports(intl: Intl.PluralRules, language: string): boolean {
  const resolved = new Intl.Locale(intl.resolvedOptions().locale).language;
  return resolved === new Intl.Locale(language).language;
}

/** Groups the integers from 0 to `MAX_INTEGER` into runs by category. */
function rangesByCategory(
  select: (n: number) => PluralCategory,
): Map<PluralCategory, [number, number][]> {
  const ranges = new Map<PluralCategory, [number, number][]>();
  for (let n = 0; n <= MAX_INTEGER; n++) {
    const category = select(n);
    let list = ranges.get(category);
    if (list === undefined) ranges.set(category, (list = []));
    const last = list[list.length - 1];
    if (last !== undefined && last[1] === n - 1) last[1] = n;
    else list.push([n, n]);
  }
  return ranges;
}

/** `"4"`, or `"2–4"` with an en dash (U+2013). */
function formatRange([first, last]: [number, number]): string {
  return first === last ? String(first) : `${first}\u2013${last}`;
}
