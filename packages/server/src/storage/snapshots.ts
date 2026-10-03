// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Consistent SQLite copies, on another connection so requests continue during capture.
 * Local storage publishes the completed bytes to the store for scheduled and migration backups.
 */
import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { copyDatabase, type SnapshotJob, type SnapshotResult } from "./snapshot_worker.ts";

/** A UTC time for file names, such as `20260924T031500Z`. */
export function fileTimestamp(time: number): string {
  return new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** The time of a `fileTimestamp`. */
export function parseFileTimestamp(stamp: string): number {
  const [, y, mo, d, h, mi, s] = stamp.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/) ?? [];
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

/** `backups/pre-migration-v1-to-v2-<time>.sqlite`: the snapshot before a migration. */
export function preMigrationName(from: number, to: number, time: number): string {
  return `pre-migration-v${from}-to-v${to}-${fileTimestamp(time)}.sqlite`;
}

/** Writes a consistent database snapshot atomically, resolving symlinks before opening SQLite. */
export async function copyInto(db: DatabaseSync, path: string): Promise<void> {
  const target = join(await fs.realpath(dirname(path)), basename(path));
  const temporary = `${target}.partial`;
  await fs.rm(temporary).catch(ignoreNotFound);
  try {
    await copyDatabase(db, temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary).catch(ignoreNotFound);
    throw error;
  }
}

/**
 * Writes a consistent copy of the database file at `source` to `path`, like `copyInto`,
 * but on a connection of its own in a worker: copying a large database takes seconds, and
 * the server's requests go on meanwhile (design §8).
 */
export async function snapshotInWorker(source: string, path: string): Promise<void> {
  const target = join(await fs.realpath(dirname(path)), basename(path));
  const temporary = `${target}.partial`;
  await fs.rm(temporary).catch(ignoreNotFound);
  const job: SnapshotJob = { source: await fs.realpath(source), target: temporary };
  const worker = new Worker(new URL("./snapshot_worker.ts", import.meta.url).href, {
    type: "module",
  });
  try {
    const result = await new Promise<SnapshotResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<SnapshotResult>) => resolve(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(`The snapshot worker failed: ${event.message}`));
      };
      worker.postMessage(job);
    });
    if (!result.ok) throw new Error(result.message);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary).catch(ignoreNotFound);
    throw error;
  } finally {
    worker.terminate();
  }
}

function ignoreNotFound(error: unknown): void {
  if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
}
