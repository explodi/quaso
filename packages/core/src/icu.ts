// SPDX-License-Identifier: MIT
/**
 * ICU MessageFormat, as i18next-icu and FormatJS read it: arguments such as `{name}` and
 * `{n, number}`, and blocks that choose a text, such as
 * `{style, select, masculine {El alcalde {name}} other {…}}` or
 * `{n, plural, one {# item} other {# items}}`.
 *
 * Parsing is lenient where a message sits in other text (a Markdown document, say): a `{`
 * that starts no valid argument is plain text, and the rest of the text is still read.
 * Inside a block's case, the case must be valid, or the whole block is plain text: a broken
 * block then reads as missing, which the checks report.
 *
 * Apostrophes quote as in ICU: `'{'` is a literal brace, `''` an apostrophe, and an
 * apostrophe before anything else (`l'alcalde`) is just an apostrophe. The parser keeps
 * offsets only; nothing is unquoted.
 */

export type IcuNode = IcuText | IcuArgument | IcuPound | IcuBlock;

export interface IcuText {
  type: "text";
  start: number;
  end: number;
}

/** An argument the app fills in: `{name}`, `{n, number}`, `{d, date, short}`. */
export interface IcuArgument {
  type: "argument";
  name: string;
  /** The type and style after the name, trimmed and joined with `, `: `number`, `date, short`. */
  format?: string;
  start: number;
  end: number;
}

/** `#` in a plural case: the number, formatted. */
export interface IcuPound {
  type: "pound";
  start: number;
  end: number;
}

export type IcuBlockType = "select" | "plural" | "selectordinal";

/** A block that chooses one of its cases by an argument. */
export interface IcuBlock {
  type: "block";
  name: string;
  blockType: IcuBlockType;
  cases: IcuCase[];
  start: number;
  end: number;
}

/** A case of a block: `masculine {…}`, `one {…}` or `=0 {…}`. */
export interface IcuCase {
  /** `masculine`, `one`, `=0`. */
  key: string;
  message: IcuNode[];
  /** Where the key starts, and where the case ends (after its `}`). */
  start: number;
  end: number;
  /** Where the message starts (after its `{`) and ends (at its `}`). */
  messageStart: number;
  messageEnd: number;
}

/** Parses text that may hold ICU arguments and blocks; whatever isn't one is text. */
export function parseIcu(text: string): IcuNode[] {
  const nodes: IcuNode[] = [];
  let pending = 0;
  let at = 0;
  while (at < text.length) {
    const quoteEnd = quotedEnd(text, at, false);
    if (quoteEnd !== -1) {
      at = quoteEnd;
      continue;
    }
    const node = text[at] === "{" ? parseArgument(text, at) : null;
    if (node === null) {
      at++;
      continue;
    }
    if (at > pending) nodes.push({ type: "text", start: pending, end: at });
    nodes.push(node);
    at = pending = node.end;
  }
  if (pending < text.length) nodes.push({ type: "text", start: pending, end: text.length });
  return nodes;
}

/** How a block appears in messages: `{style, select}`. */
export function blockLabel(block: IcuBlock): string {
  return `{${block.name}, ${block.blockType}}`;
}

/** A plural block's `offset:`, which `#` and the categories subtract; 0 without one. */
export function blockOffset(text: string, block: IcuBlock): number {
  const head = text.slice(block.start, block.cases[0].start);
  const offset = /offset:\s*([0-9]+)/.exec(head);
  return offset ? Number(offset[1]) : 0;
}

/**
 * What the raw text of a text node shows: quoted text without its apostrophes, and `''` as
 * one apostrophe. `inPlural` is whether the text is directly in a plural case, where `'#'`
 * quotes a `#`.
 */
export function unquoteIcu(raw: string, inPlural = false): string {
  let result = "";
  let at = 0;
  while (at < raw.length) {
    if (raw[at] !== "'") {
      result += raw[at++];
      continue;
    }
    const next = raw[at + 1];
    if (next === "'") {
      result += "'";
      at += 2;
      continue;
    }
    const special = next === "{" || next === "}" || (next === "#" && inPlural);
    if (!special) {
      result += "'";
      at++;
      continue;
    }
    for (at++; at < raw.length; at++) {
      if (raw[at] !== "'") {
        result += raw[at];
      } else if (raw[at + 1] === "'") {
        result += "'";
        at++;
      } else {
        at++;
        break;
      }
    }
  }
  return result;
}

