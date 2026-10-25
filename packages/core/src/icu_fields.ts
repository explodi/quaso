// SPDX-License-Identifier: MIT
/**
 * An ICU translation as fields to fill in, for the editor's case editor: one field per text
 * the translator writes, the blocks' syntax around them locked.
 *
 * The fields follow the English's structure, with plural cases for the target language (as
 * `icuWithLanguageCases` gives them): each case of a block whose message has no blocks is a
 * field, and so is text the English has before, between or after the blocks of a message.
 *
 * A field's text is plain: `{host}` is the argument when the English has an argument of that
 * name, `#` is the number directly in a plural case, and every other brace and apostrophe is
 * text. Writing the fields back quotes what ICU would otherwise read as syntax, so the
 * translator never types an ICU escape.
 */
import { type IcuBlockType, type IcuNode, parseIcu, unquoteIcu } from "./icu.ts";
import { languageCases } from "./icu_cases.ts";
import type { IcuPart } from "./icu_format.ts";
import type { PluralOverride } from "./plurals.ts";

/** A case on the way to a field: `female` of `{hostGender, select}`. */
export interface IcuFieldStep {
  argument: string;
  blockType: IcuBlockType;
  key: string;
}

/** A text the translator writes. */
export interface IcuField {
  /** The cases that lead to it, outermost first. */
  path: IcuFieldStep[];
  /** For text around blocks: the arguments of the blocks just before and after it. */
  afterBlock?: string;
  beforeBlock?: string;
  /** The text, plain: quotes resolved, arguments as written. */
  text: string;
  /** The English of the same place, as parts for showing. */
  english: IcuPart[];
  /** Whether `#` is the number here: the field is directly in a plural case. */
  plural: boolean;
}

/** A translation as fields, and what writing them back needs. */
export interface IcuFieldForm {
  fields: IcuField[];
  message: FormNode[];
  /** The English's argument names: in a field, `{name}` with one of them is the argument. */
  arguments: ReadonlySet<string>;
}

type FormNode = FormText | FormBlock;

/** Text between blocks; a field unless the English has none there. */
interface FormText {
  type: "text";
  field: IcuField;
  shown: boolean;
}

interface FormBlock {
  type: "block";
  /** As in the English: `{guests, plural, `, the text between cases, and `}`. */
  head: string;
  separator: string;
  tail: string;
  cases: { opening: string; message: FormNode[] }[];
}

/**
 * The translation as fields, or null when they can't show it: it isn't valid ICU, its blocks
 * differ from the English's (other arguments, another order, a block added or left out), a
 * block has a case the fields don't (an exact case of its own, a category the language
 * doesn't use), or it has text around blocks where the English has none. A translation
 * that lacks a case is fine: that case's fields are empty. An empty translation gives empty
 * fields.
 */
export function icuFieldForm(
  english: string,
  translation: string,
  language: string,
  override?: PluralOverride,
): IcuFieldForm | null {
  const englishNodes = parseIcu(english);
  const translated = translation.trim() === "" ? null : parseIcu(translation);
  const fields: IcuField[] = [];

  /**
   * One level: the English's nodes paired with the translation's, or null if they don't
   * pair. Text between blocks pairs by position: before the first block, between, after.
   */
  const build = (
    englishLevel: IcuNode[],
    level: IcuNode[] | null,
    path: IcuFieldStep[],
    plural: boolean,
  ): FormNode[] | null => {
    const englishBlocks = englishLevel.filter((node) => node.type === "block");
    const blocks = level?.filter((node) => node.type === "block") ?? null;
    if (blocks !== null && !sameBlocks(englishBlocks, blocks)) return null;
    const englishTexts = textsAround(englishLevel);
    const texts = level === null ? null : textsAround(level);
    const nodes: FormNode[] = [];
    for (let index = 0; index <= englishBlocks.length; index++) {
      const englishText = englishTexts[index];
      const text = texts === null ? null : plainText(translation, texts[index], plural);
      // A message without blocks is a case's text, a field even where the English is empty.
      const shown =
        englishBlocks.length === 0 || plainText(english, englishText, plural).trim() !== "";
      if (!shown && text !== null && text.trim() !== "") return null;
      const field: IcuField = {
        path,
        text: text ?? (shown ? "" : plainText(english, englishText, plural)),
        english: englishParts(english, englishText, plural),
        plural,
      };
      if (index > 0) field.afterBlock = englishBlocks[index - 1].name;
      if (index < englishBlocks.length) field.beforeBlock = englishBlocks[index].name;
      nodes.push({ type: "text", field, shown });
      if (shown) fields.push(field);
      if (index === englishBlocks.length) break;

      const englishBlock = englishBlocks[index];
      const block = blocks?.[index] ?? null;
      const cases = languageCases(englishBlock, language, override);
      const keys = cases.map(({ key }) => key);
      if (block !== null && block.cases.some((icuCase) => !keys.includes(icuCase.key))) return null;
      const formBlock: FormBlock = {
        type: "block",
        head: english.slice(englishBlock.start, englishBlock.cases[0].start),
        separator: caseSeparator(english, englishBlock.cases),
        tail: english.slice(
          englishBlock.cases[englishBlock.cases.length - 1].end,
          englishBlock.end,
        ),
        cases: [],
      };
      for (const { key, english: englishCase } of cases) {
        // A case the translation lacks gets the English's structure, with empty fields.
        const translatedCase = block?.cases.find((icuCase) => icuCase.key === key);
        const step = { argument: englishBlock.name, blockType: englishBlock.blockType, key };
        const message = build(
          englishCase.message,
          translatedCase?.message ?? null,
          [...path, step],
          englishBlock.blockType !== "select",
        );
        if (message === null) return null;
        const sameKey = englishCase.key === key;
        const opening = sameKey
          ? english.slice(englishCase.start, englishCase.messageStart)
          : `${key} {`;
        formBlock.cases.push({ opening, message });
      }
      nodes.push(formBlock);
    }
    return nodes;
  };

  const message = build(englishNodes, translated, [], false);
  if (message === null) return null;
  return { fields, message, arguments: argumentNames(englishNodes) };
}

