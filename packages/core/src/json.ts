// SPDX-License-Identifier: MIT
/**
 * An order-preserving JSON reader and writer (design §5.2, FMT-3, CLI-4).
 *
 * `JSON.parse` reorders integer-like keys, silently keeps the last of two duplicate keys and
 * reports errors poorly. This parser keeps every key in file order, rejects duplicate keys,
 * reports the file, line and column of every error, keeps numbers as written, and records
 * the file's formatting (indentation, line endings, final newline) so the writer can
 * reproduce it byte for byte.
 */
import { formatKeyPath, type KeyPath } from "./types.ts";

interface NodeBase {
  /** 1-based line of the node's first character, when it was parsed from text. */
  line?: number;
  /** 1-based column (in UTF-16 code units) of the node's first character. */
  column?: number;
}

export interface JsonObject extends NodeBase {
  type: "object";
  /** Members in file order. Keys are unique. */
  members: JsonMember[];
}

export interface JsonMember {
  key: string;
  value: JsonNode;
  /** Position of the key. */
  line?: number;
  column?: number;
}

export interface JsonArray extends NodeBase {
  type: "array";
  items: JsonNode[];
}

export interface JsonString extends NodeBase {
  type: "string";
  value: string;
}

export interface JsonNumber extends NodeBase {
  type: "number";
  /** The number exactly as written, such as `1.50` or `1e3`. */
  raw: string;
}

export interface JsonBoolean extends NodeBase {
  type: "boolean";
  value: boolean;
}

export interface JsonNull extends NodeBase {
  type: "null";
}

export type JsonNode = JsonObject | JsonArray | JsonString | JsonNumber | JsonBoolean | JsonNull;

/** How a file is formatted. */
export interface JsonFormat {
  /**
   * One level of indentation, such as `"  "`, `"    "` or `"\t"`. Empty for one-line files,
   * and for files whose members are on lines of their own without indentation (`multiline`).
   */
  indent: string;
  /** The line break: `\n`, `\r\n`, or a lone `\r` (classic Mac OS). */
  newline: "\n" | "\r\n" | "\r";
  /** Whether the file ends with a newline. */
  finalNewline: boolean;
  /**
   * With an empty `indent`: put each member and item on a line of its own, without
   * indentation, instead of writing one compact line. Set for files that have line breaks
   * between their tokens but no indented line. Ignored when `indent` isn't empty.
   */
  multiline?: boolean;
}

export const DEFAULT_FORMAT: JsonFormat = { indent: "  ", newline: "\n", finalNewline: true };

/** A JSON syntax error or a duplicate key, with its position. */
export class JsonSyntaxError extends Error {
  readonly code: "syntax" | "duplicate_key";
  readonly file?: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 code units. */
  readonly column: number;
  /** For duplicate keys: the path of the duplicated key. */
  readonly keyPath?: KeyPath;
  /** The message without the file and position prefix. */
  readonly detail: string;

  constructor(
    code: "syntax" | "duplicate_key",
    detail: string,
    position: { file?: string; line: number; column: number; keyPath?: KeyPath },
  ) {
    const where = `${position.file ? `${position.file}:` : ""}${position.line}:${position.column}`;
    super(`${where}: ${detail}`);
    this.name = "JsonSyntaxError";
    this.code = code;
    this.detail = detail;
    this.file = position.file;
    this.line = position.line;
    this.column = position.column;
    this.keyPath = position.keyPath;
  }
}

/**
 * Parses JSON text (RFC 8259) into nodes that keep key order and number spelling.
 *
 * - A UTF-8 byte order mark at the start is ignored.
 * - Duplicate keys in one object throw a `JsonSyntaxError` with code `duplicate_key`, naming
 *   the key path, such as `Duplicate key "play" at menu.play`.
 * - Syntax errors throw a `JsonSyntaxError` with code `syntax` and a message such as
 *   `Expected "," or "}" after a property value`, or `Unexpected end of file`.
 * - `format` is detected from the text (see `detectJsonFormat`).
 * - Objects and arrays may nest at most `MAX_JSON_DEPTH` levels deep.
 */
