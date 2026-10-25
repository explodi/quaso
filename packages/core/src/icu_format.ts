// SPDX-License-Identifier: MIT
/**
 * ICU messages as an app shows them, for the editor's preview: `formatIcu` fills in a message
 * the way FormatJS does, and `icuPreview` lists the message in each of its cases.
 *
 * Arguments are printed as given, or as written (`{host}`) without a value. `#` is the
 * number, formatted for the language. A select block picks the case named by its value, else
 * `other`; a plural block an exact case (`=0`) first, else the language's category of the
 * number, else `other`. Quoted text shows unquoted.
 */
import {
  blockOffset,
  type IcuBlock,
  type IcuCase,
  type IcuNode,
  parseIcu,
  unquoteIcu,
} from "./icu.ts";
import {
  exampleNumber,
  pluralCategories,
  pluralCategoryOf,
  type PluralOverride,
} from "./plurals.ts";

export type IcuValues = Record<string, string | number>;

/**
 * A piece of a formatted message. `argument` is an argument filled in, or written as in the
 * message when it has no value; `number` is a plural case's `#`.
 */
export interface IcuPart {
  type: "text" | "argument" | "number";
  text: string;
}

/** The message with the values filled in. */
export function formatIcu(text: string, values: IcuValues, language: string): string {
  return formatIcuParts(text, values, language)
    .map((part) => part.text)
    .join("");
}

/** The message with the values filled in, as text, arguments and numbers. */
export function formatIcuParts(text: string, values: IcuValues, language: string): IcuPart[] {
  const parts: IcuPart[] = [];
  const push = (type: IcuPart["type"], piece: string) => {
    const last = parts[parts.length - 1];
    if (type === "text" && last?.type === "text") last.text += piece;
    else if (piece !== "") parts.push({ type, text: piece });
  };
  const format = (nodes: IcuNode[], plural: { number: number } | null) => {
    for (const node of nodes) {
      if (node.type === "text") {
        push("text", unquoteIcu(text.slice(node.start, node.end), plural !== null));
      } else if (node.type === "pound") {
        push("number", plural === null ? "#" : formatNumber(plural.number, language));
      } else if (node.type === "argument") {
        const value = values[node.name];
        push("argument", value === undefined ? text.slice(node.start, node.end) : String(value));
      } else {
        const chosen = chooseCase(text, node, values[node.name], language);
        if (chosen === undefined) continue;
        format(chosen.icuCase.message, node.blockType === "select" ? plural : chosen);
      }
    }
  };
  format(parseIcu(text), null);
  return parts;
}

/**
 * The case a block shows for a value, and for plural blocks the number `#` shows (the value
 * less the offset); undefined when the block has neither that case nor `other`.
 */
function chooseCase(
  text: string,
  block: IcuBlock,
  value: string | number | undefined,
  language: string,
): { icuCase: IcuCase; number: number } | undefined {
  const byKey = (key: string) => block.cases.find((icuCase) => icuCase.key === key);
  const other = byKey("other");
  if (block.blockType === "select") {
    const icuCase = (value === undefined ? undefined : byKey(String(value))) ?? other;
    return icuCase && { icuCase, number: 0 };
  }
  const n = Number(value ?? NaN);
  const number = n - blockOffset(text, block);
  const exact = Number.isNaN(n) ? undefined : byKey(`=${n}`);
  if (exact) return { icuCase: exact, number };
  const ordinal = block.blockType === "selectordinal";
  const category = Number.isNaN(number) ? "other" : categoryOf(language, number, ordinal);
  const icuCase = byKey(category) ?? other;
  return icuCase && { icuCase, number };
}

function categoryOf(language: string, n: number, ordinal: boolean): string {
  try {
    return pluralCategoryOf(language, n, { ordinal });
  } catch {
    return "other";
  }
}

function formatNumber(n: number, language: string): string {
  try {
    return new Intl.NumberFormat(language).format(n);
  } catch {
    return String(n);
  }
}

/** The case a preview row shows in one block: `female`, `=0`, or `many` for 1000000. */
export interface IcuPreviewChoice {
  argument: string;
  key: string;
  /** The number, for plural blocks. */
  number?: number;
}

export interface IcuPreviewRow {
  /** The case of each block the row goes through, outermost first. */
  choices: IcuPreviewChoice[];
  parts: IcuPart[];
}

export interface IcuPreview {
  rows: IcuPreviewRow[];
  /** Whether there are more combinations of cases than rows. */
  truncated: boolean;
}

/** More rows than this are left out: past it, a list stops being readable. */
const PREVIEW_LIMIT = 36;

/**
 * The message in each of its cases, one row per combination: every case of a select block,
 * and for a plural block each of its exact cases, then one example number per category of
 * the language (one that no exact case takes). A block inside a case adds its cases to that
 * case's rows only. A message without blocks gives one row.
 */
export function icuPreview(
  text: string,
  language: string,
  override?: PluralOverride,
  limit = PREVIEW_LIMIT,
): IcuPreview {
  const combinations = messageCombinations(text, parseIcu(text), [], language, override, limit);
  const rows = combinations.slice(0, limit).map((choices) => {
    const values: IcuValues = {};
    for (const choice of choices) values[choice.argument] = choice.number ?? choice.key;
    return { choices, parts: formatIcuParts(text, values, language) };
  });
  return { rows, truncated: combinations.length > limit };
}

/** The choices of a message's blocks, after `chosen`; at most `limit + 1` of them. */
function messageCombinations(
  text: string,
  nodes: IcuNode[],
  chosen: IcuPreviewChoice[],
  language: string,
  override: PluralOverride | undefined,
  limit: number,
): IcuPreviewChoice[][] {
  let combinations = [chosen];
  for (const node of nodes) {
    if (node.type !== "block") continue;
    combinations = combinations
      .flatMap((choices) => {
        // A block whose argument an outer block already chose follows that choice.
        const earlier = choices.find((choice) => choice.argument === node.name);
        const options = earlier ? [earlier] : blockChoices(text, node, language, override);
        return options.flatMap((option) => {
          const next = earlier ? choices : [...choices, option];
          const value = option.number ?? option.key;
          const icuCase = chooseCase(text, node, value, language)?.icuCase;
          if (icuCase === undefined) return [next];
          return messageCombinations(text, icuCase.message, next, language, override, limit);
        });
      })
      .slice(0, limit + 1);
  }
  return combinations;
}

/** The cases a preview shows for a block. */
function blockChoices(
  text: string,
  block: IcuBlock,
  language: string,
  override: PluralOverride | undefined,
): IcuPreviewChoice[] {
  const argument = block.name;
  if (block.blockType === "select") return block.cases.map(({ key }) => ({ argument, key }));
  const offset = blockOffset(text, block);
  const exact = block.cases
    .filter((icuCase) => icuCase.key.startsWith("="))
    .map((icuCase) => ({ argument, key: icuCase.key, number: Number(icuCase.key.slice(1)) }));
  const ordinal = block.blockType === "selectordinal";
  const except = exact.map((choice) => choice.number - offset);
  const categories: IcuPreviewChoice[] = [];
  for (const category of languageCategories(language, ordinal, override)) {
    const n = exampleNumber(language, category, { ordinal, except });
    if (n !== undefined) categories.push({ argument, key: category, number: n + offset });
  }
  return [...exact, ...categories];
}

function languageCategories(language: string, ordinal: boolean, override?: PluralOverride) {
  try {
    return pluralCategories(language, { ordinal, override });
  } catch {
    return ["other" as const];
  }
}
