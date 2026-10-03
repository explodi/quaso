// SPDX-License-Identifier: MIT
/**
 * Backups and restore (design §5.12, OPS-2, S8.9, S9.1, S9.2): the whole instance, read
 * table by table in chunks, so that a JSON export or a SQLite file can be built without
 * holding everything in memory (in a Durable Object too); and a restore session that
 * writes such a backup into an empty instance of either kind.
 *
 * - **Reading:** `backupInfo` lists the tables (in the order they were created) and
 *   `backupTables` gives one table's rows after a cursor (the rowid), with blobs as
 *   `{ "$base64": "…" }`. `backupJsonStream` builds the JSON document (`BackupDocument`)
 *   from them, in chunks. Tables are read children first (reverse creation order).
 * - **One moment:** the chunks come from separate calls, so each call names the `state`
 *   `backupInfo` gave (the revision, and each table's last rowid); if a write changed it
 *   meanwhile, the call fails with `conflict` and the caller starts the backup again
 *   (`withBackupRetries`). A backup is therefore the instance at one moment: a row deleted
 *   and written again can't appear twice, and a translation never comes without its
 *   history. Writes that change neither (a sign-in, a changed role) may still land in some
 *   tables and not others. The server reads local storage from a snapshot instead.
 * - **Secrets:** sessions and email tokens are neither exported nor restored: people sign
 *   in again. API keys are, as their hashes.
 * - **Restoring:** `beginRestore` checks that the instance is empty (no strings, no one
 *   with a role), drops every table and creates the backup's schema version;
 *   `restoreRows` inserts rows in statements within the bound parameter limit;
 *   `finishRestore` checks the counts, runs the migrations from the backup's version to
 *   the current one, and raises the revision. A restore that didn't finish may start
 *   again only while nothing else changed the instance (the marker's `state`).
 */
import type { BackupDocument, RestoreResult } from "@quaso/core";
import { configuredSecrets, SECRET_REQUIREMENTS } from "./secrets.ts";
import { INSTANCE_SECRETS } from "./instance_secrets.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision, deleteMeta, getMeta, getRevision, setMeta, SQL_MAX_PARAMS } from "./db.ts";
import { badRequest, forbidden, notFound, ServiceError } from "./errors.ts";
import { migrate, schemaVersion } from "./migrate.ts";
import { DATABASE_VERSION, MIGRATIONS, BATCH_MIGRATIONS } from "./migrations.ts";
import type { Clock, Sql, Statement, SyncSql, SqlRow, SqlValue } from "./ports.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { SETUP_TOKEN } from "./accounts.ts";
import { constantTimeEqualText } from "./passwords.ts";
import { setupRequired } from "./users.ts";

import { RevisionConflict, withRetries } from "./write.ts";

export const BACKUP_FORMAT = "quaso-backup";
export const BACKUP_VERSION = 1;

/** Tables with secrets that are neither exported nor restored: people sign in again. */
export const SECRET_TABLES: ReadonlySet<string> = new Set(["sessions", "email_tokens", "secrets"]);

/** The `meta` key of a restore in progress. */
export const RESTORE_META = "restore";

/** The `meta` key of the last backup, `{ at, file }`. */
export const LAST_BACKUP_META = "last_backup";

/**
 * `meta` keys a backup leaves out: a restore in progress, the setup token (a secret that
 * only matters until the first administrator exists), and the last backup (a file of this
 * instance's setup, which the instance a backup moves to doesn't have). Runtime
 * publication and alarm deadlines are rebuilt from restored data and jobs.
 */
const PRIVATE_META: readonly string[] = [
  RESTORE_META,
  SETUP_TOKEN,
  LAST_BACKUP_META,
  "publish_pending",
  "llm_alarm",
  "file_sweep",
  "next_alarm",
];

/** `meta` keys a restore never writes: the schema version is the migrations' business. */
const KEEP_META: ReadonlySet<string> = new Set([
  "schema_version",
  "schema_generation",
  ...PRIVATE_META,
]);
// Async restores preserve the revision used by the destination's write guard.
const RESTORE_CONTROL_META: ReadonlySet<string> = new Set([...KEEP_META, "revision"]);

/** The condition that leaves `PRIVATE_META` out of the backup's `meta` rows. */
function metaFilter(table: string): string {
  return table === "meta"
    ? `key NOT IN (${PRIVATE_META.map((key) => `'${key}'`).join(", ")})`
    : "1";
}

/** SQLite's and the Durable Object runtime's own tables. */
const INTERNAL_TABLE = /^(sqlite_|_cf_)/i;

/** A column or table name we write into SQL (always quoted as well). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Rows per `backupTables` call when the caller doesn't say. */
export const DEFAULT_BACKUP_CHUNK = 500;
export const MAX_BACKUP_CHUNK = 5000;

/** `backupInfo`: what a backup of this instance holds. */
export interface BackupInfo {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  schemaVersion: number;
  createdAt: number;
  revision: number;
  /**
   * The data's state: pass it to every `backupTables` call of this backup, which then
   * fails with `conflict` once a write has changed it.
   */
  state: string;
  /** In creation order (parents before the tables that refer to them), with row counts. */
  tables: { name: string; rows: number }[];
}

/** `backupTables`' input. */
export interface BackupTablesInput {
  table: string;
  /** The cursor: the `next` of the previous chunk. */
  after?: number;
  limit?: number;
  /** `backupInfo`'s `state`: the call fails with `conflict` if the data changed since. */
  state?: string;
}

/** What reading a backup needs: the service's two methods, or `sqlBackupReader`. */
export interface BackupReader {
  backupInfo(actor: Actor, input: Record<string, never>): Promise<BackupInfo>;
  backupTables(actor: Actor, input: BackupTablesInput): Promise<BackupChunk>;
}

/** What reading needs from the context: the database and the clock. */
type ReadContext = Pick<Context, "sql" | "clock">;

/** `backupTables`: some rows of a table, after a cursor. */
export interface BackupChunk {
  table: string;
  columns: string[];
  /** Values in `columns` order; blobs as `{ "$base64": "…" }`. */
  rows: unknown[][];
  /** Pass as `after` for the next chunk; null after the last one. */
  next: number | null;
  revision: number;
}

/** A blob in JSON. */
export interface Base64Value {
  $base64: string;
}

export type SchemaObject = { name: string; type: string; sql: string | null };