export function parseJson(
  text: string,
  options: { file?: string } = {},
): { root: JsonNode; format: JsonFormat } {
  const root = new Parser(text, options.file).parseDocument();
  return { root, format: detectJsonFormat(text) };
}

/**
 * Writes nodes as JSON text with the given formatting:
 *
 * - With an indent, like `JSON.stringify(value, null, indent)`: one member or item per
 *   line, `"key": value`, and `{}` / `[]` for empty containers. With `multiline` and no
 *   indent, the same without indentation. Otherwise compact like `JSON.stringify(value)`.
 * - Lines end with `format.newline`, and the text ends with it if `format.finalNewline`.
 * - Strings use raw Unicode. Only `"`, `\` and control characters below U+0020 are escaped:
 *   `\b \f \n \r \t` by name, others as `\u00XX` (lowercase hex). Lone surrogates are
 *   written as `\uXXXX` escapes so the output is valid UTF-8.
 * - Numbers are written exactly as their `raw` text.
 *
 * Reading a file written in this style and writing it back gives identical bytes.
 */
export function stringifyJson(node: JsonNode, format: JsonFormat = DEFAULT_FORMAT): string {
  const writer = new Writer(format);
  writer.write(node, 0);
  return writer.finish();
}

/**
 * Builds nodes from a plain JavaScript value (objects keep their property order, which
 * JavaScript puts integer-like keys first in). Numbers become their `String()` form.
 * Throws on values JSON can't hold (`undefined`, functions, non-finite numbers), and on
 * values nested deeper than `MAX_JSON_DEPTH` levels, which the parser would refuse.
 */
export function fromPlain(value: unknown): JsonNode {
  return nodeFromPlain(value, [], new Set());
}

/** Converts nodes to a plain JavaScript value, like `JSON.parse` would (losing key order). */
export function toPlain(node: JsonNode): unknown {
  switch (node.type) {
    case "object": {
      const result: Record<string, unknown> = {};
      for (const member of node.members) setOwnProperty(result, member.key, toPlain(member.value));
      return result;
    }
    case "array":
      return node.items.map((item) => toPlain(item));
    case "string":
    case "boolean":
      return node.value;
    case "number":
      return Number(node.raw);
    case "null":
      return null;
  }
}

/**
 * Detects how a JSON text is formatted: the indentation of the first indented line (not
 * counting the first line; empty if no line is indented), the first line break (`\n` if
 * there is none), and whether the text ends with a line break. A text with line breaks
 * between its tokens but no indented line gets `multiline: true`; other formats leave
 * `multiline` out.
 */
export function detectJsonFormat(text: string): JsonFormat {
  const last = text.charCodeAt(text.length - 1);
  const format: JsonFormat = {
    indent: detectIndent(text),
    newline: detectNewline(text),
    finalNewline: last === LF || last === CR,
  };
  if (format.indent === "" && hasInnerLineBreak(text)) format.multiline = true;
  return format;
}

/**
 * A string as a JSON string literal, the way `stringifyJson` writes it: raw Unicode, with
 * only `"`, `\`, control characters and lone surrogates escaped.
 */
export function quoteJsonString(value: string): string {
  let parts: string[] | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= SPACE && code !== QUOTE && code !== BACKSLASH) {
      if (code < 0xd800 || code > 0xdfff) continue;
      if (code <= 0xdbff && isLowSurrogate(value.charCodeAt(i + 1))) {
        i++;
        continue;
      }
    }
    parts ??= [];
    parts.push(value.slice(start, i), SHORT_ESCAPES[code] ?? unicodeEscape(code));
    start = i + 1;
  }
  if (parts === undefined) return `"${value}"`;
  parts.push(value.slice(start));
  return `"${parts.join("")}"`;
}

