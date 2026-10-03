// SPDX-License-Identifier: MIT
import { serveHttp } from "@quaso/runtime/http";
import { test } from "node:test";
import { Command } from "@quaso/runtime/command";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@quaso/runtime/assert";
import { SYSTEM } from "@quaso/service";
import { createApp } from "../packages/server/src/app.ts";
import { memoryLogger, testConfig } from "../packages/server/src/testing/helpers.ts";
import { realService } from "../packages/server/src/testing/real_service.ts";
import { endpoints, parseOptions, percentile, summarize, table } from "./measure.ts";

test("measure: options", () => {
  assertEquals(parseOptions(["--url", "https://q.example/", "--key=qso_x", "--json"]), {
    url: "https://q.example",
    key: "qso_x",
    requests: 20,
    coldStarts: 0,
    sleepSeconds: 660,
    json: true,
  });
  const cold = parseOptions(["--url=https://q.example", "--cold-starts", "3", "--sleep", "30"]);
  assertEquals([cold.coldStarts, cold.sleepSeconds], [3, 30]);
  assertThrows(() => parseOptions([]), Error, "--url is required");
  assertThrows(() => parseOptions(["--url", "x"]), Error, "--url is required");
  assertThrows(() => parseOptions(["--url", "https://q", "--requests", "0"]), Error, "--requests");
});

test("measure: percentiles, summaries and the table", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assertEquals([percentile(sorted, 50), percentile(sorted, 95), percentile([7], 95)], [50, 100, 7]);
  assert(Number.isNaN(percentile([], 50)));
  const summary = summarize({ label: "x", path: "/x", auth: false }, [
    { ttfb: 5, total: 9, status: 200, cache: "hit" },
    { ttfb: 50, total: 90, status: 200, cache: "miss" },
    { ttfb: 1, total: 1, status: 503, cache: null },
  ]);
  assertEquals(summary.errors, 1);
  assertEquals([summary.ttfbP50, summary.totalP95, summary.max], [5, 90, 90]);
  assertEquals(summary.cache, { hit: 1, miss: 1, none: 1 });
  const text = table([summary]);
  assertStringIncludes(text, "| Endpoint | Requests |");
  assertStringIncludes(
    text,
    "| x | 3 | 1 | 5 ms | 50 ms | 9 ms | 90 ms | 90 ms | hit 1, miss 1, none 1 |",
  );
  assertEquals(
    endpoints(null, null).map((e) => e.path),
    ["/healthz", "/api/v1/project"],
  );
  assert(endpoints("qso_x", "pl").some((e) => e.auth && e.path.startsWith("/api/v1/strings")));
});

test("measure: runs against a server", async () => {
  const real = await realService();
  const key = await real.service.createApiToken(SYSTEM, { name: "Measure", scope: "read" });
  const app = createApp({ config: testConfig(), service: real.service, log: memoryLogger() });
  const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, app);
  try {
    const { code, stdout, stderr } = await new Command(process.execPath, {
      args: [
        "run",

        new URL("./measure.ts", import.meta.url).pathname,
        "--url",
        `http://127.0.0.1:${server.addr.port}`,
        "--key",
        key.secret,
        "--requests",
        "3",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(stdout);
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assertStringIncludes(out, "| health (never cached) | 3 | 0 |");
    assertStringIncludes(out, "| export, with a key | 3 | 0 |");
  } finally {
    await server.shutdown();
    real.close();
  }
});

test("measure: a failed cold start fails the run even when warm requests succeed", async () => {
  let healthRequests = 0;
  const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    if (new URL(request.url).pathname === "/healthz" && healthRequests++ === 0) {
      return new Response("Starting", { status: 503 });
    }
    return Response.json({ languages: [] });
  });
  try {
    const result = await new Command(process.execPath, {
      args: [
        "run",

        new URL("./measure.ts", import.meta.url).pathname,
        "--url",
        `http://127.0.0.1:${server.addr.port}`,
        "--cold-starts",
        "1",
        "--sleep",
        "0",
        "--requests",
        "1",
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 1);
    const report = JSON.parse(new TextDecoder().decode(result.stdout));
    assertEquals(report.coldStart.errors, 1);
    assert(report.endpoints.every((endpoint: { errors: number }) => endpoint.errors === 0));
  } finally {
    await server.shutdown();
  }
});
