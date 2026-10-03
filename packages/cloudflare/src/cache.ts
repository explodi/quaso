// SPDX-License-Identifier: MIT
/**
 * The Worker's cache (design §5.12, Caching): anonymous `GET` and `HEAD` requests are
 * answered from the Cache API when it has a fresh copy, so bots and visitors rarely wake
 * the container. The server's own `Cache-Control` headers decide:
 *
 * - A response is stored when it is a `200` with `Cache-Control: public` and a `max-age`
 *   (or `s-maxage`) above zero, without `private`, `no-store` or `no-cache`, without
 *   `Set-Cookie`, and with a `Vary` that names only `Authorization`, `Cookie`,
 *   `Accept-Encoding` and `Origin` (the Cache API ignores `Vary`: stored copies are for
 *   anonymous requests, answered uncompressed, and the key holds the `Origin`).
 * - The key is the URL, plus the request's `Origin` when it has one: with `CORS_ORIGINS`,
 *   the server's answer to one origin allows only that origin, and its answer without an
 *   `Origin` allows none. A URL that already has the key's `Origin` parameter bypasses the
 *   cache, so that no request can reach another request's copy.
 * - Within `max-age`, a copy is a **hit**. Within the `stale-while-revalidate` window after
 *   it, the copy is served **stale**, and the Worker fetches a new one in the background
 *   (`waitUntil`). After that, it is a **miss**.
 * - Requests with `Authorization` or a cookie, `Range` requests, and every other method
 *   **bypass** the cache. The `X-Quaso-Cache` header says which of the four happened.
 *
 * Ages are kept simple: the copy is stored with the time it was stored, and the Cache API
 * keeps it for `max-age` plus the stale window. A served copy has the server's original
 * `Date`, `Cache-Control` and `Vary`, an `Age` counted from when the Worker stored it, and
 * the current request's `X-Request-Id` (not the ID of the request that filled the cache).
 * A refresh that fails, or that isn't cacheable any more, leaves the stale copy in place
 * until its window ends.
 */
import type { Logger } from "@quaso/service";
import { conditionalResponse } from "../../server/src/http/conditional.ts";

export type CacheStatus = "hit" | "stale" | "miss" | "bypass";

/** The response header that says what the cache did. */
export const CACHE_STATUS_HEADER = "X-Quaso-Cache";

/** Headers on stored copies, removed before a copy is served. */
const STORED_AT = "X-Quaso-Stored-At";
const ORIGIN_CACHE_CONTROL = "X-Quaso-Origin-Cache-Control";
const ORIGIN_VARY = "X-Quaso-Origin-Vary";

/** The query parameter that carries the request's `Origin` in cache keys. */
export const ORIGIN_KEY_PARAM = "quaso-cache-origin";

/**
 * The request headers a stored copy may vary on: the ones that make a request bypass the
 * cache, the encoding (the Worker asks for uncompressed answers), and `Origin`, in the key.
 */
const VARY_ALLOWED: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "accept-encoding",
  "origin",
]);

export interface EdgeCacheOptions {
  /** A new deployment must not reuse responses from a discarded database timeline. */
  namespace?: string;
  /** The Cache API's cache, such as `caches.default`. */
  cache: Cache;
  /** Sends a request to the server (the container). */
  origin: (request: Request) => Promise<Response>;
  /** Keeps background work alive after the response: `ctx.waitUntil`. */
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  /** The current request's ID, for `X-Request-Id` on copies served from the cache. */
  requestId?: string | null;
  log?: Logger;
}

/** How long a response may be cached, from its `Cache-Control`, in seconds. */
export interface Freshness {
  maxAge: number;
  staleWhileRevalidate: number;
}

/** Parses `Cache-Control` into lower-case directives and their values. */
export function parseCacheControl(value: string | null): Map<string, string | true> {
  const directives = new Map<string, string | true>();
  for (const part of (value ?? "").split(",")) {
    const [name, ...rest] = part.split("=");
    const key = name.trim().toLowerCase();
    if (key === "") continue;
    directives.set(key, rest.length > 0 ? rest.join("=").trim().replace(/^"|"$/g, "") : true);
  }
  return directives;
}

/** The freshness of a response that may be stored, or null when it may not. */
export function cacheableFreshness(response: Response): Freshness | null {
  if (response.status !== 200) return null;
  if (response.headers.has("Set-Cookie")) return null;
  for (const name of (response.headers.get("Vary") ?? "").split(",")) {
    const header = name.trim().toLowerCase();
    if (header !== "" && !VARY_ALLOWED.has(header)) return null;
  }
  return freshness(response.headers.get("Cache-Control"));
}

/** The freshness a `Cache-Control` value allows a shared cache, or null. */
export function freshness(cacheControl: string | null): Freshness | null {
  const directives = parseCacheControl(cacheControl);
  if (!directives.has("public")) return null;
  for (const refused of ["private", "no-store", "no-cache"]) {
    if (directives.has(refused)) return null;
  }
  const maxAge = seconds(directives.get("s-maxage")) ?? seconds(directives.get("max-age"));
  if (maxAge === null || maxAge <= 0) return null;
  return { maxAge, staleWhileRevalidate: seconds(directives.get("stale-while-revalidate")) ?? 0 };
}

function seconds(value: string | true | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  return Number(value);
}

/** Whether a request may be answered from the cache: anonymous GET or HEAD, whole. */
export function mayUseCache(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const headers = request.headers;
  return !headers.has("Authorization") && !headers.has("Cookie") && !headers.has("Range");
}

