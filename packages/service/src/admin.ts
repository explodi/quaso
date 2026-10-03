// SPDX-License-Identifier: MIT
/**
 * The admin page's data (S9.10, design §8, Observability): the version and the setup,
 * the database, the job queue, the LLM provider's status and this month's usage, and the
 * last backup. The server adds its recent errors.
 */
import type { AdminInfo, UsageTotals } from "@quaso/core";
import {
  backupStatePlan,
  LAST_BACKUP_META,
  lastBackup,
  lastBackupFromData,
  RESTORE_META,
  type SchemaObject,
  unfinishedRestore,
  unfinishedRestoreFromState,
} from "./backup.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { getRevision } from "./db.ts";
import { schemaVersion } from "./migrate.ts";
import { loadSettings, settingsFromData } from "./settings.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql, Statement } from "./ports.ts";
import { ServiceError } from "./errors.ts";

/** What the admin page shows about the host, from `ServiceOptions`. */
export interface AdminHost {
  version: string;
  setup: "local" | "cloudflare";
  startedAt: number;
  /** The database's size in bytes, when the host knows it (a Durable Object does). */
  databaseSize?: () => number | null;
  /** The LLM provider's name, or null without one. */
  provider: "gemini" | "fake" | null;
}

/** `GET /admin`, without the server's recent errors. */
export function getAdminInfo(ctx: Context, host: AdminHost): AdminInfo {
  const settings = loadSettings(ctx);
  return {
    version: host.version,
    setup: host.setup,
    startedAt: host.startedAt,
    database: {
      schemaVersion: schemaVersion(ctx.sql),
      sizeBytes: databaseSize(ctx, host),
      revision: getRevision(ctx.sql),
    },
    recentErrors: restoreErrors(ctx),
    jobs: jobCounts(ctx),
    llm: { provider: host.provider, model: settings.llm.model, ...llmStatus(ctx) },
    usageThisMonth: usageSince(ctx, monthStart(ctx.clock())),
    lastBackup: lastBackup(ctx),
  };
}

/** Table state, administrative access and operational facts share the final snapshot. */
export async function getAdminInfoAsync(
  sql: Sql,
  actor: Actor,
  host: AdminHost,
  model: string,
  now: number,
): Promise<AdminInfo> {
  const schema: Statement = {
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY rowid",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const [prepared, ...preparedPermissions] = await sql.read([
      schema,
      ...permissionReadStatements(actor),
    ]);
    permissionsFromRows(actor, preparedPermissions).require("settings");
    const state = backupStatePlan(prepared as SchemaObject[]);
    const has = (name: string) => prepared.some((row) => row.type === "table" && row.name === name);
    const empty: Statement = { sql: "SELECT 1 WHERE 0" };
    const [current, metadata, stored, jobs, success, errors, usage, ...remaining] = await sql.read([
      schema,
      { sql: "SELECT key, value FROM meta" },
      { sql: "SELECT data FROM settings WHERE id = 1" },
      has("jobs")
        ? {
            sql: "SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running', 'paused') GROUP BY status",
          }
        : empty,
      has("llm_requests")
        ? {
            sql: "SELECT MAX(created_at) AS at FROM llm_requests WHERE outcome IN ('ok', 'partial')",
          }
        : empty,
      has("llm_requests")
        ? {
            sql: "SELECT created_at AS at, error, outcome FROM llm_requests WHERE outcome NOT IN ('ok', 'partial') ORDER BY created_at DESC, id DESC LIMIT 1",
          }
        : empty,
      has("llm_requests") ? { sql: USAGE_SQL, params: [monthStart(now)] } : empty,
      ...state.statements,
      ...permissionReadStatements(actor),
    ]);
    permissionsFromRows(actor, remaining.slice(state.statements.length)).require("settings");
    if (JSON.stringify(current) !== JSON.stringify(prepared)) continue;
    const meta = new Map(metadata.map((row) => [row.key as string, row.value as string]));
    const revision = Number(meta.get("revision") ?? 0);
    const settings = settingsFromData((stored[0]?.data as string | undefined) ?? null, model);
    return {
      version: host.version,
      setup: host.setup,
      startedAt: host.startedAt,
      database: {
        schemaVersion: Number(meta.get("schema_version") ?? 0),
        revision,
        sizeBytes: await databaseSizeAsync(sql, host),
      },
      recentErrors: restoreErrorRows(
        unfinishedRestoreFromState(
          meta.get(RESTORE_META) ?? null,
          state.decode(remaining, revision),
        ),
      ),
      jobs: countsFromRows(jobs as { status: string; n: number }[]),
      llm: {
        provider: host.provider,
        model: settings.llm.model,
        ...statusFromRows(
          success[0] as { at: number | null } | undefined,
          errors[0] as RequestError | undefined,
        ),
      },
      usageThisMonth: usageFromRow(usage[0] as UsageAggregate | undefined),
      lastBackup: lastBackupFromData(meta.get(LAST_BACKUP_META) ?? null),
    };
  }
  throw new ServiceError(
    "unavailable",
    "The database schema kept changing while reading admin information. Try again.",
  );
}

