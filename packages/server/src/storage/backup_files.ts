// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { makeTempFile } from "@quaso/runtime/files";
/**
 * Backup files (design §5.12, OPS-2, S8.9, S9.2): the downloads of `GET /backup` and the
 * files `quaso restore` and `POST /restore` read.
 *
 * Each is the instance at one moment (design §5.12):
 *
 * - **Local storage:** a copy made with SQLite's backup API (the snapshot code), in a
 *   temporary file: the SQLite download is that file; the JSON document is read from it
 *   (`backupJsonStream` on `sqlBackupReader`), streamed as it is read.
 * - **Cloudflare storage:** the service's rows, read in chunks at the state `backupInfo`
 *   gave (a write meanwhile starts the backup again, `withBackupRetries`), into a
 *   temporary file first: the JSON document, or a new SQLite file (the schema from the
 *   migrations, then the rows). The file is streamed once it is complete.
 * - Temporary files are deleted once streamed, when the client goes away, or on an error.
 * - **Restoring:** a `.sqlite` file, a JSON document, or a gzip-compressed JSON document
 *   (the Durable Object's nightly backups), recognized by their first bytes, restored
 *   through the service's restore methods into an empty instance of either kind. A SQLite
 *   file is only read, so it may sit in a read-only folder; one in WAL mode (older
 *   snapshots) is read from a copy in the temporary folder.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RestoreResult } from "@quaso/core";
import {
  type Actor,
  type BackupInfo,
  backupJsonStream,
  type BackupSource,
  documentSource,
  fromBase64,
  MIGRATIONS,
  restoreBackup,
  requireBackupGeneration,
  type RestoreTarget,
  type ServiceApi,
  type Store,
  ServiceError,
  sqlBackupReader,
  SYSTEM,
  toJsonValue,
  withBackupRetries,
  listStoredBackups,
  SECRET_TABLES,
} from "@quaso/service";
import { openNodeSqlite } from "@quaso/service/node-sqlite";
import { fileTimestamp, parseFileTimestamp } from "./snapshots.ts";

/** `application/vnd.sqlite3`, the SQLite file's media type. */
export const SQLITE_TYPE = "application/vnd.sqlite3";

/** The download's name: `quaso-backup-20260924T031500Z.json` or `.sqlite`. */
export function backupFileName(format: "json" | "sqlite", time: number): string {
  return `quaso-backup-${fileTimestamp(time)}.${format}`;
}

/** The headers of a backup download. */
function downloadHeaders(format: "json" | "sqlite", time: number): Headers {
  return new Headers({
    "Content-Type": format === "json" ? "application/json; charset=utf-8" : SQLITE_TYPE,
    "Content-Disposition": `attachment; filename="${backupFileName(format, time)}"`,
    "Cache-Control": "private, no-store",
  });
}

export interface BackupFileOptions {
  /** Local storage: writes a consistent copy of the database to a path. */
  snapshotTo?: (path: string) => Promise<void>;
  /** Where the temporary file goes. Default: the system's temporary folder. */
  tempDir?: string;
  now?: number;
  /** Told when the temporary file couldn't be deleted. */
  onCleanupError?: (error: unknown) => void;
}

/** Materializes a retained copy for the existing SQLite/JSON download pipeline. */
export async function storedBackupSnapshot(store: Store, input: { at?: string; file?: string }) {
  if (input.at !== undefined && input.file !== undefined)
    throw new ServiceError("bad_request", "Choose a backup time or file, not both.");
  let key: string;
  let at: number;
  if (input.file !== undefined) {
    const match = /^backups\/(?:quaso|pre-migration-v\d+-to-v\d+)-(\d{8}T\d{6}Z)\.sqlite$/.exec(
      input.file,
    );
    if (match === null)
      throw new ServiceError("bad_request", "Choose a SQLite backup in backups/.");
    key = input.file;
    at = parseFileTimestamp(match[1]);
    if (!Number.isFinite(at) || fileTimestamp(at) !== match[1])
      throw new ServiceError("bad_request", "Choose a backup with a valid UTC timestamp.");
  } else {
    const cutoff = Date.parse(input.at!);
    const backup = (await listStoredBackups(store)).find(
      (backup) => backup.key.endsWith(".sqlite") && backup.at <= cutoff,
    );
    if (backup === undefined)
      throw new ServiceError("not_found", "No retained backup exists at or before that time.");
    key = backup.key;
    at = backup.at;
  }
  return {
    now: at,
    async snapshotTo(path: string, options: { exclusive?: boolean } = {}) {
      const bytes = await store.read(key);
      if (bytes === null) throw new ServiceError("not_found", "The retained backup was not found.");
      const file = await fs.open(path, options.exclusive ? "wx" : "w", 0o600);
      let complete = false;
      try {
        await file.writeFile(bytes);
        complete = true;
      } finally {
        await file.close();
        if (!complete && options.exclusive) await fs.rm(path, { force: true });
      }
    },
  };
}

