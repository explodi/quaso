// SPDX-License-Identifier: MIT
/**
 * Small helpers for the service's SQL (design §5.3): chunks for bulk writes, the `meta`
 * table, the project revision, search text and JSON columns.
 */
import { type SyncSql, SQL_MAX_PARAMS, type SqlValue } from "./ports.ts";

export { SQL_MAX_PARAMS };

/** Splits `items` into lists of at most `size` items, for bulk writes within the limits. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new RangeError("The chunk size must be at least 1");
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

/** `?, ?, ?` for `n` parameters. */
export function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * Runs `fn` for each chunk of `items` that fits in one statement with `perItem` bound
 * parameters for each item (and `extra` more for the whole statement).
 */
export function forEachChunk<T>(
  items: readonly T[],
  perItem: number,
  fn: (chunk: T[]) => void,
  extra = 0,
): void {
  const size = Math.max(1, Math.floor((SQL_MAX_PARAMS - extra) / perItem));
  for (const chunk of chunks(items, size)) fn(chunk);
}

/**
 * A list of integer IDs written into SQL, such as `1, 2, 3`, for `IN (…)` lists longer
 * than the parameter limit allows. Only for validated integers.
 */
export function idList(ids: Iterable<number>): string {
  const out: string[] = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id)) throw new TypeError(`Not an ID: ${id}`);
    out.push(String(id));
  }
  return out.length === 0 ? "NULL" : out.join(", ");
}

/** A value from the `meta` table, or `null`. */
export function getMeta(sql: SyncSql, key: string): string | null {
  const rows = sql.query<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  return rows.length === 0 ? null : rows[0].value;
}

/** Sets a value in the `meta` table. */
export function setMeta(sql: SyncSql, key: string, value: string): void {
  sql.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

/** Removes a value from the `meta` table. */
export function deleteMeta(sql: SyncSql, key: string): void {
  sql.run("DELETE FROM meta WHERE key = ?", key);
}

/** The project revision: 0 on a new instance, and up by one with every write. */
export function getRevision(sql: SyncSql): number {
  return Number(getMeta(sql, "revision") ?? 0);
}

/** The revision of each open `transaction()`, by `SyncSql`. */
const openTransactions = new WeakMap<SyncSql, { revision: number | undefined }>();

/**
 * Runs `fn` as one transaction (`sql.transaction`), in which `bumpRevision` raises the
 * revision only once. The service runs every operation through it.
 */
export function transaction<T>(sql: SyncSql, fn: () => T): T {
  if (openTransactions.has(sql)) return sql.transaction(fn);
  openTransactions.set(sql, { revision: undefined });
  try {
    return sql.transaction(fn);
  } finally {
    openTransactions.delete(sql);
  }
}

/** The revision a write will use, including an earlier write in this transaction. */
export function writeRevision(sql: SyncSql): number {
  const current = getRevision(sql);
  return openTransactions.get(sql)?.revision === current ? current : current + 1;
}

/**
 * Raises the project revision by one, once per `transaction()`, and returns the new value:
 * later calls in the same transaction return the same value (unless a savepoint rolled the
 * raise back, in which case it is raised again). Outside `transaction()`, every call raises it.
 */
export function bumpRevision(sql: SyncSql): number {
  const current = getRevision(sql);
  const open = openTransactions.get(sql);
  if (open?.revision !== undefined && open.revision === current) return current;
  const next = current + 1;
  setMeta(sql, "revision", String(next));
  if (open) open.revision = next;
  return next;
}

/** Text for search: NFKC-normalized and in lower case. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Parses a JSON column. */
export function fromJson<T>(value: SqlValue): T {
  if (typeof value !== "string") throw new TypeError("A JSON column must hold text");
  return JSON.parse(value) as T;
}

/** Parses a JSON column that may be `NULL`. */
export function fromJsonOrNull<T>(value: SqlValue): T | null {
  return value === null ? null : fromJson<T>(value);
}

/** A value as JSON text for a column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}
