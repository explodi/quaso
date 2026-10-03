// SPDX-License-Identifier: MIT
/**
 * i18next files as entries (design §5.2, FMT-1, STR-3).
 *
 * An English file is flattened into entries, each identified by its key path. Plural
 * groups (`coins_one`, `coins_other`) become one entry. `readTranslation` reads a
 * translation file (for `quaso import`) against the English entries.
 */
import {
  type JsonFormat,
  type JsonMember,
  type JsonNode,
  type JsonObject,
  JsonSyntaxError,
  parseJson,
  quoteJsonString,
  stringifyJson,
} from "./json.ts";
import type { PluralOverride } from "./plurals.ts";
import { NESTING_PREFIX, tokenize } from "./tokens.ts";
import {
  DEFAULT_SYNTAX,
  entryKey,
  formatKeyPath,
  type InterpolationSyntax,
  type KeyPath,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type PluralForms,
  type TextValue,
} from "./types.ts";

interface EntryBase {
  keyPath: KeyPath;
  /** 1-based line of the entry's (first) key in the file, when read from text. */
  line?: number;
}

export interface TextEntry extends EntryBase {
  kind: "text";
  value: string;
}

export interface PluralEntry extends EntryBase {
  kind: "plural" | "ordinal";
  /** The key path of the group: the base key, such as `["inventory", "coins"]`. */
  keyPath: KeyPath;
  /** The English forms, by category. Always has `other`. */
  forms: PluralForms;
}

export interface ReferenceEntry extends EntryBase {
  kind: "reference";
  /** The string, made only of nesting references and whitespace. */
  value: string;
}

export interface LiteralEntry extends EntryBase {
  kind: "literal";
  /**
   * The value as compact JSON text: `42`, `1.50`, `true`, `null`, `""`, `" "`, `{}`, `[]`.
   * Numbers keep their spelling.
   */
  raw: string;
}

export type SourceEntry = TextEntry | PluralEntry | ReferenceEntry | LiteralEntry;

/** An English file, read. */
export interface SourceFile {
  format: JsonFormat;
  /** Entries in file order; a plural group sits at the position of its first key. */
  entries: SourceEntry[];
}

export interface ReadOptions {
  /** The file's path, for error messages. */
  file?: string;
  syntax?: InterpolationSyntax;
  /**
   * Groups that only look like plurals: their keys stay plain entries. Each is the key path
   * of the group's keys without their category: `menu.power` for `menu.power_one` and
   * `menu.power_other`, `menu.place_ordinal` for `menu.place_ordinal_one` and so on. The
   * displayed form can't tell a key `a.b` from a key `b` in an object `a`, so the key path
   * may also be given as a JSON array, which matches exactly: `["a.b"]` or `["a", "b"]`.
   */
  pluralExclusions?: readonly string[];
}

/** A problem with a source or translation file that isn't a JSON syntax error. */
export class SourceError extends Error {
  readonly code: "not_an_object" | "key_conflict";
  readonly file?: string;
  readonly keyPath?: KeyPath;
  readonly line?: number;
  readonly column?: number;
  readonly detail: string;
  constructor(
    code: "not_an_object" | "key_conflict",
    detail: string,
    where: { file?: string; keyPath?: KeyPath; line?: number; column?: number } = {},
  ) {
    const position = where.line ? `:${where.line}:${where.column ?? 1}` : "";
    super(`${where.file ?? "<input>"}${position}: ${detail}`);
    this.name = "SourceError";
    this.code = code;
    this.detail = detail;
    this.file = where.file;
    this.keyPath = where.keyPath;
    this.line = where.line;
    this.column = where.column;
  }
}

export { JsonSyntaxError };

