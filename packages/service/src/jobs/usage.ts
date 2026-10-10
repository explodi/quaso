// SPDX-License-Identifier: MIT
/**
 * LLM usage (design §5.6, LLM-7): every request to the provider is a row of `llm_requests`,
 * with its model, tokens, duration and outcome. The usage page reads totals per UTC day or
 * month, by language and by model, and the optional monthly token budget pauses jobs.
 */
import type { UsageQuery, UsageResult, UsageRow, UsageTotals } from "@quaso/core";
import type { Context } from "../context.ts";
import type { Actor } from "../api.ts";
import { badRequest, forbidden } from "../errors.ts";
import { SYSTEM } from "../api.ts";
import { withRetries } from "../write.ts";
import { jobTokensStatement } from "./store.ts";
import type { Usage } from "../llm/provider.ts";
import { permissionReadStatements, permissionsFromRows } from "../permissions.ts";
import type { Sql, Statement } from "../ports.ts";

const DAY = 24 * 60 * 60 * 1000;

/** The longest ranges `getUsage` answers. */
export const MAX_DAYS = 400;
export const MAX_MONTHS = 120;

export interface RequestRecord {
  jobId: number | null;
  countsBudget?: boolean;
  language: string | null;
  fileId: number | null;
  provider: string;
  model: string;
  strings: number;
  usage: Usage;
  durationMs: number;
  outcome: "ok" | "partial" | "failed" | "blocked";
  error: string | null;
}

/** Records a request to the provider. Returns its ID. */
export function recordRequest(ctx: Context, record: RequestRecord): number {
  const statement = requestStatement(null, record, ctx.clock());
  const [row] = ctx.sql.query<{ id: number }>(
    `${statement.sql} RETURNING id`,
    ...(statement.params ?? []),
  );
  return row.id;
}