/**
 * The deepest nesting of objects and arrays the parser accepts (RFC 8259 §9 allows a
 * limit). Real i18next files stay far below it; it keeps the recursive reader and writer
 * well inside the call stack of every runtime, so deeper input fails with a clean error.
 */
export const MAX_JSON_DEPTH = 256;

// Character codes.
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const ASTERISK = 0x2a;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const BYTE_ORDER_MARK = 0xfeff;

/** Escapes with a short form, by character code. */
const SHORT_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

/** Characters after a backslash in a string, and what they stand for (except `u`). */
const DECODED_ESCAPES: Record<number, string> = {
  0x22: '"',
  0x2f: "/",
  0x5c: "\\",
  0x62: "\b",
  0x66: "\f",
  0x6e: "\n",
  0x72: "\r",
  0x74: "\t",
};

/** A 1-based line and column. */
interface Position {
  line: number;
  column: number;
}

/**
 * A recursive descent parser over UTF-16 code units. Line breaks can only occur in
 * whitespace between tokens (strings can't contain raw ones), so only `skipWhitespace`
 * counts lines.
 */
class Parser {
  private readonly text: string;
  private readonly file: string | undefined;
  private pos = 0;
  private line = 1;
  /** Offset of the first character of the current line. */
  private lineStart = 0;
  private depth = 0;
  /** Key path of the value being parsed, for duplicate key errors. */
  private readonly path: KeyPath = [];

  constructor(text: string, file: string | undefined) {
    this.text = text;
    this.file = file;
  }

  /** Parses the whole text: one value, surrounded by optional whitespace. */
  parseDocument(): JsonNode {
    if (this.text.charCodeAt(0) === BYTE_ORDER_MARK) this.pos = this.lineStart = 1;
    this.skipWhitespace();
    if (this.atEnd()) throw this.error("The file is empty");
    const root = this.parseValue();
    this.skipWhitespace();
    if (!this.atEnd()) {
      throw this.unexpected(`Unexpected character ${this.describeHere()} after the JSON value`);
    }
    return root;
  }

  private parseValue(): JsonNode {
    const code = this.text.charCodeAt(this.pos);
    const line = this.line;
    const column = this.column();
    if (code === QUOTE) return { type: "string", value: this.parseString(), line, column };
    if (code === OPEN_BRACE) return this.parseObject(line, column);
    if (code === OPEN_BRACKET) return this.parseArray(line, column);
    if (code === MINUS || isDigit(code)) return this.parseNumber(line, column);
    if (isWordCharacter(code)) return this.parseWord(line, column);
    if (code === APOSTROPHE) throw this.error("Strings must be in double quotes");
    if (code === PLUS) throw this.error('Numbers must not start with "+"');
    if (code === DOT) throw this.error("Numbers must start with a digit");
    throw this.unexpected();
  }

