// SPDX-License-Identifier: MIT
/**
 * The renderer (design §5.2 Writing, FMT-2, FMT-3): rebuilds a language's file from the
 * English entries and the translations.
 */
import { type PluralEntry, pluralKeyName, type SourceEntry, SourceError } from "./entries.ts";
import {
  type JsonArray,
  type JsonFormat,
  type JsonNode,
  type JsonObject,
  parseJson,
  stringifyJson,
} from "./json.ts";
import { categoriesFor, type PluralOverride } from "./plurals.ts";
import {
  entryKey,
  formatKeyPath,
  type KeyPath,
  type PluralCategory,
  type PluralForms,
  type TextValue,
} from "./types.ts";

export interface RenderOptions {
  /** The target language, for its plural categories. */
  language: string;
  /** The English file's format. The output always ends with a newline (FMT-3). */
  format: JsonFormat;
  pluralOverride?: PluralOverride;
}

/**
 * Renders one file in one language. Walks the English entries in their order, rebuilding
 * the nested structure from their key paths (numbers are array indices):
 *
 * | English entry      | Written value                                                    |
 * | ------------------ | ---------------------------------------------------------------- |
 * | text, translated   | the translation (a string)                                       |
 * | text, untranslated | the English text (FMT-2)                                         |
 * | plural / ordinal   | one key per category the language needs (`categoriesFor`), in   |
 * |                    | CLDR order, at the group's position: `base_<cat>` or             |
 * |                    | `base_ordinal_<cat>`. Each form comes from the translation; when  |
 * |                    | it lacks the form, from the English form of the same category;   |
 * |                    | when English lacks that too, from the English `other`.            |
 * | reference, literal | copied from English                                               |
 *
 * `translations` maps `entryKey()` to the value to write; a value of the wrong shape (forms
 * for a text entry, or a string for a plural one) counts as untranslated. The output uses
 * the English format's indentation and line endings, raw Unicode, and ends with a newline.
 * Rendering is deterministic: the same input gives the same bytes.
 *
 * Entries whose key paths clash (the same path twice, or a value where another entry needs
 * an object or array) throw a `SourceError` `key_conflict`; `readSource` never gives such
 * entries. Array elements missing from the entries are written as `null`, so the indices
 * of the others stay as they are.
 */
export function renderFile(
  entries: readonly SourceEntry[],
  translations: ReadonlyMap<string, TextValue>,
  options: RenderOptions,
): string {
  const tree = new TreeBuilder();
  const categories = new CategoryCache(options);
  for (const entry of entries) {
    switch (entry.kind) {
      case "text": {
        const translation = translations.get(entryKey(entry.kind, entry.keyPath));
        tree.put(entry.keyPath, stringNode(translation, entry.value));
        break;
      }
      case "plural":
      case "ordinal": {
        const translation = translations.get(entryKey(entry.kind, entry.keyPath));
        const forms = isForms(translation) ? translation : undefined;
        const base = pluralBase(entry);
        const parent = entry.keyPath.slice(0, -1);
        for (const category of categories.get(entry)) {
          const key = pluralKeyName(base, entry.kind, category);
          tree.put([...parent, key], pluralForm(entry, forms, category));
        }
        break;
      }
      case "reference":
        tree.put(entry.keyPath, { type: "string", value: entry.value });
        break;
      case "literal":
        tree.put(entry.keyPath, parseJson(entry.raw).root);
        break;
    }
  }
  return stringifyJson(tree.finish(), { ...options.format, finalNewline: true });
}

/** A string node with the translation if it is a string, or else the English. */
function stringNode(translation: TextValue | undefined, english: string): JsonNode {
  return { type: "string", value: typeof translation === "string" ? translation : english };
}

function isForms(value: TextValue | undefined): value is PluralForms {
  return typeof value === "object" && value !== null;
}

/** The last segment of a plural group's key path, which must be an object key. */
function pluralBase(entry: PluralEntry): string {
  const base = entry.keyPath.at(-1);
  if (typeof base !== "string") {
    throw new SourceError(
      "key_conflict",
      `The plural group ${formatKeyPath(entry.keyPath)} must end with an object key`,
      { keyPath: entry.keyPath },
    );
  }
  return base;
}

/**
 * One form of a plural group: the translation's, else the English form of the same
 * category, else the English `other` (FMT-2).
 */
function pluralForm(
  entry: PluralEntry,
  translation: PluralForms | undefined,
  category: PluralCategory,
): JsonNode {
  const translated = translation?.[category];
  const value =
    typeof translated === "string"
      ? translated
      : (entry.forms[category] ?? entry.forms.other ?? "");
  return { type: "string", value };
}