/** The tables and views of the database, in creation order, without internal ones. */
function schemaObjects(ctx: Pick<Context, "sql">): SchemaObject[] {
  return ctx.sql
    .query<SchemaObject>(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
    )
    .filter((row) => !INTERNAL_TABLE.test(row.name));
}

/** The tables a backup holds, in creation order. */
export function backupTableNames(ctx: Pick<Context, "sql">): string[] {
  return backupTableObjects(schemaObjects(ctx)).map((row) => row.name);
}

function backupTableObjects(objects: SchemaObject[]): SchemaObject[] {
  // The guard is schema control state, rebuilt when opening a database or restoring it.
  return objects.filter(
    (row) =>
      row.type === "table" &&
      row.name !== "revision_guard" &&
      !INTERNAL_TABLE.test(row.name) &&
      !SECRET_TABLES.has(row.name),
  );
}

function tableExists(ctx: Pick<Context, "sql">, name: string): boolean {
  return schemaObjects(ctx).some((row) => row.type === "table" && row.name === name);
}

/** `"name"`, for a name checked against `IDENTIFIER`. */
function quote(name: string): string {
  if (!IDENTIFIER.test(name)) throw badRequest(`${name} isn't a valid table or column name.`);
  return `"${name}"`;
}

/** `GET /backup`, first step: the tables and their row counts. */
export function backupInfo(ctx: ReadContext): BackupInfo {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: schemaVersion(ctx.sql),
    createdAt: ctx.clock(),
    revision: getRevision(ctx.sql),
    state: dataState(ctx),
    tables: backupTableNames(ctx).map((name) => ({
      name,
      rows: ctx.sql.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${quote(name)} WHERE ${metaFilter(name)}`,
      )[0].n,
    })),
  };
}

export async function backupInfoAsync(sql: Sql, actor: Actor, now: number): Promise<BackupInfo> {
  const snapshot = await readBackupSnapshot(sql, actor);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: Number(snapshot.meta.get("schema_version") ?? 0),
    createdAt: now,
    revision: snapshot.revision,
    state: snapshot.state,
    tables: snapshot.tables,
  };
}

export async function backupTablesAsync(
  sql: Sql,
  actor: Actor,
  input: BackupTablesInput,
): Promise<BackupChunk> {
  const snapshot = await readBackupSnapshot(sql, actor, input);
  if (input.state !== undefined && input.state !== snapshot.state) {
    throw new ServiceError("conflict", BACKUP_CHANGED);
  }
  return backupChunk(input, snapshot.rows, snapshot.withoutRowid, snapshot.revision);
}

/** Plan table names first; the final batch verifies that schema and captures every data fact. */
async function readBackupSnapshot(sql: Sql, actor: Actor, input?: BackupTablesInput) {
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared, ...preparedPermissions] = await sql.read([
      schema,
      ...permissionReadStatements(actor),
    ]);
    permissionsFromRows(actor, preparedPermissions).require("backup");
    const objects = (prepared as SchemaObject[]).filter((row) => !INTERNAL_TABLE.test(row.name));
    const tables = backupTableObjects(objects);
    const selected =
      input === undefined ? undefined : tables.find((row) => row.name === input.table);
    if (input !== undefined && selected === undefined) throw notFound(`The table ${input.table}`);
    const offsetPaging = selected !== undefined && isWithoutRowid(selected);
    const stats = tables.map((object): Statement => {
      const countState = object.name === "meta" || isWithoutRowid(object);
      const state = countState ? "COUNT(*)" : "MAX(rowid)";
      const rows = input === undefined ? "COUNT(*)" : "0";
      return {
        sql: `SELECT ${rows} AS rows, ${state} AS state FROM ${quote(object.name)} WHERE ${metaFilter(object.name)}`,
      };
    });
    const selection =
      input === undefined ? { sql: "SELECT 1 WHERE 0" } : backupSelection(input, offsetPaging);
    const [current, metadata, rows, ...results] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta" },
      selection,
      ...stats,
      ...permissionReadStatements(actor),
    ]);
    permissionsFromRows(actor, results.slice(tables.length)).require("backup");
    const currentObjects = (current as SchemaObject[]).filter(
      (row) => !INTERNAL_TABLE.test(row.name),
    );
    if (JSON.stringify(currentObjects) !== JSON.stringify(objects)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const revision = Number(meta.get("revision") ?? 0);
    const state = new Map([["revision", revision]]);
    const counts = tables.map((object, index) => {
      const value = results[index][0];
      if (object.name !== "meta") state.set(object.name, Number(value.state ?? 0));
      return { name: object.name, rows: Number(value.rows) };
    });
    return {
      meta,
      revision,
      state: [...state].map(([name, value]) => `${name}=${value}`).join(" "),
      tables: counts,
      rows,
      withoutRowid: offsetPaging,
    };
  }
  throw new ServiceError(
    "unavailable",
    "The database schema kept changing while reading a backup. Try again.",
  );
}

/**
 * The data's state, cheap to compute: the revision (every change to the project raises
 * it) and each backed-up table's last rowid (every new row changes it, so a row deleted
 * and written again does too). Rows changed in place without a new revision (a sign-in, a
 * changed role) leave it as it was, and so does `meta`, whose few rows (the revision, the
 * next wake-up, the setup token) are read in one chunk.
 */
export function dataState(ctx: Pick<Context, "sql">): string {
  return [...stateParts(ctx)].map(([name, value]) => `${name}=${value}`).join(" ");
}

function stateParts(ctx: Pick<Context, "sql">): Map<string, number> {
  const plan = backupStatePlan(schemaObjects(ctx));
  const rows = plan.statements.map((statement) => ctx.sql.query(statement.sql));
  return plan.decode(rows, getRevision(ctx.sql));
}

/** Capture restore/backup state inside a larger batch without loading table contents. */
export function backupStatePlan(objects: SchemaObject[]) {
  const tables = backupTableObjects(objects).filter(
    (object) => object.name !== "meta" && !INTERNAL_TABLE.test(object.name),
  );
  return {
    statements: tables.map(
      (object): Statement => ({
        sql: `SELECT ${isWithoutRowid(object) ? "COUNT(*)" : "MAX(rowid)"} AS n FROM ${quote(object.name)}`,
      }),
    ),
    decode(rows: SqlRow[][], revision: number): Map<string, number> {
      return new Map([
        ["revision", revision],
        ...tables.map((object, index): [string, number] => [
          object.name,
          Number(rows[index][0]?.n ?? 0),
        ]),
      ]);
    },
  };
}

/**
 * Whether the data is still in a `state` recorded earlier. Tables created since (by the
 * migrations a start runs) count only once they have rows.
 */
function stillInState(ctx: Pick<Context, "sql">, state: string): boolean {
  return stateMatches(state, stateParts(ctx));
}

function stateMatches(state: string, current: Map<string, number>): boolean {
  const recorded = new Map(
    state.split(" ").map((part) => {
      const at = part.lastIndexOf("=");
      return [part.slice(0, at), Number(part.slice(at + 1))] as const;
    }),
  );
  for (const [name, value] of current) {
    if (recorded.has(name) ? recorded.get(name) !== value : value !== 0) return false;
  }
  return [...recorded.keys()].every((name) => current.has(name));
}

/** Whether a table was created `WITHOUT ROWID`: it is read by offset instead. */
function withoutRowid(ctx: Pick<Context, "sql">, table: string): boolean {
  const object = schemaObjects(ctx).find((row) => row.name === table);
  return object !== undefined && isWithoutRowid(object);
}

function isWithoutRowid(object: SchemaObject): boolean {
  return /\bWITHOUT\s+ROWID\b/i.test(object.sql ?? "");
}

/** The column of the rowid in `backupTables`' queries, dropped from the result. */
const ROWID = "_quaso_rowid";

/** What `backupTables` says when the data changed since `backupInfo`. */
export const BACKUP_CHANGED =
  "The data changed while the backup was being read, so it wouldn't be one moment's copy: start the backup again.";

/**
 * `backupTables`: up to `limit` rows of `table` whose rowid is above `after`; `conflict`
 * when `state` is given and the data changed since.
 */
export function backupTables(ctx: ReadContext, input: BackupTablesInput): BackupChunk {
  const { table } = input;
  if (!backupTableNames(ctx).includes(table)) throw notFound(`The table ${table}`);
  if (input.state !== undefined && input.state !== dataState(ctx)) {
    throw new ServiceError("conflict", BACKUP_CHANGED);
  }
  const offsetPaging = withoutRowid(ctx, table);
  const statement = backupSelection(input, offsetPaging);
  const rows = ctx.sql.query(statement.sql, ...(statement.params ?? []));
  return backupChunk(input, rows, offsetPaging, getRevision(ctx.sql));
}

function backupSelection(input: BackupTablesInput, offsetPaging: boolean): Statement {
  const limit = Math.min(input.limit ?? DEFAULT_BACKUP_CHUNK, MAX_BACKUP_CHUNK);
  const after = input.after ?? 0;
  const table = quote(input.table);
  if (offsetPaging)
    return {
      sql: `SELECT * FROM ${table} WHERE ${metaFilter(input.table)} LIMIT ? OFFSET ?`,
      params: [limit + 1, after],
    };
  return {
    sql: `SELECT rowid AS ${ROWID}, * FROM ${table} WHERE rowid > ? AND ${metaFilter(input.table)} ORDER BY rowid LIMIT ?`,
    params: [after, limit + 1],
  };
}

function backupChunk(
  input: BackupTablesInput,
  found: SqlRow[],
  offsetPaging: boolean,
  revision: number,
): BackupChunk {
  const limit = Math.min(input.limit ?? DEFAULT_BACKUP_CHUNK, MAX_BACKUP_CHUNK);
  const after = input.after ?? 0;
  const cursor = offsetPaging ? after + limit : Number(found[limit - 1]?.[ROWID]);
  const next = found.length > limit ? cursor : null;
  const rows = found.slice(0, limit);
  const columns = rows.length === 0 ? [] : Object.keys(rows[0]).filter((name) => name !== ROWID);
  return {
    table: input.table,
    columns,
    rows: rows.map((row) => columns.map((column) => toJsonValue(row[column]))),
    next,
    revision,
  };
}

/** A value as JSON carries it: blobs as base64, whole bigints as numbers. */
export function toJsonValue(value: SqlValue | undefined): unknown {
  if (value instanceof Uint8Array) return { $base64: toBase64(value) };
  if (typeof value === "bigint") return Number(value);
  return value ?? null;
}

/** A value from JSON for SQL: `{ "$base64" }` as a blob. */
export function fromJsonValue(value: unknown, where: string): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof (value as Base64Value).$base64 === "string"
  ) {
    return fromBase64((value as Base64Value).$base64);
  }
  throw badRequest(`The backup has a value that isn't text, a number or a blob in ${where}.`);
}

/**
 * Reads a backup from any database with the service's schema, such as a snapshot of local
 * storage (which no write changes, so it is one moment's copy without retries). It checks
 * no permission: the caller does, with the service's `backupInfo`, before.
 */
export function sqlBackupReader(sql: SyncSql, clock: Clock = Date.now): BackupReader {
  const ctx: ReadContext = { sql, clock };
  return {
    backupInfo: () => Promise.resolve(backupInfo(ctx)),
    backupTables: (_actor, input) => Promise.resolve(backupTables(ctx, input)),
  };
}

/** Reads a private database snapshot; permission checks belong to the host creating it. */
export function sqlAsyncBackupReader(sql: Sql, clock: Clock = Date.now): BackupReader {
  const system: Actor = { type: "system" };
  return {
    backupInfo: () => backupInfoAsync(sql, system, clock()),
    backupTables: (_actor, input) => backupTablesAsync(sql, system, input),
  };
}

/** How many times a backup starts again when writes keep changing the data. */
export const BACKUP_ATTEMPTS = 3;

/**
 * Runs `read` (one whole backup) until no write interrupted it (`backupTables`' `conflict`),
 * at most `attempts` times; then fails with `unavailable`. `read` must start over each
 * time, from a new `backupInfo`.
 */
export async function withBackupRetries<T>(
  read: (attempt: number) => Promise<T>,
  attempts = BACKUP_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(attempt);
    } catch (error) {
      const changed =
        error instanceof ServiceError &&
        error.code === "conflict" &&
        error.message === BACKUP_CHANGED;
      if (!changed) throw error;
      if (attempt >= attempts) {
        throw new ServiceError(
          "unavailable",
          `The data changed while the backup was being read, ${attempts} times in a row (LLM jobs or people at work): try again in a while.`,
        );
      }
    }
  }
}

/**
 * The backup document (`BackupDocument`) as a stream of UTF-8 JSON, read in chunks from a
 * service: the server's `GET /backup?format=json`, and the Durable Object's nightly backup.
 * `onInfo` receives the manifest before the first row. Every chunk is read at the state
 * `backupInfo` gave: if the data changes meanwhile, the stream fails with `conflict`
 * (`BACKUP_CHANGED`), and the backup must start again.
 */
export function backupJsonStream(
  source: BackupReader,
  actor: Actor,
  options: { chunk?: number; onInfo?: (info: BackupInfo) => void } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  async function* parts(): AsyncGenerator<string> {
    const info = await source.backupInfo(actor, {});
    options.onInfo?.(info);
    yield `{"format":${JSON.stringify(info.format)},"version":${info.version},` +
      `"schemaVersion":${info.schemaVersion},"createdAt":${info.createdAt},` +
      `"revision":${info.revision},"tables":{`;
    // Children first: see the module's comment.
    const tables = [...info.tables].reverse();
    for (let t = 0; t < tables.length; t++) {
      yield `${t === 0 ? "" : ","}\n${JSON.stringify(tables[t].name)}:[`;
      let after: number | undefined = undefined;
      let first = true;
      for (;;) {
        const chunk: BackupChunk = await source.backupTables(actor, {
          table: tables[t].name,
          after,
          limit: options.chunk,
          state: info.state,
        });
        let text = "";
        for (const row of chunk.rows) {
          const object: Record<string, unknown> = {};
          chunk.columns.forEach((column, i) => (object[column] = row[i]));
          text += `${first ? "" : ","}\n${JSON.stringify(object)}`;
          first = false;
        }
        if (text !== "") yield text;
        if (chunk.next === null) break;
        after = chunk.next;
      }
      yield "]";
    }
    yield "\n}}\n";
  }
  const iterator = parts();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

/** Checks the start of a backup document. */
export function checkBackupHeader(
  document: Partial<BackupDocument> | null,
): asserts document is BackupDocument {
  if (document === null || typeof document !== "object" || document.format !== BACKUP_FORMAT) {
    throw badRequest("This isn't a Quaso backup (its format isn't quaso-backup).");
  }
  if (document.version !== BACKUP_VERSION) {
    throw badRequest(
      `This backup has format version ${document.version}; this release reads version ${BACKUP_VERSION}.`,
    );
  }
}

// ---------------------------------------------------------------------------------------
// Restore

/** `beginRestore`'s input: the backup's header. */
export interface BeginRestoreInput {
  format: string;
  version: number;
  schemaVersion: number;
}

/** What `beginRestore` created: the tables to fill, in the order to fill them. */
export interface BeginRestoreResult {
  schemaVersion: number;
  tables: string[];
}

interface RestoreMarker {
  schemaVersion: number;
  startedAt: number;
  /** Rows the restore left out, by table: `meta` rows it never writes. */
  skipped?: Record<string, number>;
  /**
   * The data's state (`dataState`) after the restore's last step. While it still matches,
   * nothing but the restore wrote here, and a restore that didn't finish may start again.
   */
  state?: string;
}

function requireSystem(actor: Actor): void {
  if (actor.type !== "system") {
    throw forbidden("Only the server restores backups (quaso restore, or POST /restore at setup).");
  }
}

function restoreMarker(ctx: Pick<Context, "sql">): RestoreMarker | null {
  if (!tableExists(ctx, "meta")) return null;
  const value = getMeta(ctx.sql, RESTORE_META);
  return value === null ? null : (JSON.parse(value) as RestoreMarker);
}

/** Stores the marker with the data's state now: call it after each step of a restore. */
function saveRestoreMarker(ctx: Context, marker: RestoreMarker): void {
  setMeta(ctx.sql, RESTORE_META, JSON.stringify({ ...marker, state: dataState(ctx) }));
}

/**
 * A restore that didn't finish and after which nothing else wrote here: it may start
 * again. Once the instance is used (an upload, a new account, a changed setting…), the
 * restore is over, finished or not: another one needs an empty instance.
 */
function resumableRestore(ctx: Pick<Context, "sql">): RestoreMarker | null {
  const marker = restoreMarker(ctx);
  return marker?.state !== undefined && stillInState(ctx, marker.state) ? marker : null;
}

/**
 * A restore that didn't finish: when it started, and whether it may start again (nothing
 * else wrote here since; LLM jobs wait meanwhile, as its data may be incomplete).
 */
export function unfinishedRestore(
  ctx: Pick<Context, "sql">,
): { startedAt: number; resumable: boolean } | null {
  const value = tableExists(ctx, "meta") ? getMeta(ctx.sql, RESTORE_META) : null;
  return unfinishedRestoreFromState(value, value === null ? new Map() : stateParts(ctx));
}

export function unfinishedRestoreFromState(
  value: string | null,
  state: Map<string, number>,
): { startedAt: number; resumable: boolean } | null {
  if (value === null) return null;
  const marker = JSON.parse(value) as RestoreMarker | null;
  if (marker === null) return null;
  return {
    startedAt: marker.startedAt,
    resumable: marker.state !== undefined && stateMatches(marker.state, state),
  };
}

/**
 * Why the instance isn't empty, or null: a backup only restores into an instance with no
 * strings and no one with a role (people who only signed up are replaced). A restore that
 * didn't finish may start again, as long as nothing else wrote here since.
 */
export function notEmptyReason(ctx: Context): string | null {
  if (resumableRestore(ctx) !== null) return null;
  const count = (sql: string) => ctx.sql.query<{ n: number }>(sql)[0].n;
  let reason: string | null = null;
  if (tableExists(ctx, "strings") && count("SELECT COUNT(*) AS n FROM strings") > 0) {
    reason = "it has strings";
  } else if (
    tableExists(ctx, "users") &&
    count("SELECT COUNT(*) AS n FROM users WHERE role <> 'none' AND deleted_at IS NULL") > 0
  ) {
    reason = "it has people with roles";
  }
  if (reason !== null && restoreMarker(ctx) !== null) {
    reason += " (an earlier restore didn't finish, and the instance has been used since)";
  }
  return reason;
}

/**
 * Whether `token` is the setup token kept by a restore in progress: a restore that didn't
 * finish may already have brought administrators in, so the setup token no longer counts
 * as such, yet `POST /restore` should be able to start it again with the same token (until
 * something else writes to the instance).
 */
export function restoreTokenValid(ctx: Context, token: string): boolean {
  if (resumableRestore(ctx) === null) return false;
  const stored = getMeta(ctx.sql, SETUP_TOKEN);
  return stored !== null && constantTimeEqualText(stored, token);
}

/** Only the host checks restore credentials; state and token share the final snapshot. */
export async function restoreTokenValidAsync(
  sql: Sql,
  actor: Actor,
  token: string,
): Promise<boolean> {
  requireSystem(actor);
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared] = await sql.read([schema]);
    const state = backupStatePlan(prepared as SchemaObject[]);
    const [current, metadata, ...rows] = await sql.read([
      schema,
      {
        sql: "SELECT key, value FROM meta WHERE key IN (?, ?, ?)",
        params: [RESTORE_META, SETUP_TOKEN, "revision"],
      },
      ...state.statements,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const restore = unfinishedRestoreFromState(
      meta.get(RESTORE_META) ?? null,
      state.decode(rows, Number(meta.get("revision") ?? 0)),
    );
    if (restore === null || !restore.resumable) return false;
    const stored = meta.get(SETUP_TOKEN);
    return stored !== undefined && constantTimeEqualText(stored, token);
  }
  throw new ServiceError(
    "unavailable",
    "The database schema kept changing while checking a restore token. Try again.",
  );
}

/**
 * Starts a restore (the system only): checks the backup's format and schema version and
 * that this instance is empty, then drops every table and creates the backup's schema
 * version, ready for its rows. Everything in the instance before is gone.
 */
export async function beginRestore(
  ctx: Context,
  actor: Actor,
  input: BeginRestoreInput,
): Promise<BeginRestoreResult> {
  requireSystem(actor);
  checkBackupHeader(input as Partial<BackupDocument>);
  const version = input.schemaVersion;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw badRequest("The backup's schema version is missing or invalid.");
  }
  if (version > DATABASE_VERSION) {
    throw badRequest(
      `The backup has schema version ${version}, but this release of Quaso only knows versions up to ${DATABASE_VERSION}. Upgrade Quaso, then restore it.`,
    );
  }
  // The setup token stays, so that a restore made with it (POST /restore) can start again.
  let setupToken: string | null = null;
  let instanceSecrets: SqlRow[] = [];
  ctx.sql.transaction(() => {
    if (tableExists(ctx, "meta")) setupToken = getMeta(ctx.sql, SETUP_TOKEN);
    if (tableExists(ctx, "secrets")) instanceSecrets = ctx.sql.query(INSTANCE_SECRETS.sql);
    const reason = notEmptyReason(ctx);
    if (reason !== null) {
      throw new ServiceError(
        "conflict",
        `A backup only restores into an empty instance, and this one isn't: ${reason}.`,
      );
    }
    const objects = schemaObjects(ctx).reverse();
    for (const object of objects) {
      ctx.sql.script(`DROP ${object.type === "view" ? "VIEW" : "TABLE"} ${quote(object.name)}`);
    }
  });
  await migrate(ctx.sql, { migrations: MIGRATIONS.slice(0, version) });
  const marker: RestoreMarker = { schemaVersion: version, startedAt: ctx.clock() };
  ctx.sql.transaction(() => {
    if (setupToken !== null) setMeta(ctx.sql, SETUP_TOKEN, setupToken);
    for (const secret of instanceSecrets)
      ctx.sql.run(
        "INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)",
        secret.name,
        secret.value,
        secret.updated_at,
      );
    saveRestoreMarker(ctx, marker);
  });
  ctx.logger.warn("Restoring a backup", { schemaVersion: version });
  return { schemaVersion: version, tables: backupTableNames(ctx) };
}

/** Replaces the restore schema and installs its resume marker in the guarded transaction. */
export async function beginRestoreAsync(
  sql: Sql,
  actor: Actor,
  input: BeginRestoreInput,
  now: number,
): Promise<BeginRestoreResult> {
  requireSystem(actor);
  checkBackupHeader(input as Partial<BackupDocument>);
  const version = input.schemaVersion;
  if (!Number.isSafeInteger(version) || version < 1)
    throw badRequest("The backup's schema version is missing or invalid.");
  if (version > DATABASE_VERSION)
    throw badRequest(
      `The backup has schema version ${version}, but this release of Quaso only knows versions up to ${DATABASE_VERSION}. Upgrade Quaso, then restore it.`,
    );
  const migrations = BATCH_MIGRATIONS.slice(0, version);
  const created: SchemaObject[] = migrations.flatMap((migration) =>
    migration.statements.flatMap((statement) => {
      const name = statement.sql.match(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/)?.[1];
      return name === undefined ? [] : [{ name, type: "table", sql: statement.sql }];
    }),
  );
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared] = await sql.read([schema]);
    const objects = prepared as SchemaObject[];
    const state = backupStatePlan(objects);
    const hasTable = (name: string) =>
      objects.some((object) => object.type === "table" && object.name === name);
    const [current, metadata, strings, people, instanceSecrets, ...rows] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision', 'setup_token')" },
      { sql: hasTable("strings") ? "SELECT COUNT(*) AS n FROM strings" : "SELECT 0 AS n" },
      {
        sql: hasTable("users")
          ? "SELECT COUNT(*) AS n FROM users WHERE role <> 'none' AND deleted_at IS NULL"
          : "SELECT 0 AS n",
      },
      hasTable("secrets") ? INSTANCE_SECRETS : { sql: "SELECT NULL AS name WHERE 0" },
      ...state.statements,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const revision = Number(meta.get("revision") ?? 0);
    const restore = unfinishedRestoreFromState(
      meta.get(RESTORE_META) ?? null,
      state.decode(rows, revision),
    );
    let reason =
      Number(strings[0].n) > 0
        ? "it has strings"
        : Number(people[0].n) > 0
          ? "it has people with roles"
          : null;
    if (restore?.resumable) reason = null;
    if (reason !== null) {
      if (restore !== null)
        reason += " (an earlier restore didn't finish, and the instance has been used since)";
      throw new ServiceError(
        "conflict",
        `A backup only restores into an empty instance, and this one isn't: ${reason}.`,
      );
    }
    const statements: Statement[] = [{ sql: "PRAGMA defer_foreign_keys = ON" }];
    for (const object of [...objects].reverse()) {
      // Keeping the guard preserves its trigger throughout schema replacement.
      if (object.name === "revision_guard" || INTERNAL_TABLE.test(object.name)) continue;
      statements.push({
        sql: `DROP ${object.type === "view" ? "VIEW" : "TABLE"} ${quote(object.name)}`,
      });
    }
    for (const migration of migrations)
      statements.push(...migration.statements, {
        sql: "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: [String(migration.version)],
      });
    statements.push({
      sql: "INSERT INTO meta (key, value) VALUES ('revision', ?)",
      params: [String(revision + 1)],
    });
    const setupToken = meta.get(SETUP_TOKEN);
    if (setupToken !== undefined)
      statements.push({
        sql: "INSERT INTO meta (key, value) VALUES (?, ?)",
        params: [SETUP_TOKEN, setupToken],
      });
    for (const secret of instanceSecrets)
      statements.push({
        sql: "INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)",
        params: [secret.name, secret.value, secret.updated_at],
      });
    statements.push(restoreMarkerStatement(created, { schemaVersion: version, startedAt: now }));
    try {
      await sql.commit(revision, statements);
      return {
        schemaVersion: version,
        tables: backupTableObjects(created).map((object) => object.name),
      };
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
  }
  throw new ServiceError("unavailable", "The project kept changing before the restore. Try again.");
}

