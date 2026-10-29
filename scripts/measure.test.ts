// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SYSTEM } from "@quaso/service";
import { createApp } from "../packages/server/src/app.ts";
import { serve } from "../packages/server/src/http/serve.ts";
import { memoryLogger, testConfig } from "../packages/server/src/testing/helpers.ts";
import { realService } from "../packages/server/src/testing/real_service.ts";
import { endpoints, parseOptions, percentile, summarize, table } from "./measure.ts";

/** Runs measure.ts in its own process; asynchronous, so this process's server answers it. */
function runMeasure(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = fileURLToPath(new URL("./measure.ts", import.meta.url));
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], (error, stdout, stderr) => {
      done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("measure: options", () => {
  expect(parseOptions(["--url", "https://q.example/", "--key=qso_x", "--json"])).toStrictEqual({
    url: "https://q.example",
    key: "qso_x",
    requests: 20,
    coldStarts: 0,
    sleepSeconds: 660,
    json: true,
  });
  const cold = parseOptions(["--url=https://q.example", "--cold-starts", "3", "--sleep", "30"]);
  expect([cold.coldStarts, cold.sleepSeconds]).toStrictEqual([3, 30]);
  expect(() => parseOptions([])).toThrow("--url is required");
  expect(() => parseOptions(["--url", "x"])).toThrow("--url is required");
  expect(() => parseOptions(["--url", "https://q", "--requests", "0"])).toThrow("--requests");
});

test("measure: percentiles, summaries and the table", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  expect([percentile(sorted, 50), percentile(sorted, 95), percentile([7], 95)]).toStrictEqual([
    50, 100, 7,
  ]);
  assert(Number.isNaN(percentile([], 50)));
  const summary = summarize({ label: "x", path: "/x", auth: false }, [
    { ttfb: 5, total: 9, status: 200, cache: "hit" },
    { ttfb: 50, total: 90, status: 200, cache: "miss" },
    { ttfb: 1, total: 1, status: 503, cache: null },
  ]);
  expect(summary.errors).toBe(1);
  expect([summary.ttfbP50, summary.totalP95, summary.max]).toStrictEqual([5, 90, 90]);
  expect(summary.cache).toStrictEqual({ hit: 1, miss: 1, none: 1 });
  const text = table([summary]);
  expect(text).toContain("| Endpoint | Requests |");
  expect(text).toContain(
    "| x | 3 | 1 | 5 ms | 50 ms | 9 ms | 90 ms | 90 ms | hit 1, miss 1, none 1 |",
  );
  expect(endpoints(null, null).map((e) => e.path)).toStrictEqual(["/healthz", "/api/v1/project"]);
  assert(endpoints("qso_x", "pl").some((e) => e.auth && e.path.startsWith("/api/v1/strings")));
});

test("measure: runs against a server", async () => {
  const real = await realService();
  const key = await real.service.createApiToken(SYSTEM, { name: "Measure", scope: "read" });
  const app = createApp({ config: testConfig(), service: real.service, log: memoryLogger() });
  const server = await serve({ hostname: "127.0.0.1", port: 0 }, app);
  try {
    const { code, stdout, stderr } = await runMeasure([
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--key",
      key.secret,
      "--requests",
      "3",
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("| health (never cached) | 3 | 0 |");
    expect(stdout).toContain("| export, with a key | 3 | 0 |");
  } finally {
    await server.shutdown();
    real.close();
  }
});

test("measure: a failed cold start fails the run even when warm requests succeed", async () => {
  let healthRequests = 0;
  const server = await serve({ hostname: "127.0.0.1", port: 0 }, (request) => {
    if (new URL(request.url).pathname === "/healthz" && healthRequests++ === 0) {
      return new Response("Starting", { status: 503 });
    }
    return Response.json({ languages: [] });
  });
  try {
    const result = await runMeasure([
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--cold-starts",
      "1",
      "--sleep",
      "0",
      "--requests",
      "1",
      "--json",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.coldStart.errors).toBe(1);
    assert(report.endpoints.every((endpoint: { errors: number }) => endpoint.errors === 0));
  } finally {
    await server.shutdown();
  }
});