/**
 * Reads an English i18next JSON v4 file into entries, in file order.
 *
 * - The root must be an object (`SourceError` `not_an_object` otherwise).
 * - Objects are walked recursively; arrays give one entry per element, with the index in
 *   the key path (`["hints", 0]`). Empty objects and arrays are `literal` entries (`{}`,
 *   `[]`), so the structure survives.
 * - Numbers, booleans, `null`, and strings that are empty or only whitespace are `literal`.
 * - A string made only of nesting references (at least one) and whitespace is `reference`.
 * - Other strings are `text`.
 * - Plural groups: in one object, sibling keys `base_<category>` (categories `zero`, `one`,
 *   `two`, `few`, `many`, `other`) whose values are all strings form a `plural` entry with
 *   key path `[...parent, base]`, when they include `_other` and at least one other
 *   category and `base` is not empty. Keys `base_ordinal_<category>` form an `ordinal`
 *   entry the same way. A lone `x_other` stays text. Groups in `pluralExclusions` stay
 *   plain entries. So do groups whose forms are all blank or made only of references (and
 *   blanks), which are copied like such strings, not translated. The entry sits at the
 *   position of the group's first key. Context combines naturally: `friend_male_one` and
 *   `friend_male_other` form the group `friend_male`.
 * - Two entries with the same `entryKey()` can't happen for valid JSON, since keys are
 *   unique; if it would (a key named like a group's base is fine, because plural groups
 *   have their own key), a `SourceError` `key_conflict` is thrown.
 *
 * JSON errors throw `JsonSyntaxError` with the file, line and column.
 */
export function readSource(text: string, options: ReadOptions = {}): SourceFile {
  const { root, format } = parseJson(text, { file: options.file });
  if (root.type !== "object") throw notAnObject(root, options.file);
  const reader = new SourceReader(options);
  reader.readObject(root, []);
  return { format, entries: reader.entries };
}

/** The translatable value of a text or plural entry; `undefined` for other kinds. */
export function entryValue(entry: SourceEntry): TextValue | undefined {
  if (entry.kind === "text") return entry.value;
  if (entry.kind === "plural" || entry.kind === "ordinal") return entry.forms;
  return undefined;
}

export interface ReadTranslationOptions {
  /** The translation's language, for its plural keys. */
  language: string;
  file?: string;
  pluralOverride?: PluralOverride;
}

export interface ReadTranslationResult {
  /**
   * The values found for the English text and plural entries, by `entryKey()`. Text entries
   * whose translation value isn't a string are skipped. For plural entries, the forms found
   * as `base_<category>` (or `base_ordinal_<category>`) in the same object, for any
   * category; a group with no form found is skipped.
   */
  values: Map<string, TextValue>;
  /** Displayed key paths in the translation file that match no English entry. */
  unknownKeys: string[];
}

/**
 * Reads a translation file (such as `pl/common.json`) against the English entries of the
 * same file, for imports (CLI-7).
 *
 * Plural forms are read for every category found, whether or not the language needs it
 * (the quality checks report forms it doesn't use), so `language` and `pluralOverride`
 * don't change the result. A value of the wrong type (not a string where English has a
 * string, not an object where English has one, not an array where English has one) is
 * skipped, not reported. Values come in English entry order, with forms in CLDR order.
 * Unknown keys come in file order, as the paths of their values (plural keys as their full
 * key, such as `coins_few`); objects and arrays English doesn't have are searched, so each
 * of their values is reported, and so are the values inside an object or array where
 * English has an empty one. Plural keys of a group English copies instead of translating
 * (such as `label_few` when English has `label_one` and `label_other` made only of
 * references) aren't reported.
 */
export function readTranslation(
  text: string,
  english: readonly SourceEntry[],
  options: ReadTranslationOptions,
): ReadTranslationResult {
  const { root } = parseJson(text, { file: options.file });
  if (root.type !== "object") throw notAnObject(root, options.file);
  const reader = new TranslationReader(english);
  reader.readObject(root, []);
  return { values: reader.values(english), unknownKeys: reader.unknownKeys };
}

/** The parts of a plural key: `place_ordinal_two` is `place`, `ordinal`, `two`. */
export interface PluralKeyParts {
  base: string;
  kind: "plural" | "ordinal";
  category: PluralCategory;
}

/**
 * Splits a key into a plural group's base, kind and category, or returns `undefined` if it
 * isn't named like a plural key: `coins_few` is `coins`, `plural`, `few`, and
 * `place_ordinal_one` is `place`, `ordinal`, `one`. The base must not be empty. A key
 * ending in `_ordinal_<category>` is always read as ordinal when its base isn't empty.
 */
export function parsePluralKey(key: string): PluralKeyParts | undefined {
  const underscore = key.lastIndexOf("_");
  if (underscore <= 0) return undefined;
  const category = key.slice(underscore + 1);
  if (!CATEGORY_SET.has(category)) return undefined;
  const stem = key.slice(0, underscore);
  const kind = stem.length > ORDINAL.length && stem.endsWith(ORDINAL) ? "ordinal" : "plural";
  const base = kind === "ordinal" ? stem.slice(0, -ORDINAL.length) : stem;
  return { base, kind, category: category as PluralCategory };
}

