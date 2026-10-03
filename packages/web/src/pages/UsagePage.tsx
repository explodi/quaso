// SPDX-License-Identifier: MIT
import { H1, H2 } from "../components/Typography.tsx";
import { Table } from "../components/Controls.tsx";
/** Requests and tokens per UTC day/month, with a table as the chart's text alternative. */
import type { UsageRow, UsageTotals } from "@quaso/core";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Access, SelectField } from "../components/Management.tsx";
import { Loading } from "../components/Spinner.tsx";
import { useQuery } from "../lib/data.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
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
              <td>{value.requests}</td>
              <td>{value.failures}</td>
              <td>{value.inputTokens}</td>
              <td>{value.outputTokens}</td>
              <td>{value.thinkingTokens}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function Usage() {
  useDocumentTitle("Usage");
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
  return (
    <div className="page management-page">
      <div className="page-head">
        <H1>Usage</H1>
      </div>
      <SelectField
        label="Period"
        value={period}
        onChange={(value) => setPeriod(value as typeof period)}
      >
        <option value="day">Last 30 days</option>
        <option value="month">Last 12 months</option>
      </SelectField>
      {query.loading && <Loading label="Loading usage…" />}
      {query.error !== undefined && (
        <ErrorMessage error={query.error} onRetry={() => query.refresh()} />
      )}
      {query.data && (
        <>
          <section className="management-section">
            <H2>Monthly budget</H2>
            <p>
              {query.data.budget.usedThisMonth} tokens used /{" "}
              {query.data.budget.monthlyTokens ?? "no limit"}
              {query.data.budget.paused
                ? " · Translation is paused"
                : " · Translation is available"}
            </p>
          </section>
          <section className="management-section">
            <H2>Requests and tokens by {period}</H2>
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
              <p className="muted">No LLM requests in this period.</p>
            )}
          </section>
          <section className="management-section">
            <H2>Totals by language</H2>
            <UsageTable
              label="Language"
              rows={Object.entries(aggregateUsage(rows, "byLanguage"))}
            />
          </section>
          <section className="management-section">
            <H2>Totals by model</H2>
            <UsageTable label="Model" rows={Object.entries(aggregateUsage(rows, "byModel"))} />
          </section>
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
