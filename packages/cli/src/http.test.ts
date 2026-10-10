// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { CliError } from "./errors.ts";
import {
  ApiClient,
  apiError,
  backoffMs,
  describeNetworkError,
  exitCodeFor,
  MAX_RETRIES,
  retryAfterMs,
} from "./http.ts";
import { fakeFetch, jsonResponse } from "./test_helpers.ts";
import { USER_AGENT } from "./version.ts";

function client(fetch: import("@quaso/core").Fetch, sleeps: number[] = []) {
  return new ApiClient({
    baseUrl: "https://quaso.test",
    apiKey: "qso_key",
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => Date.parse("2026-09-24T12:00:00Z"),
  });
}

const errorBody = (code: string, message = "No.") => ({ error: { code, message } });

test("requests carry the key, the User-Agent and JSON; queries join lists with commas", async () => {
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const api = client(fetch);
  assertEquals(await api.get("/export", { query: { languages: ["de", "fr"], files: undefined } }), {
    ok: true,
  });
  await api.post("/sources", { files: [] });
  const [get, post] = fetch.requests;
  assertEquals(get.url, "https://quaso.test/api/v1/export?languages=de%2Cfr");
  assertEquals(get.headers.get("Authorization"), "Bearer qso_key");
  assertEquals(get.headers.get("User-Agent"), USER_AGENT);
  assertEquals(get.headers.get("Accept"), "application/json");
  assertEquals(post.method, "POST");
  assertEquals(post.headers.get("Content-Type"), "application/json");
  assertEquals(await post.json(), { files: [] });
});

test("safe requests retry network errors and 502/503/504, with backoff", async () => {
  const sleeps: number[] = [];
  const fetch = fakeFetch((_, index) => {
    if (index === 0) throw new TypeError("fetch failed");
    if (index === 1) return new Response("Bad gateway", { status: 502 });
    if (index === 2) return jsonResponse(errorBody("unavailable"), 503);
    return jsonResponse({ done: true });
  });
  assertEquals(await client(fetch, sleeps).get("/status"), { done: true });
  assertEquals(fetch.requests.length, 4);
  assertEquals(sleeps, [375, 750, 1500]);
});

test("retries stop after MAX_RETRIES; the last error has exit code 4", async () => {
  const fetch = fakeFetch(() => jsonResponse(errorBody("unavailable", "Restarting."), 503));
  const error = await assertRejects(() => client(fetch).get("/status"), CliError);
  assertEquals(fetch.requests.length, MAX_RETRIES + 1);
  assertEquals(error.exitCode, 4);
  assertEquals(error.code, "unavailable");
  assertEquals(error.message, "Restarting.");
});

test("Retry-After is honoured, and too long a wait isn't retried", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetch = fakeFetch(() =>
    calls++ === 0
      ? jsonResponse(errorBody("rate_limited"), 429, { "Retry-After": "2" })
      : jsonResponse({}),
  );
  await client(fetch, sleeps).get("/status");
  assertEquals(sleeps, [2000]);
  const long = fakeFetch(() =>
    jsonResponse(errorBody("rate_limited"), 429, { "Retry-After": "3600" }),
  );
  const error = await assertRejects(() => client(long).get("/status"), CliError);
  assertEquals(long.requests.length, 1);
  assertEquals(error.exitCode, 4);
});

test("writes: idempotent ones retry like reads except timeouts; others only 429 and 503", async () => {
  const gateway = () =>
    fakeFetch((_, index) => (index === 0 ? new Response("", { status: 502 }) : jsonResponse({})));
  const idempotent = gateway();
  await client(idempotent).post("/imports", {}, { retry: "idempotent" });
  assertEquals(idempotent.requests.length, 2);
  const once = gateway();
  await assertRejects(() => client(once).post("/sources", {}), CliError);
  assertEquals(once.requests.length, 1, "a 502 may have come after the write");
  const busy = fakeFetch((_, index) =>
    index === 0 ? jsonResponse(errorBody("unavailable"), 503) : jsonResponse({}),
  );
  await client(busy).post("/sources", {});
  assertEquals(busy.requests.length, 2, "a 503 means the write never started");
  const timeout = fakeFetch(() => {
    throw new DOMException("Signal timed out.", "TimeoutError");
  });
  const error = await assertRejects(
    () => client(timeout).post("/imports", {}, { retry: "idempotent" }),
    CliError,
  );
  assertEquals(timeout.requests.length, 1);
  assertEquals(error.code, "timeout");
  assertEquals(error.exitCode, 4);
});