/** Where a message isn't valid ICU, and why. */
export interface IcuSyntaxError {
  /** A sentence, such as "This { is never closed." */
  message: string;
  /** The offset of the character it is about. */
  at: number;
}

/**
 * The first place where a message isn't valid ICU as apps' strict parsers (FormatJS,
 * i18next-icu) read it, or null. Unlike `parseIcu`, which reads a broken block as text, a
 * `{` that starts no argument is an error here, and so are a `}` that closes nothing, a case
 * without its text in braces and a block without an `other` case.
 */
export function icuSyntaxError(text: string): IcuSyntaxError | null {
  const result = strictMessage(text, 0, false);
  if ("message" in result) return result;
  if (result.end < text.length) return { message: "This } closes nothing.", at: result.end };
  return null;
}

type Strict = { end: number } | IcuSyntaxError;

/** A message from `start` up to the `}` that ends it, or the end of the text. */
function strictMessage(text: string, start: number, inPlural: boolean): Strict {
  let at = start;
  while (at < text.length) {
    const quoteEnd = quotedEnd(text, at, inPlural);
    if (quoteEnd !== -1) {
      at = quoteEnd;
      continue;
    }
    if (text[at] === "}") return { end: at };
    if (text[at] === "{") {
      const argument = strictArgument(text, at);
      if ("message" in argument) return argument;
      at = argument.end;
      continue;
    }
    at++;
  }
  return { end: at };
}

const NOT_ARGUMENT =
  "This { doesn't start an argument such as {name}. A brace as text is written '{'.";
const NEVER_CLOSED = "This { is never closed.";

/** The argument or block whose `{` is at `start`, up to after its `}`. */
function strictArgument(text: string, start: number): Strict {
  const nameEnd = nextOf(text, start + 1, ",}{");
  if (nameEnd === -1) return { message: NEVER_CLOSED, at: start };
  const name = text.slice(start + 1, nameEnd).trim();
  if (text[nameEnd] === "{" || !NAME.test(name)) return { message: NOT_ARGUMENT, at: start };
  if (text[nameEnd] === "}") return { end: nameEnd + 1 };
  const typeEnd = nextOf(text, nameEnd + 1, ",}{");
  if (typeEnd === -1) return { message: NEVER_CLOSED, at: start };
  const type = text.slice(nameEnd + 1, typeEnd).trim();
  if (!BLOCK_TYPES.has(type)) {
    const close = nextOf(text, nameEnd + 1, "}{");
    if (close === -1) return { message: NEVER_CLOSED, at: start };
    if (text[close] === "{") return { message: NOT_ARGUMENT, at: close };
    return { end: close + 1 };
  }
  const label = `{${name}, ${type}}`;
  if (text[typeEnd] !== ",") return { message: `The ${label} block has no cases.`, at: start };
  return strictCases(text, start, label, type !== "select", typeEnd + 1);
}

/** A block's cases from `at`, up to after the block's `}`. */
function strictCases(
  text: string,
  start: number,
  label: string,
  plural: boolean,
  casesStart: number,
): Strict {
  let at = skipSpace(text, casesStart);
  if (plural) {
    const offset = OFFSET.exec(text.slice(at));
    if (offset) at = skipSpace(text, at + offset[0].length);
  }
  const keys: string[] = [];
  while (at < text.length) {
    if (text[at] === "}") {
      if (keys.length === 0) return { message: `The ${label} block has no cases.`, at: start };
      if (!keys.includes("other")) {
        return { message: `The ${label} block has no other case.`, at: start };
      }
      return { end: at + 1 };
    }
    const open = nextOf(text, at, "{}");
    const key = text.slice(at, open === -1 ? text.length : open).trim();
    // Text after a case that is no key is most often text after a block missing its `}`.
    if (!CASE_KEY.test(key) && keys.length > 0) {
      return { message: `The ${label} block has no } after its last case.`, at };
    }
    if (!CASE_KEY.test(key)) return { message: `“${key}” isn't a case of ${label}.`, at };
    if (open === -1 || text[open] === "}") {
      return { message: `The case “${key}” of ${label} has no text in braces.`, at };
    }
    const message = strictMessage(text, open + 1, plural);
    if ("message" in message) return message;
    if (message.end >= text.length) return { message: NEVER_CLOSED, at: open };
    keys.push(key);
    at = skipSpace(text, message.end + 1);
  }
  return { message: NEVER_CLOSED, at: start };
}

/** The position of the first of `chars` at or after `at`, or -1. */
function nextOf(text: string, at: number, chars: string): number {
  for (let index = at; index < text.length; index++) {
    if (chars.includes(text[index])) return index;
  }
  return -1;
}

