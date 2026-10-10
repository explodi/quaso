// SPDX-License-Identifier: MIT
import { H1, H2, Table, Loading, Label, Progress, EmptyState } from "@quaso/design-system";
import { ButtonLink } from "../components/Button.tsx";

/** Requests and tokens per UTC day/month, with a table as the chart's text alternative. */
import type { UsageRow, UsageTotals } from "@quaso/core";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Access, SelectField } from "../components/Management.tsx";
import { useQuery } from "../lib/data.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { formatNumber } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import { getUsage } from "../lib/management-api.ts";

const tokens = (row: UsageTotals) => row.inputTokens + row.outputTokens + row.thinkingTokens;

export function aggregateUsage(
  rows: UsageRow[],
  key: "byLanguage" | "byModel",
): Record<string, UsageTotals> {
  const result: Record<string, UsageTotals> = Object.create(null);
  for (const row of rows) {
    for (const [name, totals] of Object.entries(row[key])) {
      const sum = (result[name] ??= {
        requests: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      });
      for (const field of Object.keys(sum) as (keyof UsageTotals)[]) sum[field] += totals[field];
    }
  }
  return result;
}

function UsageTable({ rows, label }: { rows: [string, UsageTotals][]; label: string }) {
  return (
    <div className="table-scroll">
      <Table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">Requests</th>
            <th scope="col">Failures</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Thinking tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{formatNumber(value.requests)}</td>
              <td>{formatNumber(value.failures)}</td>
              <td>{formatNumber(value.inputTokens)}</td>
              <td>{formatNumber(value.outputTokens)}</td>
              <td>{formatNumber(value.thinkingTokens)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function Usage() {
  useDocumentTitle("Usage");
  const session = useSession();
  const [period, setPeriod] = useState<"day" | "month">("day");
  const now = new Date();
  const from = new Date(now);
  if (period === "day") from.setUTCDate(now.getUTCDate() - 29);
  else {
    from.setUTCDate(1);
    from.setUTCMonth(now.getUTCMonth() - 11);
  }
  const first = from.toISOString().slice(0, period === "day" ? 10 : 7);
  const last = now.toISOString().slice(0, period === "day" ? 10 : 7);
  const query = useQuery(["usage", period, first, last], (options) =>
    getUsage({ period, from: first, to: last }, options),
  );
  const rows = query.data?.rows ?? [];
  const max = Math.max(1, ...rows.map(tokens));
  const totals = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      failures: sum.failures + row.failures,
      tokens: sum.tokens + tokens(row),
    }),
    { requests: 0, failures: 0, tokens: 0 },
  );
  return (
    <div className="page management-page usage-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui>Usage</H1>
          <p className="muted">
            Understand translation activity and keep your token budget in view.
          </p>
        </div>
        <SelectField
          label="Period"
          value={period}
          onChange={(value) => setPeriod(value as typeof period)}
        >
          <option value="day">Last 30 days</option>
          <option value="month">Last 12 months</option>
        </SelectField>
      </div>
      {query.loading && <Loading label="Loading usage…" />}
      {query.error !== undefined && (
        <ErrorMessage error={query.error} onRetry={() => query.refresh()} />
      )}
      {query.data && (
        <>
          <dl className="workspace-metrics">
            <div>
              <dt>Total tokens</dt>
              <dd>{formatNumber(totals.tokens)}</dd>
            </div>
            <div>
              <dt>Requests</dt>
              <dd>{formatNumber(totals.requests)}</dd>
            </div>
            <div>
              <dt>Failed requests</dt>
              <dd>{formatNumber(totals.failures)}</dd>
            </div>
          </dl>
          <section className="management-section usage-budget">
            <div className="record-head">
              <H2 ui>Monthly budget</H2>
              <span className="status">
                {query.data.budget.paused ? "Translation paused" : "Translation available"}
              </span>
            </div>
            <p>
              <strong>{formatNumber(query.data.budget.usedThisMonth)}</strong> tokens used this
              month
              {query.data.budget.monthlyTokens === null
                ? " · No limit set"
                : ` of ${formatNumber(query.data.budget.monthlyTokens)}`}
            </p>
            {query.data.budget.monthlyTokens !== null && (
              <Label className="job-progress-label">
                <span className="sr-only">Monthly token budget used</span>
                <Progress
                  value={Math.min(query.data.budget.usedThisMonth, query.data.budget.monthlyTokens)}
                  max={query.data.budget.monthlyTokens}
                />
              </Label>
            )}
            {session.can("settings") && (
              <ButtonLink to="/settings?section=llm">Manage budget</ButtonLink>
            )}
          </section>
          <section className="management-section">
            <H2 ui>Requests and tokens by {period}</H2>
            {rows.length ? (
              <>
                <svg
                  className="usage-chart"
                  viewBox="0 0 600 180"
                  role="img"
                  aria-label={`Total tokens by ${period}. Exact requests and token counts are in the following table.`}
                >
                  <title>Total tokens by {period}</title>
                  {rows.map((row, index) => (
                    <g key={row.period}>
                      <rect
                        x={(index * 600) / rows.length + 2}
                        y={160 - (150 * tokens(row)) / max}
                        width={Math.max(1, 600 / rows.length - 4)}
                        height={(150 * tokens(row)) / max}
                        fill="var(--primary)"
                      >
                        <title>
                          {row.period}: {tokens(row)} tokens; {row.requests} requests
                        </title>
                      </rect>
                    </g>
                  ))}
                  <text x="0" y="176" fill="var(--fg)" fontSize="11">
                    {rows[0]?.period}
                  </text>
                  <text x="600" y="176" textAnchor="end" fill="var(--fg)" fontSize="11">
                    {rows.at(-1)?.period}
                  </text>
                </svg>
                <UsageTable label="Period" rows={rows.map((row) => [row.period, row])} />
              </>
            ) : (
              <EmptyState title="No AI translation activity">
                <p>
                  No LLM requests in this period. Try another period or start a translation job.
                </p>
                <ButtonLink to="/jobs">View jobs</ButtonLink>
              </EmptyState>
            )}
          </section>
          {rows.length > 0 && (
            <div className="usage-breakdowns">
              <section className="management-section">
                <H2 ui>Totals by language</H2>
                <UsageTable
                  label="Language"
                  rows={Object.entries(aggregateUsage(rows, "byLanguage"))}
                />
              </section>
              <section className="management-section">
                <H2 ui>Totals by model</H2>
                <UsageTable label="Model" rows={Object.entries(aggregateUsage(rows, "byModel"))} />
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
export function UsagePage() {
  return (
    <Access action="usage">
      <Usage />
    </Access>
  );
}