/** Inserts one chunk of a table's rows (the system only, during a restore). */
export function restoreRows(
  ctx: Context,
  actor: Actor,
  input: { table: string; rows: Record<string, unknown>[] },
): { inserted: number; skipped: number } {
  requireSystem(actor);
  if (restoreMarker(ctx) === null) {
    throw badRequest("No restore is in progress: start one with beginRestore.");
  }
  if (resumableRestore(ctx) === null) {
    throw new ServiceError(
      "conflict",
      "Something else wrote to this instance during the restore, so it can't go on: restore into a new, empty instance.",
    );
  }
  const { table, rows } = input;
  if (!Array.isArray(rows)) throw badRequest("rows must be a list of objects.");
  if (SECRET_TABLES.has(table)) return { inserted: 0, skipped: rows.length };
  if (!backupTableNames(ctx).includes(table)) {
    throw badRequest(`The backup has a table ${table} that this instance's schema doesn't have.`, [
      { path: "table", value: table },
    ]);
  }
  const marker = restoreMarker(ctx)!;
  let skipped = 0;
  const kept =
    table === "meta"
      ? rows.filter((row) => {
          const skip = KEEP_META.has(String(row.key));
          if (skip) skipped++;
          return !skip;
        })
      : rows;
  if (skipped > 0) {
    marker.skipped = { ...marker.skipped, [table]: (marker.skipped?.[table] ?? 0) + skipped };
  }
  insertRows(ctx, table, kept);
  saveRestoreMarker(ctx, marker);
  return { inserted: kept.length, skipped };
}