/** A response whose body breaks off after the headers, as a reset connection does. */
function brokenBody(status = 200): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"revision":'));
      controller.error(new TypeError("error reading a body from connection"));
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

// Regression: a body that broke off after the headers wasn't retried, even for reads.
test("a body that breaks off is retried for reads, not after a write's 2xx", async () => {
  const sleeps: number[] = [];
  const read = fakeFetch((_, index) => (index < 2 ? brokenBody() : jsonResponse({ done: true })));
  assertEquals(await client(read, sleeps).get("/export"), { done: true });
  assertEquals(read.requests.length, 3);
  assertEquals(sleeps.length, 2);

  const always = fakeFetch(() => brokenBody());
  const error = await assertRejects(() => client(always).get("/export"), CliError);
  assertEquals(always.requests.length, MAX_RETRIES + 1);
  assertEquals(error.exitCode, 4);

  const write = fakeFetch(() => brokenBody());
  await assertRejects(() => client(write).post("/imports", {}, { retry: "idempotent" }), CliError);
  assertEquals(write.requests.length, 1, "the write may have happened");

  // An error answer whose body breaks off still has its status: a 503 is retried.
  const busy = fakeFetch((_, index) => (index === 0 ? brokenBody(503) : jsonResponse({})));
  await client(busy).post("/sources", {});
  assertEquals(busy.requests.length, 2);
});

// Regression: a key the runtime refuses in a header was a network error (exit code 4,
// retried), and the message printed the key.
test("a key that can't be a header is exit code 3, never retried or printed", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const api = new ApiClient({ baseUrl: "https://quaso.test", apiKey: "qso_a\nb", fetch });
  const error = await assertRejects(() => api.get("/status"), CliError);
  assertEquals(error.exitCode, 3);
  assertEquals(error.code, "invalid_key");
  assertEquals(fetch.requests.length, 0);
  assertEquals(`${error.message} ${error.hint}`.includes("qso_a"), false);
});

test("client errors aren't retried, and budget_exceeded neither", async () => {
  for (const [status, code] of [
    [400, "bad_request"],
    [401, "unauthorized"],
    [429, "budget_exceeded"],
  ] as const) {
    const fetch = fakeFetch(() => jsonResponse(errorBody(code), status));
    await assertRejects(() => client(fetch).get("/status"), CliError);
    assertEquals(fetch.requests.length, 1, code);
  }
});

test("API errors keep their code and details, with exit codes", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          code: "invalid_source",
          message: "common.json:3:5: Unexpected end of file",
          details: [{ file: "common.json", line: 3, column: 5, message: "Unexpected end of file" }],
        },
      },
      422,
    ),
  );
  const error = await assertRejects(() => client(fetch).post("/sources", {}), CliError);
  assertEquals(error.exitCode, 5);
  assertEquals(error.status, 422);
  assertEquals(error.details, [
    { file: "common.json", line: 3, column: 5, message: "Unexpected end of file" },
  ]);
});

test("exitCodeFor maps the error codes of design §5.10", () => {
  const cases: [string | undefined, number, number][] = [
    ["bad_request", 400, 2],
    ["validation_failed", 400, 2],
    ["unauthorized", 401, 3],
    ["forbidden", 403, 3],
    ["invalid_source", 422, 5],
    ["qa_failed", 422, 6],
    ["rate_limited", 429, 4],
    ["unavailable", 503, 4],
    ["internal", 500, 4],
    ["not_found", 404, 2],
    ["conflict", 409, 1],
    ["payload_too_large", 413, 2],
    [undefined, 502, 4],
    [undefined, 403, 3],
    [undefined, 404, 2],
    [undefined, 405, 2],
    [undefined, 413, 2],
    [undefined, 418, 1],
  ];
  for (const [code, status, exit] of cases) {
    assertEquals(exitCodeFor(code, status), exit, `${code} ${status}`);
  }
});

test("an answer that isn't the error shape says so", () => {
  // Not a Quaso instance: a problem of the settings, exit code 2 (not 1, for bugs).
  const html = apiError(404, "<html>Not found</html>", "GET", "https://x.test/api/v1/status");
  assertEquals(html.exitCode, 2);
  assertEquals(html.code, "http_error");
  assert(html.hint?.includes("QUASO_HOSTNAME"));
  const proxy = apiError(502, "Bad gateway", "GET", "https://x.test/api/v1/status");
  assertEquals(proxy.exitCode, 4);
  const tooLarge = apiError(413, "<html>Too large</html>", "POST", "https://x.test/api/v1/sources");
  assertEquals(tooLarge.exitCode, 2);
  assertEquals(tooLarge.code, "payload_too_large");
  assert(tooLarge.hint?.includes("--file"));
});