async function databaseSizeAsync(sql: Sql, host: AdminHost): Promise<number | null> {
  try {
    const size = host.databaseSize?.();
    if (typeof size === "number" && Number.isFinite(size)) return size;
  } catch {
    /* SQLite can still report its own size. */
  }
  try {
    const [rows] = await sql.read([
      { sql: "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()" },
    ]);
    return rows[0] === undefined ? null : Number(rows[0].size);
  } catch {
    return null;
  }
}

/** A restore that didn't finish: the data may be incomplete, which the admin page says. */
function restoreErrors(ctx: Context): AdminInfo["recentErrors"] {
  return restoreErrorRows(unfinishedRestore(ctx));
}

function restoreErrorRows(
  restore: { startedAt: number; resumable: boolean } | null,
): AdminInfo["recentErrors"] {
  if (restore === null) return [];
  return [
    {
      at: restore.startedAt,
      message: restore.resumable
        ? "A restore of a backup didn't finish, so some of its data is missing here, and LLM jobs wait. Run the restore again: it starts over."
        : "A restore of a backup didn't finish, so some of its data may be missing here. Restore the backup again, into a new, empty instance.",
    },
  ];
}

/**
 * The database's size: the host's answer, or pages × page size where SQLite lets us read
 * them with its pragma functions (`node:sqlite` does), or null.
 */
function databaseSize(ctx: Context, host: AdminHost): number | null {
  try {
    const size = host.databaseSize?.();
    if (typeof size === "number" && Number.isFinite(size)) return size;
  } catch {
    // Fall back to SQLite's own numbers.
  }
  try {
    const [row] = ctx.sql.query<{ size: number }>(
      "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()",
    );
    return row === undefined ? null : Number(row.size);
  } catch {
    return null;
  }
}

function tableExists(ctx: Context, name: string): boolean {
  return (
    ctx.sql.query("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", name)
      .length > 0
  );
}

/** Jobs waiting, running and paused (0 before the jobs table exists). */
function jobCounts(ctx: Context): AdminInfo["jobs"] {
  if (!tableExists(ctx, "jobs")) return countsFromRows([]);
  const rows = ctx.sql.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM jobs
     WHERE status IN ('queued', 'running', 'paused') GROUP BY status`,
  );
  return countsFromRows(rows);
}

function countsFromRows(rows: { status: string; n: number }[]): AdminInfo["jobs"] {
  const counts = { queued: 0, running: 0, paused: 0 };
  for (const row of rows) counts[row.status as keyof typeof counts] = row.n;
  return counts;
}

/** The provider's last success and last error, from the requests the service recorded. */
function llmStatus(ctx: Context): Pick<AdminInfo["llm"], "lastSuccessAt" | "lastError"> {
  if (!tableExists(ctx, "llm_requests")) return { lastSuccessAt: null, lastError: null };
  const [success] = ctx.sql.query<{ at: number | null }>(
    "SELECT MAX(created_at) AS at FROM llm_requests WHERE outcome IN ('ok', 'partial')",
  );
  const [error] = ctx.sql.query<RequestError>(
    `SELECT created_at AS at, error, outcome FROM llm_requests
     WHERE outcome NOT IN ('ok', 'partial') ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  return statusFromRows(success, error);
}

type RequestError = { at: number; error: string | null; outcome: string };
function statusFromRows(
  success: { at: number | null } | undefined,
  error: RequestError | undefined,
): Pick<AdminInfo["llm"], "lastSuccessAt" | "lastError"> {
  return {
    lastSuccessAt: success?.at ?? null,
    lastError:
      error === undefined
        ? null
        : { at: error.at, message: error.error ?? `The request ${error.outcome}` },
  };
}

/** The first moment of the month of `time`, in UTC. */
export function monthStart(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Requests and tokens since `from` (0s before the requests table exists). */
function usageSince(ctx: Context, from: number): UsageTotals {
  if (!tableExists(ctx, "llm_requests")) return usageFromRow(undefined);
  const [row] = ctx.sql.query<UsageAggregate>(USAGE_SQL, from);
  return usageFromRow(row);
}

type UsageAggregate = {
  requests: number;
  failures: number | null;
  input: number | null;
  output: number | null;
  thinking: number | null;
};
const USAGE_SQL = `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN outcome IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS failures,
            SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(thinking_tokens) AS thinking
     FROM llm_requests WHERE created_at >= ?`;

function usageFromRow(row: UsageAggregate | undefined): UsageTotals {
  if (row === undefined)
    return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  return {
    requests: row.requests,
    failures: row.failures ?? 0,
    inputTokens: row.input ?? 0,
    outputTokens: row.output ?? 0,
    thinkingTokens: row.thinking ?? 0,
  };
}
