// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(
    await api.get("/export", { query: { languages: ["de", "fr"], files: undefined } }),
  ).toStrictEqual({
    ok: true,
  });
  await api.post("/sources", { files: [] });
  const [get, post] = fetch.requests;
  expect(get.url).toBe("https://quaso.test/api/v1/export?languages=de%2Cfr");
  expect(get.headers.get("Authorization")).toBe("Bearer qso_key");
  expect(get.headers.get("User-Agent")).toStrictEqual(USER_AGENT);
  expect(get.headers.get("Accept")).toBe("application/json");
  expect(post.method).toBe("POST");
  expect(post.headers.get("Content-Type")).toBe("application/json");
  expect(await post.json()).toStrictEqual({ files: [] });
});

test("safe requests retry network errors and 502/503/504, with backoff", async () => {
  const sleeps: number[] = [];
  const fetch = fakeFetch((_, index) => {
    if (index === 0) throw new TypeError("fetch failed");
    if (index === 1) return new Response("Bad gateway", { status: 502 });
    if (index === 2) return jsonResponse(errorBody("unavailable"), 503);
    return jsonResponse({ done: true });
  });
  expect(await client(fetch, sleeps).get("/status")).toStrictEqual({ done: true });
  expect(fetch.requests.length).toBe(4);
  expect(sleeps).toStrictEqual([375, 750, 1500]);
});

test("retries stop after MAX_RETRIES; the last error has exit code 4", async () => {
  const fetch = fakeFetch(() => jsonResponse(errorBody("unavailable", "Restarting."), 503));
  const error = await client(fetch)
    .get("/status")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(fetch.requests.length).toStrictEqual(MAX_RETRIES + 1);
  expect(error.exitCode).toBe(4);
  expect(error.code).toBe("unavailable");
  expect(error.message).toBe("Restarting.");
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
  expect(sleeps).toStrictEqual([2000]);
  const long = fakeFetch(() =>
    jsonResponse(errorBody("rate_limited"), 429, { "Retry-After": "3600" }),
  );
  const error = await client(long)
    .get("/status")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(long.requests.length).toBe(1);
  expect(error.exitCode).toBe(4);
});

test("writes: idempotent ones retry like reads except timeouts; others only 429 and 503", async () => {
  const gateway = () =>
    fakeFetch((_, index) => (index === 0 ? new Response("", { status: 502 }) : jsonResponse({})));
  const idempotent = gateway();
  await client(idempotent).post("/imports", {}, { retry: "idempotent" });
  expect(idempotent.requests.length).toBe(2);
  const once = gateway();
  await expect(client(once).post("/sources", {})).rejects.toThrow(CliError);
  expect(once.requests.length, "a 502 may have come after the write").toBe(1);
  const busy = fakeFetch((_, index) =>
    index === 0 ? jsonResponse(errorBody("unavailable"), 503) : jsonResponse({}),
  );
  await client(busy).post("/sources", {});
  expect(busy.requests.length, "a 503 means the write never started").toBe(2);
  const timeout = fakeFetch(() => {
    throw new DOMException("Signal timed out.", "TimeoutError");
  });
  const error = await client(timeout)
    .post("/imports", {}, { retry: "idempotent" })
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(timeout.requests.length).toBe(1);
  expect(error.code).toBe("timeout");
  expect(error.exitCode).toBe(4);
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
  expect(await client(read, sleeps).get("/export")).toStrictEqual({ done: true });
  expect(read.requests.length).toBe(3);
  expect(sleeps.length).toBe(2);

  const always = fakeFetch(() => brokenBody());
  const error = await client(always)
    .get("/export")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(always.requests.length).toStrictEqual(MAX_RETRIES + 1);
  expect(error.exitCode).toBe(4);

  const write = fakeFetch(() => brokenBody());
  await expect(client(write).post("/imports", {}, { retry: "idempotent" })).rejects.toThrow(
    CliError,
  );
  expect(write.requests.length, "the write may have happened").toBe(1);

  // An error answer whose body breaks off still has its status: a 503 is retried.
  const busy = fakeFetch((_, index) => (index === 0 ? brokenBody(503) : jsonResponse({})));
  await client(busy).post("/sources", {});
  expect(busy.requests.length).toBe(2);
});

// Regression: a key the runtime refuses in a header was a network error (exit code 4,
// retried), and the message printed the key.
test("a key that can't be a header is exit code 3, never retried or printed", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const api = new ApiClient({ baseUrl: "https://quaso.test", apiKey: "qso_a\nb", fetch });
  const error = await api.get("/status").catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(3);
  expect(error.code).toBe("invalid_key");
  expect(fetch.requests.length).toBe(0);
  expect(`${error.message} ${error.hint}`.includes("qso_a")).toBe(false);
});