  private parseObject(line: number, column: number): JsonObject {
    this.enter();
    const members: JsonMember[] = [];
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.peek() !== CLOSE_BRACE) {
      members.push(this.parseMember(keys, 'Expected a property name or "}"'));
      while (this.nextItem(CLOSE_BRACE, 'Expected "," or "}" after a property value')) {
        members.push(this.parseMember(keys, "Expected a property name"));
      }
    }
    this.leave();
    return { type: "object", members, line, column };
  }

  /** Parses `"key": value`, starting at the key. */
  private parseMember(keys: Set<string>, expected: string): JsonMember {
    const code = this.peek();
    if (code !== QUOTE) {
      if (code === APOSTROPHE || isWordCharacter(code)) {
        throw this.error("Property names must be in double quotes");
      }
      throw this.unexpected(expected);
    }
    const line = this.line;
    const column = this.column();
    const key = this.parseString();
    if (keys.has(key)) {
      const keyPath = [...this.path, key];
      throw new JsonSyntaxError(
        "duplicate_key",
        `Duplicate key ${JSON.stringify(key)} at ${formatKeyPath(keyPath)}`,
        { file: this.file, line, column, keyPath },
      );
    }
    keys.add(key);
    this.skipWhitespace();
    if (this.peek() !== COLON) throw this.unexpected('Expected ":" after a property name');
    this.pos++;
    this.skipWhitespace();
    this.path.push(key);
    const value = this.parseValue();
    this.path.pop();
    return { key, value, line, column };
  }

  private parseArray(line: number, column: number): JsonArray {
    this.enter();
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.peek() !== CLOSE_BRACKET) {
      do {
        this.path.push(items.length);
        items.push(this.parseValue());
        this.path.pop();
      } while (this.nextItem(CLOSE_BRACKET, 'Expected "," or "]" after an array item'));
    }
    this.leave();
    return { type: "array", items, line, column };
  }

  /**
   * After a member or item: returns true after a comma (and the whitespace after it), or
   * false at the closing bracket, which it leaves for `leave()`.
   */
  private nextItem(close: number, expected: string): boolean {
    this.skipWhitespace();
    const code = this.peek();
    if (code === close) return false;
    if (code !== COMMA) throw this.unexpected(expected);
    const comma = this.position();
    this.pos++;
    this.skipWhitespace();
    if (this.peek() === close) {
      throw new JsonSyntaxError("syntax", "Trailing comma is not allowed", {
        file: this.file,
        ...comma,
      });
    }
    return true;
  }

  /** Steps into an object or array, past its opening bracket. */
  private enter(): void {
    if (++this.depth > MAX_JSON_DEPTH) {
      throw this.error(`Nesting is deeper than ${MAX_JSON_DEPTH} levels`);
    }
    this.pos++;
  }

  /** Steps out of an object or array, past its closing bracket. */
  private leave(): void {
    this.depth--;
    this.pos++;
  }

  /** Parses a string literal, starting at its opening quote. */
  private parseString(): string {
    const text = this.text;
    const end = text.length;
    let pos = this.pos + 1;
    let start = pos;
    let parts: string[] | undefined;
    while (pos < end) {
      const code = text.charCodeAt(pos);
      if (code === QUOTE) {
        this.pos = pos + 1;
        const last = text.slice(start, pos);
        if (parts === undefined) return last;
        parts.push(last);
        return parts.join("");
      }
      if (code === BACKSLASH) {
        parts ??= [];
        parts.push(text.slice(start, pos));
        this.pos = pos;
        parts.push(this.parseEscape());
        pos = start = this.pos;
      } else if (code < SPACE) {
        this.pos = pos;
        throw this.error(
          code === LF || code === CR
            ? "Unescaped line break in a string"
            : `Unescaped control character ${formatCodePoint(code)} in a string`,
        );
      } else {
        pos++;
      }
    }
    this.pos = end;
    throw this.error("Unexpected end of file");
  }

  /** Decodes an escape sequence, starting at its backslash. */
  private parseEscape(): string {
    const code = this.text.charCodeAt(this.pos + 1);
    if (code === 0x75) return this.parseUnicodeEscape();
    const decoded = DECODED_ESCAPES[code];
    if (decoded !== undefined) {
      this.pos += 2;
      return decoded;
    }
    if (this.pos + 1 >= this.text.length) {
      this.pos++;
      throw this.error("Unexpected end of file");
    }
    const next = this.text.codePointAt(this.pos + 1) ?? 0;
    const shown = isVisible(next) ? ` "\\${String.fromCodePoint(next)}"` : "";
    throw this.error(`Invalid escape sequence${shown}`);
  }

  /** Decodes `\uXXXX` into one UTF-16 code unit; surrogate pairs come as two escapes. */
  private parseUnicodeEscape(): string {
    let value = 0;
    for (let i = 2; i < 6; i++) {
      const digit = hexDigitValue(this.text.charCodeAt(this.pos + i));
      if (digit < 0) {
        if (this.pos + i >= this.text.length) {
          this.pos = this.text.length;
          throw this.error("Unexpected end of file");
        }
        throw this.error('Invalid escape sequence: "\\u" must be followed by four hex digits');
      }
      value = value * 16 + digit;
    }
    this.pos += 6;
    return String.fromCharCode(value);
  }

  /** Parses a number, keeping its spelling. */
  private parseNumber(line: number, column: number): JsonNumber {
    const text = this.text;
    const start = this.pos;
    let pos = start;
    if (text.charCodeAt(pos) === MINUS) pos++;
    const first = text.charCodeAt(pos);
    if (first === ZERO) {
      if (isDigit(text.charCodeAt(pos + 1))) {
        this.pos = pos;
        throw this.error("Numbers must not have leading zeros");
      }
      pos++;
    } else {
      pos = this.digits(pos, 'Expected a digit after "-"');
    }
    if (text.charCodeAt(pos) === DOT) {
      pos = this.digits(pos + 1, "Expected a digit after the decimal point");
    }
    const exponent = text.charCodeAt(pos);
    if (exponent === 0x65 || exponent === 0x45) {
      pos++;
      const sign = text.charCodeAt(pos);
      if (sign === PLUS || sign === MINUS) pos++;
      pos = this.digits(pos, "Expected a digit in the exponent");
    }
    this.pos = pos;
    return { type: "number", raw: text.slice(start, pos), line, column };
  }

  /** Skips one or more digits from `pos` and returns the position after them. */
  private digits(pos: number, expected: string): number {
    const text = this.text;
    if (!isDigit(text.charCodeAt(pos))) {
      this.pos = pos;
      throw this.unexpected(expected);
    }
    do pos++;
    while (isDigit(text.charCodeAt(pos)));
    return pos;
  }

  /** Parses `true`, `false` or `null`, and rejects other bare words such as `NaN`. */
  private parseWord(line: number, column: number): JsonNode {
    let end = this.pos;
    while (isWordCharacter(this.text.charCodeAt(end))) end++;
    const word = this.text.slice(this.pos, end);
    if (word === "true" || word === "false") {
      this.pos = end;
      return { type: "boolean", value: word === "true", line, column };
    }
    if (word === "null") {
      this.pos = end;
      return { type: "null", line, column };
    }
    const shown = word.length > 20 ? `${word.slice(0, 20)}…` : word;
    throw this.error(`Invalid value "${shown}"`);
  }

  /** Skips spaces, tabs and line breaks, counting lines. A CRLF counts as one break. */
  private skipWhitespace(): void {
    const text = this.text;
    let pos = this.pos;
    for (;;) {
      const code = text.charCodeAt(pos);
      if (code === SPACE || code === TAB) {
        pos++;
      } else if (code === LF || code === CR) {
        pos += code === CR && text.charCodeAt(pos + 1) === LF ? 2 : 1;
        this.line++;
        this.lineStart = pos;
      } else {
        break;
      }
    }
    this.pos = pos;
  }

  private peek(): number {
    return this.text.charCodeAt(this.pos);
  }

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private column(): number {
    return this.pos - this.lineStart + 1;
  }

  private position(): Position {
    return { line: this.line, column: this.column() };
  }

  /** The character at the current position, for messages. */
  private describeHere(): string {
    return describeCharacter(this.text.codePointAt(this.pos) ?? 0);
  }

  /**
   * An error for the character at the current position: the end of the file, a comment,
   * or else `message` (by default `Unexpected character "x"`).
   */
  private unexpected(message?: string): JsonSyntaxError {
    if (this.atEnd()) return this.error("Unexpected end of file");
    const next = this.text.charCodeAt(this.pos + 1);
    if (this.peek() === SLASH && (next === SLASH || next === ASTERISK)) {
      return this.error("Comments are not allowed in JSON");
    }
    return this.error(message ?? `Unexpected character ${this.describeHere()}`);
  }

  /** A syntax error at the current position. */
  private error(detail: string): JsonSyntaxError {
    return new JsonSyntaxError("syntax", detail, { file: this.file, ...this.position() });
  }
}