/** Inserts a restore's rows into a table, several per statement. */
function insertRows(ctx: Context, table: string, kept: Record<string, unknown>[]): void {
  try {
    for (const statement of planRestoreInserts(table, kept))
      ctx.sql.run(statement.sql, ...(statement.params ?? []));
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw badRequest(
      `The backup's rows for ${table} don't fit this instance: ${(error as Error).message}`,
      [{ path: "table", value: table }],
    );
  }
}

function planRestoreInserts(table: string, kept: Record<string, unknown>[]): Statement[] {
  const statements: Statement[] = [];
  const verb = table === "meta" ? "INSERT OR REPLACE" : "INSERT";
  // Consecutive rows with the same columns go in one statement, within the parameter limit.
  let start = 0;
  while (start < kept.length) {
    const columns = Object.keys(kept[start]);
    if (columns.length === 0) throw badRequest(`The backup has an empty row in ${table}.`);
    if (columns.length > SQL_MAX_PARAMS) {
      throw badRequest(`The table ${table} has more than ${SQL_MAX_PARAMS} columns.`);
    }
    const signature = columns.join(",");
    const perStatement = Math.max(1, Math.floor(SQL_MAX_PARAMS / columns.length));
    let end = start + 1;
    while (
      end < kept.length &&
      end - start < perStatement &&
      Object.keys(kept[end]).join(",") === signature
    )
      end++;
    const batch = kept.slice(start, end);
    const tuple = `(${columns.map(() => "?").join(", ")})`;
    const params = batch.flatMap((row, i) =>
      columns.map((column) => fromJsonValue(row[column], `${table} row ${start + i + 1}`)),
    );
    statements.push({
      sql: `${verb} INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${batch.map(() => tuple).join(", ")}`,
      params,
    });
    start = end;
  }
  return statements;
}