test("client errors aren't retried, and budget_exceeded neither", async () => {
  for (const [status, code] of [
    [400, "bad_request"],
    [401, "unauthorized"],
    [429, "budget_exceeded"],
  ] as const) {
    const fetch = fakeFetch(() => jsonResponse(errorBody(code), status));
    await expect(client(fetch).get("/status")).rejects.toThrow(CliError);
    expect(fetch.requests.length, code).toBe(1);
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
  const error = await client(fetch)
    .post("/sources", {})
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(5);
  expect(error.status).toBe(422);
  expect(error.details).toStrictEqual([
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
    expect(exitCodeFor(code, status), `${code} ${status}`).toStrictEqual(exit);
  }
});

test("an answer that isn't the error shape says so", () => {
  // Not a Quaso instance: a problem of the settings, exit code 2 (not 1, for bugs).
  const html = apiError(404, "<html>Not found</html>", "GET", "https://x.test/api/v1/status");
  expect(html.exitCode).toBe(2);
  expect(html.code).toBe("http_error");
  assert(html.hint?.includes("QUASO_HOSTNAME"));
  const proxy = apiError(502, "Bad gateway", "GET", "https://x.test/api/v1/status");
  expect(proxy.exitCode).toBe(4);
  const tooLarge = apiError(413, "<html>Too large</html>", "POST", "https://x.test/api/v1/sources");
  expect(tooLarge.exitCode).toBe(2);
  expect(tooLarge.code).toBe("payload_too_large");
  assert(tooLarge.hint?.includes("--file"));
});

test("a success that isn't JSON is an error", async () => {
  const fetch = fakeFetch(
    () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
  );
  const error = await client(fetch)
    .get("/status")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(error.code).toBe("bad_response");
  expect(error.exitCode, "QUASO_HOSTNAME points at something else").toBe(2);
});

test("redirects are never followed", async () => {
  const fetch = fakeFetch(
    () =>
      new Response(null, {
        status: 308,
        headers: { Location: "https://elsewhere.test/api/v1/status" },
      }),
  );
  const error = await client(fetch)
    .get("/status")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(fetch.requests[0].redirect).toBe("manual");
  expect(error.code).toBe("redirect");
  expect(error.exitCode).toBe(2);
  assert(error.hint?.includes("https://elsewhere.test"));
});

test("network errors: exit code 4, with the cause as Node and Deno report it", async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    });
  });
  const error = await client(fetch)
    .get("/status")
    .catch((error: unknown) => error);
  assert(error instanceof CliError);
  expect(error.exitCode).toBe(4);
  expect(error.message).toStrictEqual(
    "Can't reach https://quaso.test: connect ECONNREFUSED 127.0.0.1:1.",
  );
  expect(
    describeNetworkError(
      new TypeError(
        "error sending request for url (http://x/): client error (Connect): Connection refused",
      ),
    ),
  ).toBe("client error (Connect): Connection refused");
});

test("backoffMs and retryAfterMs", () => {
  expect([0, 1, 2].map((attempt) => backoffMs(attempt, () => 0))).toStrictEqual([250, 500, 1000]);
  expect([0, 1, 2].map((attempt) => backoffMs(attempt, () => 1))).toStrictEqual([500, 1000, 2000]);
  const now = Date.parse("2026-09-24T12:00:00Z");
  expect(retryAfterMs("5", now)).toBe(5000);
  expect(retryAfterMs("Thu, 24 Sep 2026 12:00:10 GMT", now)).toBe(10_000);
  expect(retryAfterMs("Thu, 24 Sep 2026 11:00:00 GMT", now)).toBe(0);
  expect(retryAfterMs("soon", now)).toBe(null);
  expect(retryAfterMs(null, now)).toBe(null);
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
  expect(await api.get("/status")).toStrictEqual({ ok: true });
  expect(fetch.requests.map((request) => request.url)).toStrictEqual([
    "https://quaso.test/wake",
    "https://quaso.test/wake",
    "https://quaso.test/wake",
    "https://quaso.test/api/v1/status",
  ]);
  expect(fetch.requests[0].headers.get("Authorization")).toBe(null);
  expect(logs).toStrictEqual(["Waking up the instance: 10 s of about 60 s."]);
});

test("asks /wake once per client", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake") ? jsonResponse({ state: "ready" }) : jsonResponse({ ok: true }),
  );
  const api = wakingClient(fetch, []);
  await api.get("/status");
  await api.get("/status");
  expect(fetch.requests.length).toBe(3);
});

test("a server without /wake is taken as awake", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake")
      ? new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })
      : jsonResponse({ ok: true }),
  );
  const api = wakingClient(fetch, []);
  expect(await api.get("/status")).toStrictEqual({ ok: true });
  expect(fetch.requests.length).toBe(2);
});

test("stops waiting for a start after three minutes and sends the request", async () => {
  const fetch = fakeFetch((request) =>
    request.url.endsWith("/wake") ? starting(5000) : jsonResponse({ ok: true }),
  );
  const logs: string[] = [];
  const api = wakingClient(fetch, logs);
  expect(await api.get("/status")).toStrictEqual({ ok: true });
  expect(fetch.requests.length).toBe(91);
  expect(logs.length).toBe(12);
});