/** The key of one form of a plural group: `coins_few` or `place_ordinal_one`. */
export function pluralKeyName(
  base: string,
  kind: "plural" | "ordinal",
  category: PluralCategory,
): string {
  return kind === "ordinal" ? `${base}${ORDINAL}_${category}` : `${base}_${category}`;
}

/**
 * Whether a string is made only of nesting references (at least one) and whitespace, such
 * as `$t(common:back)`: such strings are copied, not translated.
 */
export function isReferenceOnly(
  value: string,
  syntax: InterpolationSyntax = DEFAULT_SYNTAX,
): boolean {
  if (!value.includes(NESTING_PREFIX)) return false;
  let references = 0;
  for (const token of tokenize(value, syntax)) {
    if (token.type === "reference") references++;
    else if (token.type === "placeholder" || token.text.trim() !== "") return false;
  }
  return references > 0;
}

const ORDINAL = "_ordinal";
const CATEGORY_SET: ReadonlySet<string> = new Set(PLURAL_CATEGORIES);
const LITERAL_FORMAT: JsonFormat = { indent: "", newline: "\n", finalNewline: false };

/** What a JSON value is, for messages. */
const VALUE_NAMES: Record<JsonNode["type"], string> = {
  object: "an object",
  array: "an array",
  string: "a string",
  number: "a number",
  boolean: "a boolean",
  null: "null",
};

/** The `SourceError` for a root that isn't an object. */
function notAnObject(root: JsonNode, file: string | undefined): SourceError {
  return new SourceError(
    "not_an_object",
    `The file must contain a JSON object, not ${VALUE_NAMES[root.type]}`,
    { file, line: root.line, column: root.column },
  );
}

/** A plural group being collected from the members of one object. */
interface GroupCandidate {
  kind: "plural" | "ordinal";
  base: string;
  /** Index of the group's first member. */
  first: number;
  forms: PluralForms;
  /** Whether every member of the group holds a string. */
  allStrings: boolean;
}

/** Walks an English file's nodes and collects its entries in file order. */
class SourceReader {
  readonly entries: SourceEntry[] = [];
  private readonly file: string | undefined;
  private readonly syntax: InterpolationSyntax;
  private readonly exclusions: Exclusions;
  private readonly keys = new Set<string>();

  constructor(options: ReadOptions) {
    this.file = options.file;
    this.syntax = options.syntax ?? DEFAULT_SYNTAX;
    this.exclusions = new Exclusions(options.pluralExclusions ?? []);
  }