function requestStatement(id: number | null, record: RequestRecord, now: number): Statement {
  return {
    sql: `INSERT INTO llm_requests (id, job_id, language, file_id, provider, model, strings,
       input_tokens, output_tokens, thinking_tokens, duration_ms, outcome, error, created_at, counts_budget)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id,
      record.jobId,
      record.language,
      record.fileId,
      record.provider,
      record.model,
      record.strings,
      Math.round(record.usage.inputTokens),
      Math.round(record.usage.outputTokens),
      Math.round(record.usage.thinkingTokens),
      Math.max(0, Math.round(record.durationMs)),
      record.outcome,
      record.error,
      now,
      record.countsBudget === false ? 0 : 1,
    ],
  };
}

export function requestWriteStatements(
  id: number,
  record: RequestRecord,
  now: number,
): Statement[] {
  return [
    requestStatement(id, record, now),
    ...(record.jobId === null ? [] : [jobTokensStatement(record.jobId, record.usage, now)]),
  ];
}

/** Usage survives cancellation; recording it and adding job tokens is one guarded write. */
export async function recordRequestAsync(
  sql: Sql,
  actor: Actor,
  record: RequestRecord,
  now: number,
  expectedJobCreatedAt?: number,
): Promise<number> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server records provider usage.");
  return withRetries(
    sql,
    async () => {
      const [revision, next, jobs] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM llm_requests" },
        { sql: "SELECT created_at FROM jobs WHERE id = ?", params: [record.jobId] },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          id: Number(next[0].id),
          sameJob:
            expectedJobCreatedAt === undefined ||
            Number(jobs[0]?.created_at) === expectedJobCreatedAt,
        },
      };
    },
    (state) => ({
      statements: requestWriteStatements(
        state.id,
        { ...record, jobId: state.sameJob ? record.jobId : null },
        now,
      ),
      result: state.id,
    }),
  );
}

/** The start of the UTC month of `at`. */
export function monthStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The start of the next UTC month after `at`. */
export function nextMonthStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** Tokens used this UTC month: input, output and thinking. */
export function usedThisMonth(ctx: Context): number {
  const statement = monthlyUsage(ctx.clock());
  const [row] = ctx.sql.query<{ n: number | null }>(statement.sql, ...(statement.params ?? []));
  return row.n ?? 0;
}

/** Whether the monthly budget is used up. */
export function budgetExhausted(ctx: Context, budget: number | null): boolean {
  return budget !== null && usedThisMonth(ctx) >= budget;
}

/** `GET /usage`: rows per UTC day or month, by language and by model, and the budget. */
export function getUsage(ctx: Context, query: UsageQuery, budget: number | null): UsageResult {
  const { periods, statement } = usageSelection(query, ctx.clock());
  const found = ctx.sql.query<UsageGroup>(statement.sql, ...(statement.params ?? []));
  return usageResult(query, budget, periods.keys, found, usedThisMonth(ctx));
}

/** Aggregates, the monthly budget total and permissions are read together. */
export async function getUsageAsync(
  sql: Sql,
  actor: Actor,
  query: UsageQuery,
  budget: number | null,
  now: number,
): Promise<UsageResult> {
  const { periods, statement } = usageSelection(query, now);
  const [found, monthly, ...permissionRows] = await sql.read([
    statement,
    monthlyUsage(now),
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("usage");
  return usageResult(
    query,
    budget,
    periods.keys,
    found as UsageGroup[],
    (monthly[0].n as number | null) ?? 0,
  );
}

export function monthlyUsage(now: number): Statement {
  return {
    sql: `SELECT SUM(input_tokens + output_tokens + thinking_tokens) AS n FROM llm_requests
      WHERE created_at >= ? AND counts_budget = 1`,
    params: [monthStart(now)],
  };
}

type UsageGroup = {
  day: number;
  language: string | null;
  model: string;
  requests: number;
  failures: number;
  input: number;
  output: number;
  thinking: number;
};

function usageSelection(query: UsageQuery, now: number) {
  const periods = query.period === "day" ? dayPeriods(query, now) : monthPeriods(query, now);
  return {
    periods,
    statement: {
      sql: `SELECT created_at - (created_at % ${DAY}) AS day, language, model, COUNT(*) AS requests,
        SUM(CASE WHEN outcome IN ('failed', 'blocked') THEN 1 ELSE 0 END) AS failures,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(thinking_tokens) AS thinking
        FROM llm_requests WHERE created_at >= ? AND created_at < ?
        GROUP BY day, language, model`,
      params: [periods.from, periods.to],
    },
  };
}

function usageResult(
  query: UsageQuery,
  budget: number | null,
  keys: string[],
  found: UsageGroup[],
  used: number,
): UsageResult {
  const rows = new Map<string, UsageRow>(
    keys.map((key) => [key, { period: key, ...zero(), byLanguage: {}, byModel: {} }]),
  );
  for (const item of found) {
    const iso = new Date(item.day).toISOString();
    const key = query.period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
    const row = rows.get(key);
    if (row === undefined) continue;
    const totals: UsageTotals = {
      requests: item.requests,
      failures: item.failures,
      inputTokens: item.input,
      outputTokens: item.output,
      thinkingTokens: item.thinking,
    };
    add(row, totals);
    if (item.language !== null) add((row.byLanguage[item.language] ??= zero()), totals);
    add((row.byModel[item.model] ??= zero()), totals);
  }
  return {
    period: query.period,
    rows: [...rows.values()],
    budget: {
      monthlyTokens: budget,
      usedThisMonth: used,
      paused: budget !== null && used >= budget,
    },
  };
}

function zero(): UsageTotals {
  return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
}

function add(target: UsageTotals, totals: UsageTotals): void {
  target.requests += totals.requests;
  target.failures += totals.failures;
  target.inputTokens += totals.inputTokens;
  target.outputTokens += totals.outputTokens;
  target.thinkingTokens += totals.thinkingTokens;
}

/** Days from `from` to `to` (inclusive), by default the last 30. */
function dayPeriods(query: UsageQuery, now: number): { keys: string[]; from: number; to: number } {
  const today = now - (now % DAY);
  const to = query.to === undefined ? today : parseDay(query.to, "to");
  const from = query.from === undefined ? to - 29 * DAY : parseDay(query.from, "from");
  if (from > to) throw badRequest("from must not be after to.");
  const days = Math.round((to - from) / DAY) + 1;
  if (days > MAX_DAYS) throw badRequest(`At most ${MAX_DAYS} days at a time.`);
  const keys = Array.from({ length: days }, (_, i) =>
    new Date(from + i * DAY).toISOString().slice(0, 10),
  );
  return { keys, from, to: to + DAY };
}

/** Months from `from` to `to` (inclusive), by default the last 12. */
function monthPeriods(
  query: UsageQuery,
  now: number,
): { keys: string[]; from: number; to: number } {
  const to = query.to === undefined ? monthStart(now) : parseMonth(query.to, "to");
  const from =
    query.from === undefined
      ? Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth() - 11, 1)
      : parseMonth(query.from, "from");
  if (from > to) throw badRequest("from must not be after to.");
  const keys: string[] = [];
  for (let at = from; at <= to; at = nextMonthStart(at)) {
    keys.push(new Date(at).toISOString().slice(0, 7));
    if (keys.length > MAX_MONTHS) throw badRequest(`At most ${MAX_MONTHS} months at a time.`);
  }
  return { keys, from, to: nextMonthStart(to) };
}

function parseDay(value: string, name: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const at = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!match || new Date(at).toISOString().slice(0, 10) !== value.trim()) {
    throw badRequest(`${name} must be a day such as 2026-09-24, not "${value}".`, [
      { path: name, message: "must be a day such as 2026-09-24" },
    ]);
  }
  return at;
}

function parseMonth(value: string, name: string): number {
  const match = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(value.trim());
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw badRequest(`${name} must be a month such as 2026-09, not "${value}".`, [
      { path: name, message: "must be a month such as 2026-09" },
    ]);
  }
  return Date.UTC(Number(match[1]), month - 1, 1);
}