/** A chunk and its resume state commit together, without replacing the destination guard revision. */
export async function restoreRowsAsync(
  sql: Sql,
  actor: Actor,
  input: { table: string; rows: Record<string, unknown>[] },
): Promise<{ inserted: number; skipped: number }> {
  requireSystem(actor);
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared] = await sql.read([schema]);
    const objects = prepared as SchemaObject[];
    const state = backupStatePlan(objects);
    const [current, metadata, ...rows] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision')" },
      ...state.statements,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const value = meta.get(RESTORE_META);
    if (value === undefined)
      throw badRequest("No restore is in progress: start one with beginRestore.");
    const marker = JSON.parse(value) as RestoreMarker;
    const revision = Number(meta.get("revision") ?? 0);
    const restore = unfinishedRestoreFromState(value, state.decode(rows, revision));
    if (!restore?.resumable)
      throw new ServiceError(
        "conflict",
        "Something else wrote to this instance during the restore, so it can't go on: restore into a new, empty instance.",
      );
    const { table } = input;
    if (!Array.isArray(input.rows)) throw badRequest("rows must be a list of objects.");
    if (SECRET_TABLES.has(table)) return { inserted: 0, skipped: input.rows.length };
    if (!backupTableObjects(objects).some((object) => object.name === table))
      throw badRequest(
        `The backup has a table ${table} that this instance's schema doesn't have.`,
        [{ path: "table", value: table }],
      );
    // Restoring a source revision would invalidate the destination's concurrent-write guard.
    const kept =
      table === "meta"
        ? input.rows.filter((row) => !RESTORE_CONTROL_META.has(String(row.key)))
        : input.rows;
    const skipped = input.rows.length - kept.length;
    if (skipped > 0)
      marker.skipped = { ...marker.skipped, [table]: (marker.skipped?.[table] ?? 0) + skipped };
    const statements = planRestoreInserts(table, kept);
    if (statements.length === 0 && skipped === 0) return { inserted: 0, skipped: 0 };
    statements.push(restoreMarkerStatement(objects, marker));
    try {
      await sql.commit(revision, statements);
      return { inserted: kept.length, skipped };
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      if (error instanceof ServiceError) throw error;
      throw badRequest(
        `The backup's rows for ${table} don't fit this instance: ${(error as Error).message}`,
        [{ path: "table", value: table }],
      );
    }
  }
  throw new ServiceError("unavailable", "The project kept changing during the restore. Try again.");
}

