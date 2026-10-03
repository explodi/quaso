// SPDX-License-Identifier: MIT
/** Immutable file history commits before the latest published copy is replaced. */
import { sha256Hex, type ExportFile } from "@quaso/core";
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

export function publishedKey(language: string, file: string): string {
  const key = `published/${language}/${file}`;
  validateStoreKey(key);
  return key;
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
  let published = 0;
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
    const current = rows as unknown as FileVersion[];
    const find = (file: ExportFile) =>
      current.find((row) => row.language === file.language && row.file === file.path);
    const changed = rendered.files.filter((file) => find(file)?.sha256 !== file.sha256);
    const removed = current.filter(
      (row) =>
        !rendered.files.some((file) => file.language === row.language && file.path === row.file),
    );
    const at = Math.max(clock(), Number(ids[0].last_time) + 1);
    const statements: Statement[] = [];
    let id = Number(ids[0].id);
    for (const file of changed) {
      const key = `versions/${file.language}/${file.path}/${new Date(at).toISOString().replace(/[-:.]/g, "")}-${file.sha256.slice(0, 8)}`;
      validateStoreKey(key);
      const bytes = new TextEncoder().encode(file.content);
      await ensureVersion(store, key, bytes, file.sha256);
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
    let committedRevision = rendered.revision;
    try {
      if (statements.length > 0)
        committedRevision = await sql.commit(rendered.revision, statements);
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
    published += changed.length;
    // A row can survive a lost latest-copy write or a restore into an empty store.
    for (const file of rendered.files) {
      const previous = find(file);
      const bytes = new TextEncoder().encode(file.content);
      if (previous?.sha256 === file.sha256)
        await ensureVersion(store, previous.store_key, bytes, file.sha256);
      const key = publishedKey(file.language, file.path);
      const latest = await store.read(key);
      if (latest === null || sha256Hex(latest) !== file.sha256) await store.write(key, bytes);
    }
    if (removed.length > 0)
      await store.delete(removed.map((row) => publishedKey(row.language, row.file)));
    const [latestRevision] = await sql.read([
      { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
    ]);
    if (Number(latestRevision[0]?.revision ?? 0) !== committedRevision) continue;
    return { published };
  }
  throw new ServiceError(
    "unavailable",
    "The project kept changing while publishing files. Try again shortly.",
  );
}

async function ensureVersion(
  store: Store,
  key: string,
  bytes: Uint8Array,
  hash: string,
): Promise<void> {
  const existing = await store.read(key);
  if (existing !== null) {
    if (sha256Hex(existing) !== hash)
      throw new Error(`The version object ${key} has different content.`);
    return;
  }
  try {
    await store.write(key, bytes, { ifMatch: "absent" });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    const concurrent = await store.read(key);
    if (concurrent === null || sha256Hex(concurrent) !== hash) throw error;
  }
}