/**
 * `GET /backup?format=json`: the backup document. The service checks the actor's
 * permission with the first call, before anything is read or sent.
 */
export async function jsonBackupResponse(
  service: Pick<ServiceApi, "backupInfo" | "backupTables">,
  actor: Actor,
  options: BackupFileOptions = {},
): Promise<Response> {
  await service.backupInfo(actor, {});
  const headers = downloadHeaders("json", options.now ?? Date.now());
  if (options.snapshotTo) {
    // Read from a snapshot, which nothing changes, as the client takes it.
    const path = await snapshotFile(options.snapshotTo, options.tempDir);
    let database: ReturnType<typeof openNodeSqlite>;
    try {
      database = openNodeSqlite(path, { readOnly: true });
    } catch (error) {
      await fs.rm(path).catch(() => {});
      throw error;
    }
    const stream = backupJsonStream(sqlBackupReader(database.sql), SYSTEM);
    return new Response(
      withCleanup(stream, async () => {
        database.close();
        await fs.rm(path).catch((error) => options.onCleanupError?.(error));
      }),
      { headers },
    );
  }
  const path = await withBackupRetries(async () => {
    const file = await temporaryFile(options.tempDir, ".json");
    try {
      const stream = backupJsonStream(service, actor);
      await Bun.write(file, new Response(stream));
      return file;
    } catch (error) {
      await fs.rm(file).catch(() => {});
      throw error;
    }
  });
  return new Response(await deletingFileStream(path, options.onCleanupError), { headers });
}

/**
 * `GET /backup?format=sqlite`: one SQLite file with the whole instance, from a snapshot
 * (local storage) or built from the service's rows (Cloudflare storage).
 */
export async function sqliteBackupResponse(
  service: Pick<ServiceApi, "backupInfo" | "backupTables">,
  actor: Actor,
  options: BackupFileOptions = {},
): Promise<Response> {
  await service.backupInfo(actor, {});
  const path = options.snapshotTo
    ? await snapshotFile(options.snapshotTo, options.tempDir)
    : await withBackupRetries(async () => {
        const file = await temporaryFile(options.tempDir, ".sqlite");
        try {
          await buildSqliteBackup(service, actor, file, await service.backupInfo(actor, {}));
          return file;
        } catch (error) {
          await fs.rm(file).catch(() => {});
          throw error;
        }
      });
  const stream = await deletingFileStream(path, options.onCleanupError);
  return new Response(stream, { headers: downloadHeaders("sqlite", options.now ?? Date.now()) });
}

/** A snapshot of local storage in a new temporary file. */
async function snapshotFile(
  snapshotTo: (path: string) => Promise<void>,
  tempDir: string | undefined,
): Promise<string> {
  const path = await temporaryFile(tempDir, ".sqlite");
  try {
    await fs.rm(path);
    await snapshotTo(path);
    redactSnapshot(path);
    return path;
  } catch (error) {
    await fs.rm(path).catch(() => {});
    throw error;
  }
}

/** Redact the download copy and erase freed pages; the operator's snapshot stays intact. */
function redactSnapshot(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA secure_delete = ON");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    for (const table of tables) {
      const name = String(table.name);
      if (SECRET_TABLES.has(name)) database.exec(`DELETE FROM "${name}"`);
    }
    database.exec("VACUUM");
  } finally {
    database.close();
  }
}

/** A stream that runs `cleanup` once, when it ends, fails, or the client goes away. */
function withCleanup(
  stream: ReadableStream<Uint8Array>,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    await cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finish();
    },
  });
}

/** A new, empty temporary file (its folder resolved: `node:sqlite` refuses symbolic links). */
async function temporaryFile(dir: string | undefined, suffix: string): Promise<string> {
  const path = await makeTempFile({ dir, prefix: "quaso-backup-", suffix });
  return await fs.realpath(path);
}

/** Streams a file, then deletes it: at the end, when the client goes away, or on an error. */
export async function deletingFileStream(
  path: string,
  onCleanupError?: (error: unknown) => void,
): Promise<ReadableStream<Uint8Array>> {
  const file = await fs.open(path, "r");
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    try {
      await file.close();
    } catch {
      // Already closed.
    }
    await fs.rm(path).catch((error) => onCleanupError?.(error));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(256 * 1024);
        const { bytesRead: read } = await file.read(buffer);
        if (read === 0) {
          await finish();
          controller.close();
        } else {
          controller.enqueue(buffer.subarray(0, read));
        }
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}

/**
 * Builds a SQLite file with the service's data at `path` (an empty file): the schema of
 * the service's version from the migrations, then every table's rows, read in chunks.
 */
