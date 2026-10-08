// SPDX-License-Identifier: MIT
/**
 * Measurements for S3.6 (design §5.12): run against a deployed instance, such as Cloudflare
 * staging, or a VM with Cloudflare storage, and paste the tables into the implementation
 * notes.
 *
 *   deno run -A scripts/measure.ts --url https://staging.translate.yourgame.com \
 *     --key qso_… [--requests 50] [--cold-starts 3 --sleep 660] [--json]
 *
 * - **API response times:** each endpoint `--requests` times, one after the other: the time
 *   to the response's headers and to its last byte, as p50 and p95, and what the Worker's
 *   cache did (`X-Quaso-Cache`). With `--key`, reads carry the API key, so they bypass the
 *   cache and cross every hop (Worker, container, internal API, Durable Object); anonymous
 *   reads show the cache.
 * - **Cold starts** (optional, `--cold-starts N`): waits `--sleep` seconds (longer than
 *   CONTAINER_SLEEP_AFTER, so that the container sleeps), then times `/healthz`, which is
 *   never cached; N times.
 *
 * It only reads (and `/healthz`): it never writes to the instance.
 */

export interface Options {
  url: string;
  key: string | null;
  requests: number;
  coldStarts: number;
  sleepSeconds: number;
  json: boolean;
}

export interface Endpoint {
  label: string;
  path: string;
  /** Sends the API key. */
  auth: boolean;
}

export interface Timing {
  /** Milliseconds to the response's headers. */
  ttfb: number;
  /** Milliseconds to the last byte. */
  total: number;
  status: number;
  cache: string | null;
}

export interface Summary {
  label: string;
  path: string;
  requests: number;
  errors: number;
  ttfbP50: number;
  ttfbP95: number;
  totalP50: number;
  totalP95: number;
  max: number;
  cache: Record<string, number>;
}