  /** Reads the members of an object, turning plural groups into single entries. */
  readObject(node: JsonObject, path: KeyPath): void {
    const { members } = node;
    const groups = this.findGroups(members, path);
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const group = groups[i];
      if (group === undefined) {
        this.readValue(member.value, [...path, member.key], member.line);
      } else if (group.first === i) {
        const keyPath = [...path, group.base];
        this.add({ kind: group.kind, keyPath, forms: group.forms, line: member.line }, member);
      }
    }
  }

  /**
   * The plural group of each member, by index, for the members that form valid groups
   * (with `other`, another category, only strings, something to translate, and not
   * excluded).
   */
  private findGroups(members: JsonMember[], path: KeyPath): (GroupCandidate | undefined)[] {
    const byMember: (GroupCandidate | undefined)[] = new Array(members.length);
    let candidates: Map<string, GroupCandidate> | undefined;
    for (let i = 0; i < members.length; i++) {
      const parts = parsePluralKey(members[i].key);
      if (parts === undefined) continue;
      candidates ??= new Map();
      const id = `${parts.kind}:${parts.base}`;
      let group = candidates.get(id);
      if (group === undefined) {
        group = { kind: parts.kind, base: parts.base, first: i, forms: {}, allStrings: true };
        candidates.set(id, group);
      }
      const value = members[i].value;
      if (value.type === "string") group.forms[parts.category] = value.value;
      else group.allStrings = false;
      byMember[i] = group;
    }
    if (candidates === undefined) return byMember;
    const valid = new Set<GroupCandidate>();
    for (const group of candidates.values()) {
      if (!this.isGroup(group, path)) continue;
      group.forms = sortForms(group.forms);
      valid.add(group);
    }
    return byMember.map((group) => (group && valid.has(group) ? group : undefined));
  }

  /** Whether a candidate forms a plural group. */
  private isGroup(group: GroupCandidate, path: KeyPath): boolean {
    if (!group.allStrings || group.forms.other === undefined) return false;
    const forms = Object.values(group.forms);
    if (forms.length < 2 || forms.every((form) => this.isCopied(form))) return false;
    const prefix = group.kind === "ordinal" ? `${group.base}${ORDINAL}` : group.base;
    return !this.exclusions.has([...path, prefix]);
  }

  /** Whether a string is copied rather than translated: blank, or only references. */
  private isCopied(value: string): boolean {
    return value.trim() === "" || isReferenceOnly(value, this.syntax);
  }

  private readValue(node: JsonNode, path: KeyPath, line: number | undefined): void {
    switch (node.type) {
      case "object":
        if (node.members.length > 0) return this.readObject(node, path);
        return this.addLiteral(node, path, line);
      case "array":
        if (node.items.length === 0) return this.addLiteral(node, path, line);
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          this.readValue(item, [...path, i], item.line);
        }
        return;
      case "string":
        return this.readString(node.value, path, line, node);
      default:
        return this.addLiteral(node, path, line);
    }
  }

  private readString(value: string, path: KeyPath, line: number | undefined, node: JsonNode): void {
    if (value.trim() === "") {
      this.add({ kind: "literal", keyPath: path, raw: quoteJsonString(value), line }, node);
    } else if (isReferenceOnly(value, this.syntax)) {
      this.add({ kind: "reference", keyPath: path, value, line }, node);
    } else {
      this.add({ kind: "text", keyPath: path, value, line }, node);
    }
  }

  private addLiteral(node: JsonNode, path: KeyPath, line: number | undefined): void {
    this.add(
      { kind: "literal", keyPath: path, raw: stringifyJson(node, LITERAL_FORMAT), line },
      node,
    );
  }

  /** Adds an entry, checking that its `entryKey()` is new. */
  private add(entry: SourceEntry, where: { line?: number; column?: number }): void {
    const key = entryKey(entry.kind, entry.keyPath);
    if (this.keys.has(key)) {
      throw new SourceError(
        "key_conflict",
        `Two entries have the key path ${formatKeyPath(entry.keyPath)}`,
        { file: this.file, keyPath: entry.keyPath, line: where.line, column: where.column },
      );
    }
    this.keys.add(key);
    this.entries.push(entry);
  }
}

/** Plural exclusions (see `ReadOptions.pluralExclusions`). */
class Exclusions {
  /** Displayed key paths, such as `menu.power`. */
  private readonly displayed = new Set<string>();
  /** Key paths as JSON, such as `["menu","power"]`. */
  private readonly exact = new Set<string>();

  constructor(exclusions: readonly string[]) {
    for (const exclusion of exclusions) {
      const path = exclusion.startsWith("[") ? parseKeyPath(exclusion) : undefined;
      if (path === undefined) this.displayed.add(exclusion);
      else this.exact.add(JSON.stringify(path));
    }
  }

  has(path: KeyPath): boolean {
    if (this.displayed.size === 0 && this.exact.size === 0) return false;
    return this.displayed.has(formatKeyPath(path)) || this.exact.has(JSON.stringify(path));
  }
}

/** A key path written as a JSON array of strings and numbers, or `undefined`. */
function parseKeyPath(text: string): KeyPath | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const valid = value.every(
    (segment) => typeof segment === "string" || (Number.isSafeInteger(segment) && segment >= 0),
  );
  return valid ? value : undefined;
}

/** Forms in CLDR order. */
function sortForms(forms: PluralForms): PluralForms {
  const sorted: PluralForms = {};
  for (const category of PLURAL_CATEGORIES) {
    const form = forms[category];
    if (form !== undefined) sorted[category] = form;
  }
  return sorted;
}

/** Walks a translation file's nodes and matches them with the English entries. */
class TranslationReader {
  readonly unknownKeys: string[] = [];
  /** English entries other than plural groups, by `entryKey()`. */
  private readonly plain = new Map<string, SourceEntry>();
  /** `entryKey()`s of the English plural groups. */
  private readonly groups = new Set<string>();
  /**
   * `entryKey()`s of the groups English copies: plural keys whose English values are
   * literals or references, such as `label_one` and `label_other` made of references.
   */
  private readonly copiedGroups = new Set<string>();
  /** The English objects and arrays that hold entries, by key path as JSON. */
  private readonly containers = new Map<string, "object" | "array">();
  private readonly texts = new Map<string, string>();
  private readonly forms = new Map<string, PluralForms>();

