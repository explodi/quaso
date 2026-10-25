// SPDX-License-Identifier: MIT
/**
 * The cases a translation's ICU blocks need in its language. A select block keeps the
 * English's cases. A plural or selectordinal block has one case per category of the
 * language, not of the English, plus the English's exact cases such as `=0`; the checks
 * (`checks.ts`) expect the same.
 */
import { type IcuBlock, type IcuCase, type IcuNode, parseIcu } from "./icu.ts";
import { categoriesFor, type PluralOverride } from "./plurals.ts";
import { PLURAL_CATEGORIES, type PluralCategory, type PluralForms } from "./types.ts";

/**
 * The English made a starting point for a translation: each plural and selectordinal block,
 * also inside other blocks, gets the language's categories. A category the English lacks
 * gets the English `other` case's text, a category the language doesn't use goes, and exact
 * cases stay. Spanish needs `one`, `many` and `other` where English has `one` and `other`.
 */
export function icuWithLanguageCases(
  text: string,
  language: string,
  override?: PluralOverride,
): string {
  const write = (nodes: IcuNode[]): string =>
    nodes
      .map((node) => {
        if (node.type !== "block") return text.slice(node.start, node.end);
        const head = text.slice(node.start, node.cases[0].start);
        const tail = text.slice(node.cases[node.cases.length - 1].end, node.end);
        const cases = languageCases(node, language, override).map(({ key, english }) => {
          const sameKey = english.key === key;
          const opening = sameKey ? text.slice(english.start, english.messageStart) : `${key} {`;
          return `${opening}${write(english.message)}}`;
        });
        return head + cases.join(caseSeparator(text, node)) + tail;
      })
      .join("");
  return write(parseIcu(text));
}

/** What separates a block's cases as written: a space, or a line break and indentation. */
function caseSeparator(text: string, block: IcuBlock): string {
  if (block.cases.length < 2) return " ";
  return text.slice(block.cases[0].end, block.cases[1].start);
}

/** A case a translation's block needs, and the English case it translates. */
export interface LanguageCase {
  key: string;
  english: IcuCase;
}

/**
 * The cases of an English block in a language. A select block's are the English's. A plural
 * block's are its exact cases, then one per category of the language, each translating the
 * English case of that category, or else `other`. For an invalid language tag, the English's.
 */
export function languageCases(
  block: IcuBlock,
  language: string,
  override?: PluralOverride,
): LanguageCase[] {
  const asWritten = block.cases.map((english) => ({ key: english.key, english }));
  if (block.blockType === "select") return asWritten;
  const categories = blockCategories(block, language, override);
  if (categories === null) return asWritten;
  const exact = asWritten.filter(({ key }) => key.startsWith("="));
  const other = block.cases.find((icuCase) => icuCase.key === "other") ?? block.cases.at(-1)!;
  const byCategory = categories.map((category) => {
    const english = block.cases.find((icuCase) => icuCase.key === category) ?? other;
    return { key: category, english };
  });
  return [...exact, ...byCategory];
}

/**
 * The categories a plural or selectordinal block needs in a language, as the checks expect
 * them, or null for an invalid language tag.
 */
export function blockCategories(
  block: IcuBlock,
  language: string,
  override?: PluralOverride,
): PluralCategory[] | null {
  const english: PluralForms = {};
  for (const category of PLURAL_CATEGORIES) {
    if (block.cases.some((icuCase) => icuCase.key === category)) english[category] = "";
  }
  const kind = block.blockType === "selectordinal" ? "ordinal" : "plural";
  try {
    return categoriesFor(language, kind, english, override);
  } catch {
    return null;
  }
}
