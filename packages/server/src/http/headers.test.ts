// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
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
  assertEquals(headers.get("Cache-Control"), "public, max-age=30, stale-while-revalidate=300");
  assertEquals(headers.get("Vary"), "Authorization, Cookie");
  assertEquals(cache("/api/v1/project", { method: "HEAD" }).get("Cache-Control"), CACHE.api);
});

test("cache: credentials, writes and errors are private, no-store", () => {
  assertEquals(cache("/api/v1/project", { credentials: true }).get("Cache-Control"), CACHE.none);
  assertEquals(cache("/api/v1/sources", { method: "POST" }).get("Cache-Control"), CACHE.none);
  assertEquals(cache("/api/v1/strings/9", { status: 404 }).get("Cache-Control"), CACHE.none);
  assertEquals(cache("/api/v1/export", { status: 401 }).get("Cache-Control"), CACHE.none);
  assertEquals(CACHE.none, "private, no-store");
  assertEquals(
    cache("/api/v1/project", { headers: { Vary: "Accept-Encoding" } }).get("Vary"),
    "Accept-Encoding, Authorization, Cookie",
  );
});

test("cache: hashed build files for a year, the HTML shell for five minutes", () => {
  assertEquals(
    cache("/assets/index-CMi84CGp.js").get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assertEquals(
    cache("/assets/index-CMi84CGp.js", { credentials: true }).get("Cache-Control"),
    CACHE.immutable,
  );
  assertEquals(cache("/").get("Cache-Control"), "public, max-age=300, stale-while-revalidate=600");
  assertEquals(cache("/strings/5").get("Cache-Control"), CACHE.shell);
  assertEquals(cache("/config.json").get("Cache-Control"), CACHE.shell);
  assertEquals(cache("/assets/missing.js", { status: 404 }).get("Cache-Control"), CACHE.none);
  assertEquals(cache("/healthz").get("Cache-Control"), CACHE.none);
  assertEquals(
    cache("/", { headers: { "Cache-Control": "no-store" } }).get("Cache-Control"),
    "no-store",
  );
  assertEquals(cache("/").get("Vary"), null);
});

test("security headers: on every response, and the CSP on HTML", () => {
  const json = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  setSecurityHeaders(json);
  assertEquals(json.get("X-Content-Type-Options"), "nosniff");
  assertEquals(json.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assertEquals(json.get("X-Frame-Options"), "DENY");
  assertEquals(json.get("Content-Security-Policy"), null);

  const html = new Headers({ "Content-Type": "text/html; charset=UTF-8" });
  setSecurityHeaders(html);
  assertEquals(html.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY);
  assertEquals(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
      "form-action 'self'",
  );
});

test("credentials: an Authorization header or a cookie", () => {
  const url = "http://quaso.test/";
  assertEquals(hasCredentials(new Request(url)), false);
  assertEquals(hasCredentials(new Request(url, { headers: { Authorization: "Bearer x" } })), true);
  assertEquals(hasCredentials(new Request(url, { headers: { Cookie: "a=b" } })), true);
});
