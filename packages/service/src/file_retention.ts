// SPDX-License-Identifier: MIT
/** Expired history loses its row before its bytes; abandoned writes age out separately. */
import type { Sql, Store } from "./ports.ts";
import { withRetries } from "./write.ts";

export const DAY_MS = 86_400_000;
export const DEFAULT_FILE_HISTORY_DAYS = 90;

/** Called through the publisher's queue so an object awaiting its row cannot be swept. */
export async function sweepFileHistory(sql: Sql, store: Store, now: number, days: number) {
  if (!Number.isSafeInteger(days) || days < 0)
    throw new Error("File history days must be a non-negative integer.");
  const cutoff = now - days * DAY_MS;
  const expired = await withRetries(
    sql,
    async () => {
      const [revision, rows] = await sql.read([
        { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
        {
          sql: "SELECT id, store_key FROM file_versions WHERE replaced_at < ? ORDER BY id",
          params: [cutoff],
        },
      ]);
      return { revision: Number(revision[0]?.revision ?? 0), state: rows };
    },
    (rows) => ({
      statements:
        rows.length === 0
          ? []
          : [
              {
                sql: "DELETE FROM file_versions WHERE replaced_at < ?",
                params: [cutoff],
              },
            ],
      result: rows.map((row) => String(row.store_key)),
    }),
  );
  if (expired.length > 0) await store.delete(expired);

  const candidates: string[] = [];
  for await (const object of store.list("versions/")) {
    const at = versionTime(object.key);
    // Unknown names have no reliable age; never guess from a file's path.
    if (at !== null && at < now - DAY_MS) candidates.push(object.key);
  }
  const [rows] = await sql.read([{ sql: "SELECT store_key FROM file_versions" }]);
  const referenced = new Set(rows.map((row) => String(row.store_key)));
  const orphans = candidates.filter((key) => !referenced.has(key));
  if (orphans.length > 0) await store.delete(orphans);
  return { expired: expired.length, orphans: orphans.length };
}

function versionTime(key: string): number | null {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[a-f0-9]{8}$/.exec(name);
  if (match === null) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const at = Date.parse(iso);
  return Number.isFinite(at) && new Date(at).toISOString() === iso ? at : null;
}