function isDigit(code: number): boolean {
  return code >= ZERO && code <= NINE;
}

/** ASCII letters, digits, `_` and `$`: the characters of bare words such as `true` or `NaN`. */
function isWordCharacter(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    isDigit(code) ||
    code === 0x5f ||
    code === 0x24
  );
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The value of a hex digit, or -1. */
function hexDigitValue(code: number): number {
  if (isDigit(code)) return code - ZERO;
  const lower = code | 0x20;
  if (lower >= 0x61 && lower <= 0x66) return lower - 0x61 + 10;
  return -1;
}

/** `\u` and four lowercase hex digits, as `JSON.stringify` writes them. */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** `U+00A0`. */
function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

/** Letters, digits, punctuation and symbols: characters a message can show as they are. */
function isVisible(codePoint: number): boolean {
  return VISIBLE.test(String.fromCodePoint(codePoint));
}

/** A character for messages: `"x"`, or `U+00A0` for invisible and control characters. */
function describeCharacter(codePoint: number): string {
  if (!isVisible(codePoint)) return formatCodePoint(codePoint);
  const char = String.fromCodePoint(codePoint);
  return char === '"' ? `'"'` : `"${char}"`;
}

/** The first line break, or `\n` if there is none. */
function detectNewline(text: string): JsonFormat["newline"] {
  for (let pos = 0; pos < text.length; pos++) {
    const code = text.charCodeAt(pos);
    if (code === LF) return "\n";
    if (code === CR) return text.charCodeAt(pos + 1) === LF ? "\r\n" : "\r";
  }
  return "\n";
}