const NAME = /^[\p{L}\p{N}_$]+$/u;
const BLOCK_TYPES = new Set<string>(["select", "plural", "selectordinal"]);
const CASE_KEY = /^(=-?[0-9]+(\.[0-9]+)?|[\p{L}\p{N}_-]+)$/u;
const OFFSET = /^offset:\s*[0-9]+/;

/** The argument or block whose `{` is at `start`, or null if none starts there. */
function parseArgument(text: string, start: number): IcuNode | null {
  const parts: { text: string; start: number }[] = [];
  let partStart = start + 1;
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at];
    if (char === "{") return null;
    if (char !== "," && char !== "}") continue;
    parts.push({ text: text.slice(partStart, at), start: partStart });
    partStart = at + 1;
    const name = parts[0].text.trim();
    if (!NAME.test(name)) return null;
    if (char === "}") {
      const format = parts
        .slice(1)
        .map((part) => part.text.trim())
        .join(", ");
      const argument: IcuArgument = { type: "argument", name, start, end: at + 1 };
      if (format !== "") argument.format = format;
      return argument;
    }
    if (parts.length === 2 && BLOCK_TYPES.has(parts[1].text.trim())) {
      return parseBlock(text, start, name, parts[1].text.trim() as IcuBlockType, at + 1);
    }
  }
  return null;
}

/** The block from `start`, whose cases begin at `casesStart`, or null if it is broken. */
function parseBlock(
  text: string,
  start: number,
  name: string,
  blockType: IcuBlockType,
  casesStart: number,
): IcuBlock | null {
  const plural = blockType !== "select";
  let at = skipSpace(text, casesStart);
  if (plural) {
    const offset = OFFSET.exec(text.slice(at));
    if (offset) at = skipSpace(text, at + offset[0].length);
  }
  const cases: IcuCase[] = [];
  while (at < text.length) {
    if (text[at] === "}") {
      return cases.length === 0
        ? null
        : { type: "block", name, blockType, cases, start, end: at + 1 };
    }
    const open = text.indexOf("{", at);
    if (open === -1) return null;
    const key = text.slice(at, open).trim();
    if (!CASE_KEY.test(key)) return null;
    const message = parseMessage(text, open + 1, plural);
    if (message === null) return null;
    cases.push({
      key,
      message: message.nodes,
      start: at,
      end: message.end + 1,
      messageStart: open + 1,
      messageEnd: message.end,
    });
    at = skipSpace(text, message.end + 1);
  }
  return null;
}

/**
 * A case's message from `start` to its closing `}`, which `end` points at, or null if it
 * has no closing `}` or holds a `{` that starts no valid argument.
 */
function parseMessage(
  text: string,
  start: number,
  inPlural: boolean,
): { nodes: IcuNode[]; end: number } | null {
  const nodes: IcuNode[] = [];
  let pending = start;
  let at = start;
  const flush = (until: number) => {
    if (until > pending) nodes.push({ type: "text", start: pending, end: until });
  };
  while (at < text.length) {
    const quoteEnd = quotedEnd(text, at, inPlural);
    if (quoteEnd !== -1) {
      at = quoteEnd;
      continue;
    }
    const char = text[at];
    if (char === "}") {
      flush(at);
      return { nodes, end: at };
    }
    if (char === "#" && inPlural) {
      flush(at);
      nodes.push({ type: "pound", start: at, end: at + 1 });
      at = pending = at + 1;
      continue;
    }
    if (char === "{") {
      const node = parseArgument(text, at);
      if (node === null) return null;
      flush(at);
      nodes.push(node);
      at = pending = node.end;
      continue;
    }
    at++;
  }
  return null;
}

/**
 * If an apostrophe at `at` starts quoted text (it comes before `{`, `}`, `'`, or `#` in a
 * plural case), the position after the quote; otherwise -1. `''` is one apostrophe; an
 * unclosed quote runs to the end of the text.
 */
function quotedEnd(text: string, at: number, inPlural: boolean): number {
  if (text[at] !== "'") return -1;
  const next = text[at + 1];
  if (next === "'") return at + 2;
  const special = next === "{" || next === "}" || (next === "#" && inPlural);
  if (!special) return -1;
  for (let end = at + 2; end < text.length; end++) {
    if (text[end] !== "'") continue;
    if (text[end + 1] === "'") {
      end++;
      continue;
    }
    return end + 1;
  }
  return text.length;
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}
