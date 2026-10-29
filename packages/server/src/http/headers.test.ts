// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import {
  CACHE,
  CONTENT_SECURITY_POLICY,
  hasCredentials,
  setCacheHeaders,
  setSecurityHeaders,
} from "./headers.ts";

function cache(
  pathname: string,
  options: { method?: string; status?: number; credentials?: boolean; headers?: HeadersInit } = {},
): Headers {
  const headers = new Headers(options.headers);
  setCacheHeaders(headers, {
    method: options.method ?? "GET",
    pathname,
    status: options.status ?? 200,
    credentials: options.credentials ?? false,
  });
  return headers;
}

test("cache: anonymous API reads are public for 30 seconds, and vary on credentials", () => {
  const headers = cache("/api/v1/project");
  expect(headers.get("Cache-Control")).toStrictEqual(
    "public, max-age=30, stale-while-revalidate=300",
  );
  expect(headers.get("Vary")).toBe("Authorization, Cookie");
  expect(cache("/api/v1/project", { method: "HEAD" }).get("Cache-Control")).toStrictEqual(
    CACHE.api,
  );
});

test("cache: credentials, writes and errors are private, no-store", () => {
  expect(cache("/api/v1/project", { credentials: true }).get("Cache-Control")).toStrictEqual(
    CACHE.none,
  );
  expect(cache("/api/v1/sources", { method: "POST" }).get("Cache-Control")).toStrictEqual(
    CACHE.none,
  );
  expect(cache("/api/v1/strings/9", { status: 404 }).get("Cache-Control")).toStrictEqual(
    CACHE.none,
  );
  expect(cache("/api/v1/export", { status: 401 }).get("Cache-Control")).toStrictEqual(CACHE.none);
  expect(CACHE.none).toBe("private, no-store");
  expect(cache("/api/v1/project", { headers: { Vary: "Accept-Encoding" } }).get("Vary")).toBe(
    "Accept-Encoding, Authorization, Cookie",
  );
});

test("cache: hashed build files for a year, the HTML shell for five minutes", () => {
  expect(cache("/assets/index-CMi84CGp.js").get("Cache-Control")).toStrictEqual(
    "public, max-age=31536000, immutable",
  );
  expect(
    cache("/assets/index-CMi84CGp.js", { credentials: true }).get("Cache-Control"),
  ).toStrictEqual(CACHE.immutable);
  expect(cache("/").get("Cache-Control")).toStrictEqual(
    "public, max-age=300, stale-while-revalidate=600",
  );
  expect(cache("/strings/5").get("Cache-Control")).toStrictEqual(CACHE.shell);
  expect(cache("/config.json").get("Cache-Control")).toStrictEqual(CACHE.shell);
  expect(cache("/assets/missing.js", { status: 404 }).get("Cache-Control")).toStrictEqual(
    CACHE.none,
  );
  expect(cache("/healthz").get("Cache-Control")).toStrictEqual(CACHE.none);
  expect(cache("/", { headers: { "Cache-Control": "no-store" } }).get("Cache-Control")).toBe(
    "no-store",
  );
  expect(cache("/").get("Vary")).toBe(null);
});

test("security headers: on every response, and the CSP on HTML", () => {
  const json = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  setSecurityHeaders(json);
  expect(json.get("X-Content-Type-Options")).toBe("nosniff");
  expect(json.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(json.get("X-Frame-Options")).toBe("DENY");
  expect(json.get("Content-Security-Policy")).toBe(null);

  const html = new Headers({ "Content-Type": "text/html; charset=UTF-8" });
  setSecurityHeaders(html);
  expect(html.get("Content-Security-Policy")).toStrictEqual(CONTENT_SECURITY_POLICY);
  expect(CONTENT_SECURITY_POLICY).toStrictEqual(
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
      "form-action 'self'",
  );
});

test("credentials: an Authorization header or a cookie", () => {
  const url = "http://quaso.test/";
  expect(hasCredentials(new Request(url))).toBe(false);
  expect(hasCredentials(new Request(url, { headers: { Authorization: "Bearer x" } }))).toBe(true);
  expect(hasCredentials(new Request(url, { headers: { Cookie: "a=b" } }))).toBe(true);
});