export async function buildSqliteBackup(
  service: Pick<ServiceApi, "backupTables">,
  actor: Actor,
  path: string,
  info: BackupInfo,
): Promise<void> {
  if (info.schemaVersion > MIGRATIONS.length) {
    throw new ServiceError(
      "unavailable",
      `The data has schema version ${info.schemaVersion}, newer than this server knows (${MIGRATIONS.length}). Upgrade the server.`,
    );
  }
  // Tables are read children first, so references are only checked by the restore.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    for (const migration of MIGRATIONS.slice(0, info.schemaVersion)) db.exec(migration.sql);
    // Children first, as the JSON export reads them (see the service's backup module).
    for (const { name } of [...info.tables].reverse()) {
      let after: number | undefined = undefined;
      for (;;) {
        const chunk = await service.backupTables(actor, {
          table: name,
          after,
          limit: 1000,
          state: info.state,
        });
        if (chunk.rows.length > 0) {
          const columns = chunk.columns.map((column) => `"${column}"`).join(", ");
          const statement = db.prepare(
            `INSERT OR REPLACE INTO "${name}" (${columns}) VALUES (${chunk.columns
              .map(() => "?")
              .join(", ")})`,
          );
          db.exec("BEGIN");
          try {
            for (const row of chunk.rows) statement.run(...row.map(sqliteValue));
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        if (chunk.next === null) break;
        after = chunk.next;
      }
    }
  } finally {
    db.close();
  }
}

/** A JSON value from `backupTables` as `node:sqlite` binds it: whole numbers as integers. */
function sqliteValue(value: unknown): SQLInputValue {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (value !== null && typeof value === "object" && "$base64" in value) {
    return fromBase64(String((value as { $base64: unknown }).$base64));
  }
  return value as SQLInputValue;
}

// ---------------------------------------------------------------------------------------
// Restoring

const SQLITE_MAGIC = "SQLite format 3\0";

/** What a backup file is, from its first bytes. */
export type BackupFileKind = "sqlite" | "json" | "gzip";

export async function backupFileKind(path: string): Promise<BackupFileKind> {
  const file = await fs.open(path, "r");
  try {
    const head = new Uint8Array(16);
    const read = (await file.read(head)).bytesRead;
    if (read >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
    if (read === 16 && new TextDecoder().decode(head) === SQLITE_MAGIC) return "sqlite";
    return "json";
  } finally {
    await file.close();
  }
}

/**
 * Restores a backup file into the (empty) instance behind `target`, as the system: a
 * SQLite file (a download, or a local snapshot), or a JSON document, compressed or not.
 * `tempDir` takes a copy of a SQLite file in WAL mode.
 */
export async function restoreFile(
  target: RestoreTarget,
  path: string,
  options: { tempDir?: string } = {},
): Promise<RestoreResult> {
  const kind = await backupFileKind(path);
  if (kind === "sqlite") {
    const source = await openSqliteSource(await fs.realpath(path), options);
    try {
      return await restoreBackup(target, source);
    } finally {
      await source.close();
    }
  }
  return await restoreBackup(target, documentSource(await readJsonFile(path, kind === "gzip")));
}

/** A JSON backup document from a file, gunzipped when needed. */
async function readJsonFile(path: string, gzip: boolean): Promise<unknown> {
  const file = await fs.open(path, "r");
  let stream: ReadableStream<Uint8Array> =
    file.readableWebStream() as unknown as ReadableStream<Uint8Array>;
  if (gzip) {
    const gunzip = new DecompressionStream("gzip");
    // A DecompressionStream takes any BufferSource; file chunks are Uint8Arrays.
    stream = stream.pipeThrough({
      writable: gunzip.writable as WritableStream<Uint8Array>,
      readable: gunzip.readable,
    });
  }
  let text: string;
  try {
    text = await new Response(stream).text();
  } catch (error) {
    throw new ServiceError(
      "bad_request",
      `The backup file can't be read: ${(error as Error).message}`,
    );
  } finally {
    await file.close();
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ServiceError(
      "bad_request",
      `The backup file isn't a SQLite database or valid JSON: ${(error as Error).message}`,
    );
  }
}

/** Tables SQLite and the Durable Object runtime keep for themselves. */
const INTERNAL_TABLE = /^(sqlite_|_cf_)/i;

/** Whether a SQLite file is in WAL mode: its header's read and write versions are 2. */
async function isWalFile(path: string): Promise<boolean> {
  const file = await fs.open(path, "r");
  try {
    const head = new Uint8Array(20);
    let read = 0;
    while (read < head.length) {
      const { bytesRead: n } = await file.read(head.subarray(read));
      if (n === 0) break;
      read += n;
    }
    return read === head.length && (head[18] === 2 || head[19] === 2);
  } finally {
    await file.close();
  }
}

/**
 * A copy of a WAL-mode SQLite file (and of its `-wal` file, when there is one) in the
 * temporary folder, switched to a rollback journal: SQLite reads a WAL-mode file only
 * where it may create the `-shm` file next to it.
 */
async function rollbackCopy(path: string, tempDir: string | undefined): Promise<string> {
  const copy = await temporaryFile(tempDir, ".sqlite");
  try {
    await fs.copyFile(path, copy);
    const wal = await fs.stat(`${path}-wal`).then(
      (info) => info.isFile(),
      () => false,
    );
    if (wal) await fs.copyFile(`${path}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      db.exec("PRAGMA journal_mode = DELETE");
    } finally {
      db.close();
    }
    return copy;
  } catch (error) {
    for (const file of [copy, `${copy}-wal`, `${copy}-shm`]) {
      await fs.rm(file).catch(() => {});
    }
    throw new ServiceError(
      "bad_request",
      `The SQLite file (in WAL mode) can't be copied to be read: ${(error as Error).message}`,
    );
  }
}

/**
 * A SQLite backup file as a `BackupSource`, read table by table in pages, and never
 * written: a file in WAL mode is read from a copy in `tempDir`, which `close` deletes.
 */
export async function openSqliteSource(
  path: string,
  options: { tempDir?: string } = {},
): Promise<BackupSource & { close(): Promise<void> }> {
  const copy = (await isWalFile(path)) ? await rollbackCopy(path, options.tempDir) : null;
  const removeCopy = async () => {
    if (copy !== null) await fs.rm(copy).catch(() => {});
  };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(copy ?? path, { readOnly: true });
  } catch (error) {
    await removeCopy();
    throw new ServiceError(
      "bad_request",
      `The SQLite file can't be opened: ${(error as Error).message}`,
    );
  }
  try {
    let version: { value: string } | undefined;
    try {
      version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
    } catch (error) {
      const message = (error as Error).message;
      // A database without Quaso's tables; anything else is a problem reading the file.
      if (!/no such table/i.test(message)) {
        throw new ServiceError("bad_request", `The SQLite file can't be read: ${message}`);
      }
      throw new Error("it has no meta table");
    }
    if (version === undefined) throw new Error("it has no schema version");
    const generation = db.prepare("SELECT value FROM meta WHERE key = 'schema_generation'").get();
    requireBackupGeneration(generation?.value);
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid")
      .all() as { name: string; sql: string | null }[];
    const counts: Record<string, number> = {};
    const withoutRowid = new Set<string>();
    for (const table of tables) {
      if (table.name === "revision_guard" || INTERNAL_TABLE.test(table.name)) continue;
      counts[table.name] = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }).n,
      );
      if (/\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "")) withoutRowid.add(table.name);
    }
    const page = 1000;
    return {
      schemaVersion: Number(version.value),
      counts,
      *rows(table: string) {
        if (!(table in counts)) return;
        let after = 0;
        for (;;) {
          const rows = withoutRowid.has(table)
            ? db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(page, after)
            : db
                .prepare(
                  `SELECT rowid AS _quaso_rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
                )
                .all(after, page);
          if (rows.length === 0) return;
          yield rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row)) {
              if (key !== "_quaso_rowid") out[key] = toJsonValue(value as never);
            }
            return out;
          });
          after = withoutRowid.has(table)
            ? after + rows.length
            : Number((rows[rows.length - 1] as { _quaso_rowid: number })._quaso_rowid);
          if (rows.length < page) return;
        }
      },
      close: async () => {
        db.close();
        await removeCopy();
      },
    };
  } catch (error) {
    db.close();
    await removeCopy();
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      "bad_request",
      `The SQLite file isn't a Quaso database: ${(error as Error).message}`,
    );
  }
}

/**
 * Saves a request's body to a temporary file, refusing more than `limit` bytes
 * (`payload_too_large`). Returns the file's path; the caller deletes it.
 */
export async function saveBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  tempDir?: string,
): Promise<string> {
  if (body === null) throw new ServiceError("bad_request", "Send the backup file as the body.");
  const path = await temporaryFile(tempDir, ".upload");
  const file = await fs.open(path, "w");
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        throw new ServiceError("bad_request", "The backup file didn't arrive in full.");
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ServiceError(
          "payload_too_large",
          `The backup file is larger than ${Math.round(limit / 1024 / 1024)} MB.`,
        );
      }
      let written = 0;
      while (written < next.value.byteLength) {
        written += (await file.write(next.value.subarray(written))).bytesWritten;
      }
    }
    if (size === 0) throw new ServiceError("bad_request", "Send the backup file as the body.");
    return path;
  } catch (error) {
    await file.close();
    await fs.rm(path).catch(() => {});
    throw error;
  } finally {
    try {
      await file.close();
    } catch {
      // Closed above.
    }
  }
}