/** The categories of each kind of plural group in the target language, worked out once. */
class CategoryCache {
  private readonly options: RenderOptions;
  private readonly cache = new Map<string, readonly PluralCategory[]>();

  constructor(options: RenderOptions) {
    this.options = options;
  }

  get(entry: PluralEntry): readonly PluralCategory[] {
    const zero = entry.kind === "plural" && entry.forms.zero !== undefined;
    const id = `${entry.kind}:${zero}`;
    let categories = this.cache.get(id);
    if (categories === undefined) {
      const { language, pluralOverride } = this.options;
      categories = categoriesFor(language, entry.kind, entry.forms, pluralOverride);
      this.cache.set(id, categories);
    }
    return categories;
  }
}

/**
 * Rebuilds nested objects and arrays from key paths, in the order values are put, with an
 * index of each object's keys so that lookups stay fast in large files.
 */
class TreeBuilder {
  private readonly root: JsonObject = { type: "object", members: [] };
  private readonly indexes = new Map<JsonObject, Map<string, JsonNode>>();
  /** Arrays with elements put past their end, whose gaps are filled in `finish`. */
  private readonly sparse = new Set<JsonArray>();

  /** Puts a value at a key path, creating the objects and arrays on the way. */
  put(path: KeyPath, value: JsonNode): void {
    if (path.length === 0) throw conflict(path, "An entry has an empty key path");
    let container: JsonNode = this.root;
    for (let depth = 0; depth < path.length - 1; depth++) {
      const next = typeof path[depth + 1] === "number" ? "array" : "object";
      container = this.child(container, path, depth, next);
    }
    const last = path.length - 1;
    if (this.get(container, path, last) !== undefined) {
      throw conflict(path, `Two entries write to ${formatKeyPath(path)}`);
    }
    this.set(container, path, last, value);
  }

  /** The root, with gaps in arrays filled with `null`. */
  finish(): JsonObject {
    for (const array of this.sparse) {
      for (let i = 0; i < array.items.length; i++) array.items[i] ??= { type: "null" };
    }
    return this.root;
  }

  /** The object or array at `path[depth]` in `container`, created if missing. */
  private child(
    container: JsonNode,
    path: KeyPath,
    depth: number,
    type: "object" | "array",
  ): JsonNode {
    const existing = this.get(container, path, depth);
    if (existing !== undefined) {
      if (existing.type === type) return existing;
      throw conflict(path, `${formatKeyPath(path.slice(0, depth + 1))} is not an ${type}`);
    }
    const created: JsonNode =
      type === "array" ? { type: "array", items: [] } : { type: "object", members: [] };
    this.set(container, path, depth, created);
    return created;
  }

  /** The node at `path[depth]` in `container`, which must be the right kind of container. */
  private get(container: JsonNode, path: KeyPath, depth: number): JsonNode | undefined {
    const segment = path[depth];
    if (container.type === "object" && typeof segment === "string") {
      return this.index(container).get(segment);
    }
    if (container.type === "array" && typeof segment === "number") {
      return container.items[segment];
    }
    const expected = typeof segment === "number" ? "an array" : "an object";
    const parent = depth === 0 ? "The root" : formatKeyPath(path.slice(0, depth));
    throw conflict(path, `${parent} is not ${expected}`);
  }

  /** Sets the node at `path[depth]` in `container`, after `get` found none there. */
  private set(container: JsonNode, path: KeyPath, depth: number, value: JsonNode): void {
    const segment = path[depth];
    if (container.type === "object") {
      const key = String(segment);
      container.members.push({ key, value });
      this.index(container).set(key, value);
    } else if (container.type === "array") {
      const index = segment as number;
      if (!Number.isSafeInteger(index) || index < 0) {
        throw conflict(path, `${String(index)} is not an array index`);
      }
      if (index > container.items.length) this.sparse.add(container);
      container.items[index] = value;
    }
  }

  /** The keys of an object, indexed on first use (objects from literals start with none). */
  private index(object: JsonObject): Map<string, JsonNode> {
    let index = this.indexes.get(object);
    if (index === undefined) {
      index = new Map(object.members.map((member) => [member.key, member.value]));
      this.indexes.set(object, index);
    }
    return index;
  }
}

function conflict(keyPath: KeyPath, detail: string): SourceError {
  return new SourceError("key_conflict", detail, { keyPath });
}