test("a success that isn't JSON is an error", async () => {
  const fetch = fakeFetch(
    () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
  );
  const error = await assertRejects(() => client(fetch).get("/status"), CliError);
  assertEquals(error.code, "bad_response");
  assertEquals(error.exitCode, 2, "QUASO_HOSTNAME points at something else");
});

test("redirects are never followed", async () => {
  const fetch = fakeFetch(
    () =>
      new Response(null, {
        status: 308,
        headers: { Location: "https://elsewhere.test/api/v1/status" },
      }),
  );
  const error = await assertRejects(() => client(fetch).get("/status"), CliError);
  assertEquals(fetch.requests[0].redirect, "manual");
  assertEquals(error.code, "redirect");
  assertEquals(error.exitCode, 2);
  assert(error.hint?.includes("https://elsewhere.test"));
});

test("network errors: exit code 4, with the cause as Node and Deno report it", async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    });
  });
  const error = await assertRejects(() => client(fetch).get("/status"), CliError);
  assertEquals(error.exitCode, 4);
  assertEquals(error.message, "Can't reach https://quaso.test: connect ECONNREFUSED 127.0.0.1:1.");
  assertEquals(
    describeNetworkError(
      new TypeError(
        "error sending request for url (http://x/): client error (Connect): Connection refused",
      ),
    ),
    "client error (Connect): Connection refused",
  );
});

test("backoffMs and retryAfterMs", () => {
  assertEquals(
    [0, 1, 2].map((attempt) => backoffMs(attempt, () => 0)),
    [250, 500, 1000],
  );
  assertEquals(
    [0, 1, 2].map((attempt) => backoffMs(attempt, () => 1)),
    [500, 1000, 2000],
  );
  const now = Date.parse("2026-09-24T12:00:00Z");
  assertEquals(retryAfterMs("5", now), 5000);
  assertEquals(retryAfterMs("Thu, 24 Sep 2026 12:00:10 GMT", now), 10_000);
  assertEquals(retryAfterMs("Thu, 24 Sep 2026 11:00:00 GMT", now), 0);
  assertEquals(retryAfterMs("soon", now), null);
  assertEquals(retryAfterMs(null, now), null);
});

/** A client that waits while the instance is asleep, with a clock that moves 2 s per sleep. */
function wakingClient(fetch: import("@quaso/core").Fetch, logs: string[]) {
  let now = Date.parse("2026-10-10T12:00:00Z");
  return new ApiClient({
    baseUrl: "https://quaso.test",
    apiKey: "qso_key",
    fetch,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
    log: (message) => logs.push(message),
    waitWhileAsleep: true,
  });
}

const starting = (elapsedMs: number) =>
  jsonResponse({ state: "starting", elapsedMs, expectedMs: 60_000 });

test("waits while the instance starts, then sends the request", async () => {
  const answers = [starting(10_000), starting(12_000), jsonResponse({ state: "ready" })];
  const fetch = fakeFetch((_request, index) => answers[index] ?? jsonResponse({ ok: true }));
  const logs: string[] = [];
  const api = wakingClient(fetch, logs);
  assertEquals(await api.get("/status"), { ok: true });
  assertEquals(
    fetch.requests.map((request) => request.url),
    [
      "https://quaso.test/wake",
      "https://quaso.test/wake",
      "https://quaso.test/wake",
      "https://quaso.test/api/v1/status",
    ],
  );
  assertEquals(fetch.requests[0].headers.get("Authorization"), null);
  assertEquals(logs, ["Waking up the instance: 10 s of about 60 s."]);
});

test("asks /wake once per client", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake") ? jsonResponse({ state: "ready" }) : jsonResponse({ ok: true }),
  );
  const api = wakingClient(fetch, []);
  await api.get("/status");
  await api.get("/status");
  assertEquals(fetch.requests.length, 3);
});

test("a server without /wake is taken as awake", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake")
      ? new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })
      : jsonResponse({ ok: true }),
  );
  const api = wakingClient(fetch, []);
  assertEquals(await api.get("/status"), { ok: true });
  assertEquals(fetch.requests.length, 2);
});

test("stops waiting for a start after three minutes and sends the request", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake") ? starting(5000) : jsonResponse({ ok: true }),
  );
  const logs: string[] = [];
  const api = wakingClient(fetch, logs);
  assertEquals(await api.get("/status"), { ok: true });
  assertEquals(fetch.requests.length, 91);
  assertEquals(logs.length, 12);
});