function restoreMarkerStatement(objects: SchemaObject[], marker: RestoreMarker): Statement {
  const parts = ["'revision=' || COALESCE((SELECT value FROM meta WHERE key = 'revision'), '0')"];
  for (const object of backupTableObjects(objects)) {
    if (object.name === "meta" || INTERNAL_TABLE.test(object.name)) continue;
    const aggregate = isWithoutRowid(object) ? "COUNT(*)" : "MAX(rowid)";
    parts.push(
      `' ${object.name}=' || COALESCE((SELECT ${aggregate} FROM ${quote(object.name)}), 0)`,
    );
  }
  return {
    sql: `INSERT INTO meta (key, value) VALUES ('restore', json_set(?, '$.state', (${parts.join(" || ")}))) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    params: [JSON.stringify(marker)],
  };
}

/**
 * Ends a restore (the system only): checks each table's row count against the backup's,
 * migrates from the backup's schema version to this release's, and raises the revision.
 */
export async function finishRestore(
  ctx: Context,
  actor: Actor,
  input: { counts: Record<string, number> },
): Promise<RestoreResult> {
  requireSystem(actor);
  const marker = restoreMarker(ctx);
  if (marker === null) throw badRequest("No restore is in progress.");
  const tables: Record<string, number> = {};
  const wrong: string[] = [];
  for (const [table, expected] of Object.entries(input.counts)) {
    if (SECRET_TABLES.has(table)) continue;
    if (!backupTableNames(ctx).includes(table)) {
      throw badRequest(`The backup has a table ${table} that this instance's schema doesn't have.`);
    }
    let actual = ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quote(table)}`)[0].n;
    if (table === "meta") {
      // The restore's own rows aren't the backup's.
      actual = ctx.sql.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM meta WHERE key NOT IN (${[...KEEP_META]
          .map((key) => `'${key}'`)
          .join(", ")})`,
      )[0].n;
    }
    const wanted = expected - (marker.skipped?.[table] ?? 0);
    tables[table] = actual;
    if (actual !== wanted) wrong.push(`${table}: ${actual} of ${wanted} rows`);
  }
  if (wrong.length > 0) {
    throw badRequest(`The restore is incomplete: ${wrong.join("; ")}. Start it again.`);
  }
  const migrated = await migrate(ctx.sql);
  ctx.sql.transaction(() => {
    deleteMeta(ctx.sql, RESTORE_META);
    if (!setupRequired(ctx.sql)) deleteMeta(ctx.sql, SETUP_TOKEN);
    bumpRevision(ctx.sql);
  });
  const result: RestoreResult = {
    schemaVersion: { from: marker.schemaVersion, to: migrated.to },
    tables,
    revision: getRevision(ctx.sql),
    missingSecrets: configuredSecrets(ctx.sql.query(SECRET_REQUIREMENTS.sql)),
  };
  ctx.logger.warn("Restored a backup", {
    schemaVersion: result.schemaVersion,
    revision: result.revision,
  });
  return result;
}

/** Validates restored counts, upgrades the schema and ends the marker in one guarded commit. */
export async function finishRestoreAsync(
  sql: Sql,
  actor: Actor,
  input: { counts: Record<string, number> },
): Promise<RestoreResult> {
  requireSystem(actor);
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared] = await sql.read([schema]);
    const objects = prepared as SchemaObject[];
    const tables = backupTableObjects(objects).map((object) => object.name);
    const state = backupStatePlan(objects);
    const counts: Statement[] = tables.map((table) => ({
      sql: `SELECT COUNT(*) AS n FROM ${quote(table)}${table === "meta" ? ` WHERE key NOT IN (${[...RESTORE_CONTROL_META].map(() => "?").join(", ")})` : ""}`,
      params: table === "meta" ? [...RESTORE_CONTROL_META] : [],
    }));
    const [current, metadata, requirements, ...rows] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision', 'schema_version')" },
      SECRET_REQUIREMENTS,
      ...counts,
      ...state.statements,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const value = meta.get(RESTORE_META);
    if (value === undefined) throw badRequest("No restore is in progress.");
    const marker = JSON.parse(value) as RestoreMarker;
    const revision = Number(meta.get("revision") ?? 0);
    const restore = unfinishedRestoreFromState(
      value,
      state.decode(rows.slice(tables.length), revision),
    );
    if (!restore?.resumable)
      throw new ServiceError(
        "conflict",
        "Something else wrote to this instance during the restore, so it can't finish: restore into a new, empty instance.",
      );
    const actual = new Map(tables.map((table, index) => [table, Number(rows[index][0].n)]));
    const restored: Record<string, number> = {};
    const wrong: string[] = [];
    for (const [table, expected] of Object.entries(input.counts)) {
      if (SECRET_TABLES.has(table)) continue;
      const count = actual.get(table);
      if (count === undefined)
        throw badRequest(
          `The backup has a table ${table} that this instance's schema doesn't have.`,
        );
      const wanted = expected - (marker.skipped?.[table] ?? 0);
      restored[table] = count;
      if (count !== wanted) wrong.push(`${table}: ${count} of ${wanted} rows`);
    }
    if (wrong.length > 0)
      throw badRequest(`The restore is incomplete: ${wrong.join("; ")}. Start it again.`);
    const from = Number(meta.get("schema_version") ?? 0);
    if (!Number.isSafeInteger(from) || from < 1 || from > DATABASE_VERSION)
      throw badRequest(
        "The restore's database schema version is invalid or newer than this release.",
      );
    const statements: Statement[] = [];
    for (const migration of BATCH_MIGRATIONS) {
      if (migration.version <= from) continue;
      statements.push(...migration.statements, {
        sql: "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: [String(migration.version)],
      });
    }
    statements.push(
      { sql: "DELETE FROM meta WHERE key = 'restore'" },
      {
        sql: "DELETE FROM meta WHERE key = ? AND EXISTS (SELECT 1 FROM users WHERE role = 'administrator' AND deleted_at IS NULL)",
        params: [SETUP_TOKEN],
      },
    );
    try {
      await sql.commit(revision, statements);
      return {
        schemaVersion: { from: marker.schemaVersion, to: DATABASE_VERSION },
        tables: restored,
        revision: revision + 1,
        missingSecrets: configuredSecrets(requirements),
      };
    } catch (error) {
      if (error instanceof RevisionConflict) continue;
      throw error;
    }
  }
  throw new ServiceError(
    "unavailable",
    "The project kept changing while finishing the restore. Try again.",
  );
}

// ---------------------------------------------------------------------------------------
// The last backup, for the admin page

/** Records the last backup (the server's scheduled snapshots, the nightly R2 file). */
export function recordBackup(ctx: Context, input: { at: number; file: string | null }): void {
  const current = lastBackup(ctx);
  if (current !== null && current.at > input.at) return;
  setMeta(ctx.sql, LAST_BACKUP_META, JSON.stringify({ at: input.at, file: input.file }));
}

export async function recordBackupAsync(
  sql: Sql,
  actor: Actor,
  input: { at: number; file: string | null },
): Promise<{ ok: true }> {
  requireSystem(actor);
  return withRetries(
    sql,
    async () => {
      const [revision, metadata] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT value FROM meta WHERE key = 'last_backup'" },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: lastBackupFromData((metadata[0]?.value as string | undefined) ?? null),
      };
    },
    (current) => {
      const newer = current !== null && current.at > input.at;
      const unchanged = current?.at === input.at && current.file === input.file;
      return {
        statements:
          newer || unchanged
            ? []
            : [
                {
                  sql: "INSERT INTO meta (key, value) VALUES ('last_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                  params: [JSON.stringify(input)],
                },
              ],
        result: { ok: true as const },
      };
    },
  );
}

/** The last backup recorded, or null. */
export function lastBackup(ctx: Context): { at: number; file: string | null } | null {
  return lastBackupFromData(getMeta(ctx.sql, LAST_BACKUP_META));
}

export function lastBackupFromData(
  value: string | null,
): { at: number; file: string | null } | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as { at: number; file: string | null };
    return typeof parsed.at === "number" ? { at: parsed.at, file: parsed.file ?? null } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Base64, without runtime-specific helpers

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw badRequest("The backup has a blob that isn't valid base64.");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------------------
// Restoring a whole backup through the service's methods

/** What restoring needs from the service: its restore methods (the system calls them). */
export interface RestoreTarget {
  beginRestore(actor: Actor, input: BeginRestoreInput): Promise<BeginRestoreResult>;
  restoreRows(
    actor: Actor,
    input: { table: string; rows: Record<string, unknown>[] },
  ): Promise<{ inserted: number; skipped: number }>;
  finishRestore(actor: Actor, input: { counts: Record<string, number> }): Promise<RestoreResult>;
}

/** A backup to restore, read table by table: a JSON document, or a SQLite file. */
export interface BackupSource {
  schemaVersion: number;
  /** The backup's tables, with their row counts. */
  counts: Record<string, number>;
  /** A table's rows, in any chunks. */
  rows(
    table: string,
  ): AsyncIterable<Record<string, unknown>[]> | Iterable<Record<string, unknown>[]>;
}

/** The most rows, and about the most bytes of JSON, sent in one `restoreRows` call. */
export const RESTORE_CHUNK_ROWS = 1000;
export const RESTORE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Restores a backup into an empty instance through the service's restore methods, as the
 * system: the server's `quaso restore` and `POST /restore`, with either storage. Tables go
 * in the order `beginRestore` gives (tables before the ones that refer to them), in
 * chunks within `RESTORE_CHUNK_ROWS` and `RESTORE_CHUNK_BYTES`.
 */
export async function restoreBackup(
  target: RestoreTarget,
  source: BackupSource,
  actor: Actor = { type: "system" },
): Promise<RestoreResult> {
  const begun = await target.beginRestore(actor, {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: source.schemaVersion,
  });
  const inBackup = Object.keys(source.counts);
  const order = [
    ...begun.tables.filter((table) => inBackup.includes(table)),
    ...inBackup.filter((table) => !begun.tables.includes(table) && !SECRET_TABLES.has(table)),
  ];
  for (const table of order) {
    let chunk: Record<string, unknown>[] = [];
    let bytes = 0;
    for await (const rows of source.rows(table)) {
      for (const row of rows) {
        const size = JSON.stringify(row).length;
        if (
          chunk.length > 0 &&
          (chunk.length >= RESTORE_CHUNK_ROWS || bytes + size > RESTORE_CHUNK_BYTES)
        ) {
          await target.restoreRows(actor, { table, rows: chunk });
          chunk = [];
          bytes = 0;
        }
        chunk.push(row);
        bytes += size;
      }
    }
    if (chunk.length > 0) await target.restoreRows(actor, { table, rows: chunk });
  }
  return await target.finishRestore(actor, { counts: source.counts });
}

/** Schema versions start afresh in Beta 2, so the release family must match too. */
export function requireBackupGeneration(generation: unknown): void {
  if (generation !== "beta-2") {
    throw badRequest(
      "Beta 1 (1.0.0-rc.1) backups are not supported. Start a fresh Beta 2 instance and import your translation files instead.",
    );
  }
}

/** A parsed JSON backup document as a `BackupSource`. */
export function documentSource(document: unknown): BackupSource {
  checkBackupHeader(document as Partial<BackupDocument> | null);
  const { tables, schemaVersion } = document as BackupDocument;
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    throw badRequest("The backup has no tables.");
  }
  const meta = tables.meta;
  const generation = Array.isArray(meta)
    ? meta.find((row) => row?.key === "schema_generation")?.value
    : undefined;
  requireBackupGeneration(generation);
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) throw badRequest(`The backup's ${table} isn't a list of rows.`);
    counts[table] = rows.length;
  }
  return { schemaVersion, counts, rows: (table) => [tables[table] ?? []] };
}

/** A restore's schema and progress marker must describe the same consistent snapshot. */
export async function unfinishedRestoreAsync(
  sql: Sql,
): Promise<{ startedAt: number; resumable: boolean } | null> {
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared] = await sql.read([schema]);
    const objects = prepared as SchemaObject[];
    if (!objects.some((object) => object.name === "meta" && object.type === "table")) return null;
    const [markers] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'restore'" }]);
    if (markers.length === 0) return null;
    const plan = backupStatePlan(objects);
    const [current, metadata, ...rows] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta WHERE key IN ('restore', 'revision')" },
      ...plan.statements,
    ]);
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key, row.value]));
    return unfinishedRestoreFromState(
      (meta.get(RESTORE_META) as string | undefined) ?? null,
      plan.decode(rows, Number(meta.get("revision") ?? 0)),
    );
  }
  throw new ServiceError(
    "unavailable",
    "The database schema kept changing while checking restore progress. Try again.",
  );
}
