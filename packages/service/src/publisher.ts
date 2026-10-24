// SPDX-License-Identifier: MIT
/**
 * Publishes each changed file as an immutable version object, then commits its row. Downloads
 * read the row's object, so a publication touches the store only for the files that changed.
 */
import { sha256Hex } from "@quaso/core";
import { FALLBACK_MODEL } from "./context.ts";
import { ServiceError } from "./errors.ts";
import { exportFilesAsync } from "./export.ts";
import { sweepFileHistory } from "./file_retention.ts";
import { loadSettingsAsync } from "./settings.ts";
import type { Clock, Sql, Statement, Store } from "./ports.ts";
import { StoreConflict, validateStoreKey } from "./store.ts";
import { RevisionConflict } from "./write.ts";

export interface FileVersion {
  id: number;
  language: string;
  file: string;
  sha256: string;
  size: number;
  store_key: string;
  revision: number;
  published_at: number;
  replaced_at: number | null;
}

/** One publisher per host; overlapping requests share the current reconciliation. */
export function createPublisher(
  sql: Sql,
  store: Store,
  options: { clock?: Clock; model?: string } = {},
) {
  let running: Promise<{ published: number }> | null = null;
  let sweeping: Promise<{ expired: number; orphans: number }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function ordered<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  return {
    publish(): Promise<{ published: number }> {
      if (running !== null) return running;
      running = ordered(() =>
        publish(sql, store, options.clock ?? Date.now, options.model ?? FALLBACK_MODEL),
      ).finally(() => {
        running = null;
      });
      return running;
    },
    sweep(days?: number): Promise<{ expired: number; orphans: number }> {
      if (sweeping !== null) return sweeping;
      sweeping = ordered(async () =>
        sweepFileHistory(
          sql,
          store,
          (options.clock ?? Date.now)(),
          days ?? (await loadSettingsAsync(sql, options.model ?? FALLBACK_MODEL)).fileHistoryDays,
        ),
      ).finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
    /** Rewrites current versions the store lacks, as after restoring into an empty bucket. */
    restoreMissingVersions(): Promise<{ restored: number }> {
      return ordered(() => restoreMissingVersions(sql, store, options.model ?? FALLBACK_MODEL));
    },
    get busy() {
      return running !== null || sweeping !== null;
    },
  };
}

async function publish(
  sql: Sql,
  store: Store,
  clock: Clock,
  model: string,
): Promise<{ published: number }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rendered = await exportFilesAsync(sql, {}, model);
    const [revision, rows, ids] = await sql.read([
      {
        sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
      },
      { sql: "SELECT * FROM file_versions WHERE replaced_at IS NULL ORDER BY language, file" },
      {
        sql: "SELECT MAX(COALESCE(MAX(id), 0), COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'file_version_id'), 0)) + 1 AS id, COALESCE(MAX(published_at), -1) AS last_time FROM file_versions",
      },
    ]);
    if (Number(revision[0].revision) !== rendered.revision) continue;
    const current = new Map(
      (rows as unknown as FileVersion[]).map((row) => [`${row.language}/${row.file}`, row]),
    );
    const renderedNames = new Set(rendered.files.map((file) => `${file.language}/${file.path}`));
    const changed = rendered.files.filter(
      (file) => current.get(`${file.language}/${file.path}`)?.sha256 !== file.sha256,
    );
    const removed = [...current.entries()]
      .filter(([name]) => !renderedNames.has(name))
      .map(([, row]) => row);
    const at = Math.max(clock(), Number(ids[0].last_time) + 1);
    const statements: Statement[] = [];
    const writes: (() => Promise<void>)[] = [];
    let id = Number(ids[0].id);
    for (const file of changed) {
      const key = `versions/${file.language}/${file.path}/${new Date(at).toISOString().replace(/[-:.]/g, "")}-${file.sha256.slice(0, 8)}`;
      validateStoreKey(key);
      const bytes = new TextEncoder().encode(file.content);
      writes.push(() => writeVersion(store, key, bytes, file.sha256));
      statements.push(
        {
          sql: "UPDATE file_versions SET replaced_at = ? WHERE language = ? AND file = ? AND replaced_at IS NULL",
          params: [at, file.language, file.path],
        },
        {
          sql: "INSERT INTO file_versions (id, language, file, sha256, size, store_key, revision, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            id++,
            file.language,
            file.path,
            file.sha256,
            bytes.length,
            key,
            rendered.revision,
            at,
          ],
        },
      );
    }
    for (const row of removed)
      statements.push({
        sql: "UPDATE file_versions SET replaced_at = ? WHERE id = ?",
        params: [Math.max(at, row.published_at + 1), row.id],
      });
    // Expiring all history must not let a later file reuse a downloadable version ID.
    if (changed.length > 0)
      statements.push({
        sql: "INSERT INTO meta (key, value) VALUES ('file_version_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: [String(id - 1)],
      });
    await inParallel(writes);
    try {
      if (statements.length > 0) await sql.commit(rendered.revision, statements);
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
    return { published: changed.length };
  }
  throw new ServiceError(
    "unavailable",
    "The project kept changing while publishing files. Try again shortly.",
  );
}

async function restoreMissingVersions(
  sql: Sql,
  store: Store,
  model: string,
): Promise<{ restored: number }> {
  const stored = new Set<string>();
  for await (const object of store.list("versions/")) stored.add(object.key);
  const [rows] = await sql.read([
    { sql: "SELECT * FROM file_versions WHERE replaced_at IS NULL ORDER BY language, file" },
  ]);
  const missing = (rows as unknown as FileVersion[]).filter((row) => !stored.has(row.store_key));
  if (missing.length === 0) return { restored: 0 };
  const rendered = await exportFilesAsync(sql, {}, model);
  const files = new Map(rendered.files.map((file) => [`${file.language}/${file.path}`, file]));
  const writes: (() => Promise<void>)[] = [];
  for (const row of missing) {
    const file = files.get(`${row.language}/${row.file}`);
    // A file that changed since its row gets a new version from the next publication instead.
    if (file?.sha256 !== row.sha256) continue;
    const bytes = new TextEncoder().encode(file.content);
    writes.push(() => writeVersion(store, row.store_key, bytes, file.sha256));
  }
  await inParallel(writes);
  return { restored: writes.length };
}

/** Each store write is a network round trip, so a large publication runs a few at once. */
const PARALLEL_WRITES = 8;

async function inParallel(writes: (() => Promise<void>)[]): Promise<void> {
  for (let start = 0; start < writes.length; start += PARALLEL_WRITES)
    await Promise.all(writes.slice(start, start + PARALLEL_WRITES).map((write) => write()));
}

/** Version objects never change: a key that already exists must hold the same bytes. */
async function writeVersion(
  store: Store,
  key: string,
  bytes: Uint8Array,
  hash: string,
): Promise<void> {
  try {
    await store.write(key, bytes, { ifMatch: "absent" });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    const existing = await store.read(key);
    if (existing === null || sha256Hex(existing) !== hash)
      throw new Error(`The version object ${key} has different content.`);
  }
}