/**
 * The translation the fields make, with `changes` to some of them. Empty when every field
 * is blank, so that a string nobody has written in stays untranslated.
 */
export function writeIcuFieldForm(
  form: IcuFieldForm,
  changes: ReadonlyMap<IcuField, string> = new Map(),
): string {
  const textOf = (field: IcuField) => changes.get(field) ?? field.text;
  if (form.fields.every((field) => textOf(field).trim() === "")) return "";
  const write = (nodes: FormNode[], top: boolean): string =>
    nodes
      .map((node, index) => {
        if (node.type === "text") {
          const atEnd = top && index === nodes.length - 1;
          return quoteField(textOf(node.field), form.arguments, node.field.plural, atEnd);
        }
        const cases = node.cases.map(
          ({ opening, message }) => `${opening}${write(message, false)}}`,
        );
        return node.head + cases.join(node.separator) + node.tail;
      })
      .join("");
  return write(form.message, true);
}

/**
 * A field's plain text as ICU. `{name}` with one of the `known` names stays an argument, and
 * so does `#` in a plural case; other braces, and `#` where it would be read as the
 * number, are quoted. An apostrophe is doubled where ICU would read it as starting a quote:
 * before a brace, an apostrophe or a plural case's `#`, and at the end of a field that
 * syntax follows (`atEnd` is false).
 */
export function quoteField(
  text: string,
  known: ReadonlySet<string>,
  plural: boolean,
  atEnd: boolean,
): string {
  let result = "";
  let quoting = false;
  const closeQuote = () => {
    if (quoting) result += "'";
    quoting = false;
  };
  let at = 0;
  while (at < text.length) {
    const argumentEnd = text[at] === "{" ? knownArgumentEnd(text, at, known) : -1;
    if (argumentEnd !== -1) {
      closeQuote();
      result += text.slice(at, argumentEnd);
      at = argumentEnd;
      continue;
    }
    const char = text[at];
    if (char === "#" && plural) {
      closeQuote();
      result += "#";
    } else if (char === "{" || char === "}") {
      if (!quoting) result += "'";
      quoting = true;
      result += char;
    } else if (char === "'") {
      const next = text[at + 1];
      const startsSyntax =
        next === undefined ? !atEnd : "{}'".includes(next) || (next === "#" && plural);
      result += quoting || startsSyntax ? "''" : "'";
    } else {
      // One quote for a word with braces in it: '{docs}' rather than '{'docs'}'.
      if (!braceInWord(text, at)) closeQuote();
      result += char;
    }
    at++;
  }
  closeQuote();
  return result;
}

/** Whether a brace comes before the next whitespace, from `at`. */
function braceInWord(text: string, at: number): boolean {
  for (let index = at; index < text.length && !/\s/.test(text[index]); index++) {
    if (text[index] === "{" || text[index] === "}") return true;
  }
  return false;
}

/** Where the argument `{name}` or `{name, format}` that starts at `at` ends, or -1. */
function knownArgumentEnd(text: string, at: number, known: ReadonlySet<string>): number {
  const match = ARGUMENT.exec(text.slice(at));
  if (match === null || !known.has(match[1])) return -1;
  return at + match[0].length;
}

/** A simple argument: a name, then optionally a format that is no block's type. */
const ARGUMENT =
  /^\{\s*([\p{L}\p{N}_$]+)\s*(?:,\s*(?!(?:select|plural|selectordinal)\s*[,}])[^{}]*)?\}/u;

/** Whether two levels have the same blocks, by argument and type, in the same order. */
function sameBlocks(english: IcuNode[], translation: IcuNode[]): boolean {
  if (english.length !== translation.length) return false;
  return english.every((block, index) => {
    const other = translation[index];
    const bothBlocks = block.type === "block" && other.type === "block";
    return bothBlocks && block.name === other.name && block.blockType === other.blockType;
  });
}

/** A level's nodes before, between and after its blocks: one more list than blocks. */
function textsAround(nodes: IcuNode[]): IcuNode[][] {
  const texts: IcuNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === "block") texts.push([]);
    else texts[texts.length - 1].push(node);
  }
  return texts;
}

/** Nodes as a field shows them: quotes resolved, arguments as written, `#` as `#`. */
function plainText(text: string, nodes: IcuNode[], plural: boolean): string {
  return englishParts(text, nodes, plural)
    .map((part) => part.text)
    .join("");
}

function englishParts(text: string, nodes: IcuNode[], plural: boolean): IcuPart[] {
  return nodes.map((node) => {
    const raw = text.slice(node.start, node.end);
    if (node.type === "text") return { type: "text", text: unquoteIcu(raw, plural) };
    if (node.type === "pound") return { type: "number", text: "#" };
    return { type: "argument", text: raw };
  });
}

/** What separates cases as the English writes them: a space, or a line break and indent. */
function caseSeparator(text: string, cases: { start: number; end: number }[]): string {
  return cases.length < 2 ? " " : text.slice(cases[0].end, cases[1].start);
}

/** Every argument name in a message: its arguments' and its blocks'. */
function argumentNames(nodes: IcuNode[]): Set<string> {
  const names = new Set<string>();
  const visit = (level: IcuNode[]) => {
    for (const node of level) {
      if (node.type === "argument" || node.type === "block") names.add(node.name);
      if (node.type === "block") for (const icuCase of node.cases) visit(icuCase.message);
    }
  };
  visit(nodes);
  return names;
}