/**
 * A GET key scoped by deployment and Origin. Requests containing reserved key
 * parameters bypass caching to prevent collisions.
 */
export function cacheKey(request: Request, namespace?: string): Request | null {
  const url = new URL(request.url);
  if (url.searchParams.has(ORIGIN_KEY_PARAM) || url.searchParams.has("__quaso_version"))
    return null;
  if (namespace) url.searchParams.set("__quaso_version", namespace);
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    // Appended to the query as it is, so that the rest of the key stays the URL's own.
    const param = `${ORIGIN_KEY_PARAM}=${encodeURIComponent(origin)}`;
    url.search = url.search === "" ? `?${param}` : `${url.search}&${param}`;
  }
  return new Request(url, { method: "GET" });
}

/** Answers a request from the cache when it can, and from the server otherwise. */
export async function serveWithCache(
  request: Request,
  options: EdgeCacheOptions,
): Promise<Response> {
  const key = mayUseCache(request) ? cacheKey(request, options.namespace) : null;
  if (key === null) {
    return withStatus(await options.origin(request), "bypass");
  }
  const now = options.now ?? Date.now;
  const stored = await options.cache.match(key);
  if (stored) {
    const served = fromStore(stored, request, now(), options.requestId ?? null);
    if (served.status === "stale") {
      options.waitUntil(refresh(key, request, options));
    }
    if (served.response) return served.response;
  }

  const response = await options.origin(request);
  if (request.method === "GET" && cacheableFreshness(response)) {
    options.waitUntil(store(key, response.clone(), options));
  }
  return withStatus(response, "miss");
}

/** A stored copy as a response to `request`, with its status; no response when it expired. */
function fromStore(
  stored: Response,
  request: Request,
  now: number,
  requestId: string | null,
): { status: CacheStatus; response: Response | null } {
  const storedAt = Number(stored.headers.get(STORED_AT));
  const originCacheControl = stored.headers.get(ORIGIN_CACHE_CONTROL);
  const fresh = freshness(originCacheControl);
  if (!Number.isFinite(storedAt) || fresh === null) {
    void stored.body?.cancel();
    return { status: "miss", response: null };
  }
  const age = Math.max(0, Math.floor((now - storedAt) / 1000));
  const status: CacheStatus =
    age < fresh.maxAge ? "hit" : age < fresh.maxAge + fresh.staleWhileRevalidate ? "stale" : "miss";
  if (status === "miss") {
    void stored.body?.cancel();
    return { status, response: null };
  }
  const headers = new Headers(stored.headers);
  headers.delete(STORED_AT);
  headers.delete(ORIGIN_CACHE_CONTROL);
  headers.delete(ORIGIN_VARY);
  headers.set("Cache-Control", originCacheControl!);
  const vary = stored.headers.get(ORIGIN_VARY);
  if (vary) headers.set("Vary", vary);
  else headers.delete("Vary");
  headers.set("Age", String(age));
  headers.set(CACHE_STATUS_HEADER, status);
  if (requestId) headers.set("X-Request-Id", requestId);
  else headers.delete("X-Request-Id");
  if (request.method === "HEAD") void stored.body?.cancel();
  const body = request.method === "HEAD" ? null : stored.body;
  return {
    status,
    response: conditionalResponse(request, new Response(body, { status: stored.status, headers })),
  };
}

/** Stores a copy of a cacheable response, kept by the Cache API through its stale window. */
async function store(key: Request, response: Response, options: EdgeCacheOptions) {
  const fresh = cacheableFreshness(response);
  if (fresh === null) {
    await response.body?.cancel();
    return;
  }
  const now = options.now ?? Date.now;
  const headers = new Headers(response.headers);
  headers.set(STORED_AT, String(now()));
  headers.set(ORIGIN_CACHE_CONTROL, response.headers.get("Cache-Control")!);
  const vary = response.headers.get("Vary");
  if (vary) headers.set(ORIGIN_VARY, vary);
  // The stored copy is for anonymous requests only, and its key holds the Origin, so the
  // Vary names (Authorization, Cookie, Accept-Encoding, Origin) are kept aside, and
  // restored when it is served. Each response carries its own request's ID.
  headers.delete("Vary");
  headers.delete("Age");
  headers.delete(CACHE_STATUS_HEADER);
  headers.delete("X-Request-Id");
  headers.set("Cache-Control", `public, max-age=${fresh.maxAge + fresh.staleWhileRevalidate}`);
  try {
    await options.cache.put(key, new Response(response.body, { status: 200, headers }));
  } catch (error) {
    options.log?.warn("Couldn't store a response in the cache", { url: key.url, error });
  }
}

/**
 * Fetches a new copy of a stale entry, in the background: an anonymous GET of the request's
 * URL, with its `Origin`, which the key holds.
 */
async function refresh(key: Request, request: Request, options: EdgeCacheOptions) {
  try {
    const origin = request.headers.get("Origin");
    const headers: HeadersInit = origin === null ? {} : { Origin: origin };
    const response = await options.origin(new Request(request.url, { method: "GET", headers }));
    if (cacheableFreshness(response)) await store(key, response, options);
    else await response.body?.cancel();
  } catch (error) {
    options.log?.warn("Couldn't refresh a stale cache entry", { url: key.url, error });
  }
}

/** The response, with `X-Quaso-Cache` set (headers of fetched responses can't be changed). */
function withStatus(response: Response, status: CacheStatus): Response {
  // A WebSocket upgrade can't be copied; it passes as it is.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