/**
 * Whether a line break comes after the first token and before the last one. Strings can't
 * hold raw line breaks, so any line break in between separates tokens.
 */
function hasInnerLineBreak(text: string): boolean {
  let first = 0;
  let last = text.length - 1;
  while (first <= last && isWhitespace(text.charCodeAt(first))) first++;
  while (last > first && isWhitespace(text.charCodeAt(last))) last--;
  for (let pos = first + 1; pos < last; pos++) {
    if (isLineBreak(text.charCodeAt(pos))) return true;
  }
  return false;
}

/** JSON white space, and the byte order mark the parser skips. */
function isWhitespace(code: number): boolean {
  return code === SPACE || code === TAB || code === LF || code === CR || code === BYTE_ORDER_MARK;
}

/**
 * The leading spaces and tabs of the first indented line, or empty. Blank lines don't count,
 * and neither does the first line, which isn't indented relative to anything.
 */
function detectIndent(text: string): string {
  const length = text.length;
  let pos = 0;
  for (;;) {
    while (pos < length && !isLineBreak(text.charCodeAt(pos))) pos++;
    if (pos >= length) return "";
    pos += text.charCodeAt(pos) === CR && text.charCodeAt(pos + 1) === LF ? 2 : 1;
    const start = pos;
    while (text.charCodeAt(pos) === SPACE || text.charCodeAt(pos) === TAB) pos++;
    if (pos > start && pos < length && !isLineBreak(text.charCodeAt(pos))) {
      return text.slice(start, pos);
    }
  }
}

function isLineBreak(code: number): boolean {
  return code === LF || code === CR;
}

/** Collects the output of `stringifyJson` in parts, joined once at the end. */
class Writer {
  private readonly parts: string[] = [];
  private readonly format: JsonFormat;
  /** Whether members and items go on lines of their own. */
  private readonly expanded: boolean;
  private readonly colon: string;
  /** Line break and indentation, by depth. */
  private readonly breaks: string[] = [];

  constructor(format: JsonFormat) {
    this.format = format;
    this.expanded = format.indent !== "" || format.multiline === true;
    this.colon = this.expanded ? ": " : ":";
  }

  write(node: JsonNode, depth: number): void {
    switch (node.type) {
      case "object":
        return this.writeObject(node, depth);
      case "array":
        return this.writeArray(node, depth);
      case "string":
        this.parts.push(quoteJsonString(node.value));
        return;
      case "number":
        this.parts.push(node.raw);
        return;
      case "boolean":
        this.parts.push(node.value ? "true" : "false");
        return;
      case "null":
        this.parts.push("null");
        return;
      default:
        throw new TypeError(`Unknown JSON node type: ${(node as { type: unknown }).type}`);
    }
  }

