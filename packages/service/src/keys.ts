// SPDX-License-Identifier: MIT
/**
 * How renames and length limits name a string (STR-6, FMT-4): by its key path displayed
 * with dots (`menu.play`), or exactly, as a JSON array (`["a.b", "c"]`), as plural
 * exclusions do. `#text`, `#plural` or `#ordinal` at the end picks the kind, for a key that
 * names several strings, such as the text `coins` next to the plural `coins_one` and
 * `coins_other`.
 */

/** A string's columns that key selectors match. */
export type KeyedString = {
  display_key: string;
  key_path: string;
  kind: string;
};

/** A key as a rename or a limit writes it, parsed. */
export interface KeySelector {
  /** As written. */
  text: string;
  /** The displayed key to match, unless `keyPath` is set. */
  displayKey?: string;
  /** The key path as the `key_path` column stores it (JSON). */
  keyPath?: string;
  kind?: string;
}

const KIND_SUFFIX = /#(text|plural|ordinal)$/;

/** Parses a key as renames and limits write it. */
export function parseKeySelector(text: string): KeySelector {
  const suffix = text.match(KIND_SUFFIX);
  const base = suffix ? text.slice(0, -suffix[0].length) : text;
  const selector: KeySelector = { text };
  if (suffix) selector.kind = suffix[1];
  const path = base.startsWith("[") ? parseKeyPath(base) : undefined;
  if (path === undefined) selector.displayKey = base;
  else selector.keyPath = path;
  return selector;
}

/**
 * Whether a selector names a string: by its displayed key or exact key path, and its kind
 * when the selector has one. A key that itself ends in `#plural` matches as written, too.
 */
export function matchesKey(selector: KeySelector, row: KeyedString): boolean {
  const path =
    selector.keyPath !== undefined
      ? row.key_path === selector.keyPath
      : row.display_key === selector.displayKey;
  if (path && (selector.kind === undefined || row.kind === selector.kind)) return true;
  return selector.kind !== undefined && row.display_key === selector.text;
}

/**
 * SQL on the strings table `s` that finds every string a selector may name (then filter
 * with `matchesKey`), and its parameters.
 */
export function selectorCondition(selector: KeySelector): { sql: string; params: string[] } {
  const params = [selector.text];
  let sql = "s.display_key = ?";
  if (selector.displayKey !== undefined && selector.displayKey !== selector.text) {
    sql += " OR s.display_key = ?";
    params.push(selector.displayKey);
  }
  if (selector.keyPath !== undefined) {
    sql += " OR s.key_path = ?";
    params.push(selector.keyPath);
  }
  return { sql: `(${sql})`, params };
}

/** Strings found by their displayed key or key path, for many lookups. */
export class KeyIndex<T extends KeyedString> {
  readonly #byDisplayKey = new Map<string, T[]>();
  readonly #byKeyPath = new Map<string, T[]>();

  constructor(rows: Iterable<T>) {
    for (const row of rows) {
      add(this.#byDisplayKey, row.display_key, row);
      add(this.#byKeyPath, row.key_path, row);
    }
  }

  /** The strings a selector names. */
  find(selector: KeySelector): T[] {
    const found = new Set<T>();
    const candidates = [
      ...(selector.keyPath !== undefined
        ? (this.#byKeyPath.get(selector.keyPath) ?? [])
        : (this.#byDisplayKey.get(selector.displayKey!) ?? [])),
      ...(selector.kind !== undefined ? (this.#byDisplayKey.get(selector.text) ?? []) : []),
    ];
    for (const row of candidates) if (matchesKey(selector, row)) found.add(row);
    return [...found];
  }

  /**
   * The shortest key that names `row` alone among the indexed strings: the displayed key,
   * then with the kind, then the key path as JSON (with the kind if needed).
   */
  reference(row: T): string {
    const same = this.#byDisplayKey.get(row.display_key) ?? [];
    const plain = !row.display_key.startsWith("[") && !KIND_SUFFIX.test(row.display_key);
    if (plain && same.every((other) => other === row)) return row.display_key;
    const sameKind = same.filter((other) => other.kind === row.kind);
    if (plain && sameKind.length === 1) return `${row.display_key}#${row.kind}`;
    const samePath = this.#byKeyPath.get(row.key_path) ?? [];
    if (samePath.every((other) => other === row)) return row.key_path;
    return `${row.key_path}#${row.kind}`;
  }
}

function add<T>(map: Map<string, T[]>, key: string, row: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [row]);
  else list.push(row);
}

/** A key path written as a JSON array of strings and numbers, as the column stores it. */
function parseKeyPath(text: string): string | undefined {
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
  return valid ? JSON.stringify(value) : undefined;
}