/** Reads `--name value` and `--name=value` options. */
export function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unexpected argument: ${args[i]}`);
    if (match[2] !== undefined) values.set(match[1], match[2]);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) values.set(match[1], args[++i]);
    else flags.add(match[1]);
  }
  const url = values.get("url");
  if (!url || !URL.canParse(url)) {
    throw new Error(
      "--url is required: the instance's address, such as https://translate.yourgame.com",
    );
  }
  const number = (name: string, fallback: number, min: number) => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`--${name} must be a whole number from ${min}, not "${value}"`);
    }
    return parsed;
  };
  return {
    url: url.replace(/\/+$/, ""),
    key: values.get("key") ?? null,
    requests: number("requests", 20, 1),
    coldStarts: number("cold-starts", 0, 0),
    sleepSeconds: number("sleep", 660, 0),
    json: flags.has("json"),
  };
}

/** The endpoints to time: anonymous reads, and with a key, reads that cross every hop. */
export function endpoints(key: string | null, language: string | null): Endpoint[] {
  const list: Endpoint[] = [
    { label: "health (never cached)", path: "/healthz", auth: false },
    { label: "project, anonymous (cacheable)", path: "/api/v1/project", auth: false },
  ];
  if (language) {
    list.push({
      label: "strings, anonymous (cacheable)",
      path: `/api/v1/strings?language=${encodeURIComponent(language)}&limit=50`,
      auth: false,
    });
  }
  if (key) {
    list.push(
      { label: "project, with a key", path: "/api/v1/project", auth: true },
      { label: "status, with a key", path: "/api/v1/status", auth: true },
      { label: "export, with a key", path: "/api/v1/export", auth: true },
    );
    if (language) {
      list.push({
        label: "strings, with a key",
        path: `/api/v1/strings?language=${encodeURIComponent(language)}&limit=50`,
        auth: true,
      });
    }
  }
  return list;
}

/** The value below which `p` percent of the sorted values fall (nearest rank). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Sums up an endpoint's timings. */
export function summarize(endpoint: Endpoint, timings: readonly Timing[]): Summary {
  const ok = timings.filter((timing) => timing.status < 400);
  const ttfb = ok.map((timing) => timing.ttfb).sort((a, b) => a - b);
  const total = ok.map((timing) => timing.total).sort((a, b) => a - b);
  const cache: Record<string, number> = {};
  for (const timing of timings) {
    const key = timing.cache ?? "none";
    cache[key] = (cache[key] ?? 0) + 1;
  }
  return {
    label: endpoint.label,
    path: endpoint.path,
    requests: timings.length,
    errors: timings.length - ok.length,
    ttfbP50: percentile(ttfb, 50),
    ttfbP95: percentile(ttfb, 95),
    totalP50: percentile(total, 50),
    totalP95: percentile(total, 95),
    max: total.at(-1) ?? NaN,
    cache,
  };
}

/** A Markdown table of the summaries. */
export function table(summaries: readonly Summary[]): string {
  const ms = (value: number) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "–");
  const rows = summaries.map((s) => [
    s.label,
    String(s.requests),
    String(s.errors),
    ms(s.ttfbP50),
    ms(s.ttfbP95),
    ms(s.totalP50),
    ms(s.totalP95),
    ms(s.max),
    Object.entries(s.cache)
      .map(([name, n]) => `${name} ${n}`)
      .join(", "),
  ]);
  const header = [
    "Endpoint",
    "Requests",
    "Errors",
    "TTFB p50",
    "TTFB p95",
    "Total p50",
    "Total p95",
    "Max",
    "Cache",
  ];
  return [header, header.map(() => "---"), ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

/** Times one request: to the headers, and to the last byte. */
async function timeRequest(url: string, key: string | null): Promise<Timing> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const started = performance.now();
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    const ttfb = performance.now() - started;
    await response.arrayBuffer();
    return {
      ttfb,
      total: performance.now() - started,
      status: response.status,
      cache: response.headers.get("X-Quaso-Cache"),
    };
  } catch (error) {
    console.error(`${url}: ${(error as Error).message}`);
    const elapsed = performance.now() - started;
    return { ttfb: elapsed, total: elapsed, status: 599, cache: null };
  }
}

async function firstLanguage(options: Options): Promise<string | null> {
  try {
    const response = await fetch(`${options.url}/api/v1/project`);
    const project = await response.json();
    return project?.languages?.[0]?.tag ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(
      "Usage: deno run -A scripts/measure.ts --url <address> [--key qso_…] [--requests 20] " +
        "[--cold-starts 0 --sleep 660] [--json]",
    );
    return 2;
  }
  const log = (message: string) => console.error(message);

  const cold: Timing[] = [];
  for (let i = 0; i < options.coldStarts; i++) {
    log(`Cold start ${i + 1}/${options.coldStarts}: waiting ${options.sleepSeconds} s…`);
    await new Promise((done) => setTimeout(done, options.sleepSeconds * 1000));
    const timing = await timeRequest(`${options.url}/healthz`, null);
    log(`  /healthz answered ${timing.status} after ${Math.round(timing.total)} ms`);
    cold.push(timing);
  }

  const language = await firstLanguage(options);
  const summaries: Summary[] = [];
  for (const endpoint of endpoints(options.key, language)) {
    log(`${endpoint.label}: ${options.requests} requests to ${endpoint.path}`);
    const timings: Timing[] = [];
    for (let i = 0; i < options.requests; i++) {
      timings.push(
        await timeRequest(`${options.url}${endpoint.path}`, endpoint.auth ? options.key : null),
      );
    }
    summaries.push(summarize(endpoint, timings));
  }

  const coldSummary =
    cold.length > 0
      ? summarize(
          { label: "cold start (/healthz after sleeping)", path: "/healthz", auth: false },
          cold,
        )
      : null;
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          url: options.url,
          at: new Date().toISOString(),
          coldStart: coldSummary,
          endpoints: summaries,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Measured ${options.url} on ${new Date().toISOString()}\n`);
    console.log(table(coldSummary ? [coldSummary, ...summaries] : summaries));
  }
  return (coldSummary?.errors ?? 0) > 0 || summaries.some((summary) => summary.errors > 0) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