  finish(): string {
    if (this.format.finalNewline) this.parts.push(this.format.newline);
    return this.parts.join("");
  }

  private writeObject(node: JsonObject, depth: number): void {
    const { members } = node;
    if (members.length === 0) {
      this.parts.push("{}");
      return;
    }
    const inner = this.lineBreak(depth + 1);
    this.parts.push("{");
    for (let i = 0; i < members.length; i++) {
      if (i > 0) this.parts.push(",");
      this.parts.push(inner, quoteJsonString(members[i].key), this.colon);
      this.write(members[i].value, depth + 1);
    }
    this.parts.push(this.lineBreak(depth), "}");
  }

  private writeArray(node: JsonArray, depth: number): void {
    const { items } = node;
    if (items.length === 0) {
      this.parts.push("[]");
      return;
    }
    const inner = this.lineBreak(depth + 1);
    this.parts.push("[");
    for (let i = 0; i < items.length; i++) {
      if (i > 0) this.parts.push(",");
      this.parts.push(inner);
      this.write(items[i], depth + 1);
    }
    this.parts.push(this.lineBreak(depth), "]");
  }

  /** A line break and the indentation of `depth`, or nothing for compact output. */
  private lineBreak(depth: number): string {
    if (!this.expanded) return "";
    const { indent, newline } = this.format;
    return (this.breaks[depth] ??= newline + indent.repeat(depth));
  }
}

/** `fromPlain` for a value at `path`; `ancestors` are the objects being converted. */
function nodeFromPlain(value: unknown, path: KeyPath, ancestors: Set<object>): JsonNode {
  if (hasToJson(value)) value = value.toJSON(String(path.at(-1) ?? ""));
  switch (typeof value) {
    case "string":
      return { type: "string", value };
    case "boolean":
      return { type: "boolean", value };
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`Cannot write ${value} as JSON${at(path)}`);
      return { type: "number", raw: String(value) };
    case "object": {
      if (value === null) return { type: "null" };
      if (ancestors.has(value)) {
        throw new TypeError(`Cannot write a circular structure as JSON${at(path)}`);
      }
      if (ancestors.size >= MAX_JSON_DEPTH) {
        throw new TypeError(`Cannot write JSON nested deeper than ${MAX_JSON_DEPTH} levels`);
      }
      ancestors.add(value);
      const node = Array.isArray(value)
        ? arrayFromPlain(value, path, ancestors)
        : objectFromPlain(value as Record<string, unknown>, path, ancestors);
      ancestors.delete(value);
      return node;
    }
    default: {
      const what = value === undefined ? "undefined" : `a ${typeof value}`;
      throw new TypeError(`Cannot write ${what} as JSON${at(path)}`);
    }
  }
}

function arrayFromPlain(value: unknown[], path: KeyPath, ancestors: Set<object>): JsonArray {
  const items: JsonNode[] = [];
  for (let i = 0; i < value.length; i++) {
    path.push(i);
    items.push(nodeFromPlain(value[i], path, ancestors));
    path.pop();
  }
  return { type: "array", items };
}

function objectFromPlain(
  value: Record<string, unknown>,
  path: KeyPath,
  ancestors: Set<object>,
): JsonObject {
  const members: JsonMember[] = [];
  for (const key of Object.keys(value)) {
    path.push(key);
    members.push({ key, value: nodeFromPlain(value[key], path, ancestors) });
    path.pop();
  }
  return { type: "object", members };
}

function hasToJson(value: unknown): value is { toJSON(key: string): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  );
}

/** ` at menu.play`, or nothing at the root. */
function at(path: KeyPath): string {
  return path.length === 0 ? "" : ` at ${formatKeyPath(path)}`;
}

/** Sets an own property, even `__proto__`, as `JSON.parse` does. */
function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}