  constructor(english: readonly SourceEntry[]) {
    for (const entry of english) {
      const key = entryKey(entry.kind, entry.keyPath);
      if (entry.kind === "plural" || entry.kind === "ordinal") this.groups.add(key);
      else this.plain.set(key, entry);
      if (entry.kind === "literal" || entry.kind === "reference") this.addCopied(entry.keyPath);
      this.addContainers(entry.keyPath);
    }
  }

  /**
   * Records the containers of a key path, longest first, stopping at one already known:
   * its own containers are known too. Linear in the path's length for all but the first
   * entry of each container.
   */
  private addContainers(path: KeyPath): void {
    for (let length = path.length - 1; length > 0; length--) {
      const key = JSON.stringify(path.slice(0, length));
      if (this.containers.has(key)) return;
      this.containers.set(key, typeof path[length] === "number" ? "array" : "object");
    }
  }

  /** Records the group of a copied value whose key is named like a plural key. */
  private addCopied(path: KeyPath): void {
    const last = path[path.length - 1];
    const parts = typeof last === "string" ? parsePluralKey(last) : undefined;
    if (parts === undefined) return;
    this.copiedGroups.add(entryKey(parts.kind, [...path.slice(0, -1), parts.base]));
  }

  readObject(node: JsonObject, path: KeyPath): void {
    for (const member of node.members) {
      const childPath = [...path, member.key];
      if (!this.readPlain(member.value, childPath) && !this.readForm(member, path)) {
        this.readUnknown(member.value, childPath);
      }
    }
  }

  /** The values found, in English entry order. */
  values(english: readonly SourceEntry[]): Map<string, TextValue> {
    const values = new Map<string, TextValue>();
    for (const entry of english) {
      const key = entryKey(entry.kind, entry.keyPath);
      if (entry.kind === "text") {
        const text = this.texts.get(key);
        if (text !== undefined) values.set(key, text);
      } else if (entry.kind === "plural" || entry.kind === "ordinal") {
        const forms = this.forms.get(key);
        if (forms !== undefined) values.set(key, sortForms(forms));
      }
    }
    return values;
  }

  /**
   * Matches a value with an English entry other than a plural group. Inside an object or
   * array where English has an empty one, every value is unknown.
   */
  private readPlain(node: JsonNode, path: KeyPath): boolean {
    const key = JSON.stringify(path);
    const entry = this.plain.get(key);
    if (entry === undefined) return false;
    if (entry.kind === "text" && node.type === "string") this.texts.set(key, node.value);
    if (entry.kind === "literal" && fillsEmptyContainer(entry.raw, node)) {
      this.readUnknown(node, path);
    }
    return true;
  }

  /** Matches a member with a form of an English plural group in the same object. */
  private readForm(member: JsonMember, parent: KeyPath): boolean {
    const parts = parsePluralKey(member.key);
    if (parts === undefined) return false;
    const key = entryKey(parts.kind, [...parent, parts.base]);
    if (!this.groups.has(key)) return this.copiedGroups.has(key);
    if (member.value.type !== "string") return true;
    let forms = this.forms.get(key);
    if (forms === undefined) this.forms.set(key, (forms = {}));
    forms[parts.category] = member.value.value;
    return true;
  }

  /**
   * A value no English entry matches. Objects and arrays are searched. Other values are
   * reported. Where English has an object or array, a value of another type (an array for
   * an object, say) only has the wrong type, and is skipped.
   */
  private readUnknown(node: JsonNode, path: KeyPath): void {
    const container = this.containers.get(JSON.stringify(path));
    if (container !== undefined && node.type !== container) return;
    if (node.type === "object" && node.members.length > 0) {
      this.readObject(node, path);
    } else if (node.type === "array" && node.items.length > 0) {
      for (let i = 0; i < node.items.length; i++) {
        const childPath = [...path, i];
        if (!this.readPlain(node.items[i], childPath)) this.readUnknown(node.items[i], childPath);
      }
    } else if (container === undefined) {
      this.unknownKeys.push(formatKeyPath(path));
    }
  }
}

/** Whether a literal is an empty object or array (`{}`, `[]`) and the value a filled one. */
function fillsEmptyContainer(raw: string, node: JsonNode): boolean {
  return (
    (raw === "{}" && node.type === "object" && node.members.length > 0) ||
    (raw === "[]" && node.type === "array" && node.items.length > 0)
  );
}
