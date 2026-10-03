// SPDX-License-Identifier: MIT
/**
 * Headers on every response: security headers (design §8), and cache headers that let a
 * cache in front of the server answer most anonymous traffic (design §5.12, Caching).
 */

/** For HTML: user content is only ever text, and scripts only come from our own files. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const CACHE = {
  /** Build files with content hashes in their names. */
  immutable: "public, max-age=31536000, immutable",
  /** The website's HTML shell and other files that change with a release. */
  shell: "public, max-age=300, stale-while-revalidate=600",
  /** Anonymous API reads. */
  api: "public, max-age=30, stale-while-revalidate=300",
  /** Anything with credentials, every write, and errors. */
  none: "private, no-store",
} as const;

/** Cloudflare Turnstile's scripts and frames, for the optional human check (S6.6). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export interface SecurityOptions {
  /** `PUBLIC_URL` is https: browsers should keep to https (`Strict-Transport-Security`). */
  hsts?: boolean;
  /** The human check (Turnstile) is on: the policy allows its script and frame. */
  turnstile?: boolean;
}

/** The Content Security Policy, with Turnstile's origin when the human check is on. */
export function contentSecurityPolicy(turnstile = false): string {
  if (!turnstile) return CONTENT_SECURITY_POLICY;
  return (
    CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`) +
    `; frame-src ${TURNSTILE_ORIGIN}`
  );
}

/** Adds the security headers. */
export function setSecurityHeaders(headers: Headers, options: SecurityOptions = {}): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  if (options.hsts) headers.set("Strict-Transport-Security", "max-age=31536000");
  if (headers.get("Content-Type")?.startsWith("text/html")) {
    headers.set("Content-Security-Policy", contentSecurityPolicy(options.turnstile));
  }
}

export interface CacheInput {
  method: string;
  pathname: string;
  status: number;
  /** The request carries an API key or a cookie. */
  credentials: boolean;
}

/**
 * Sets `Cache-Control` (and `Vary` for the API):
 * - the API: anonymous successful reads are public for 30 seconds; anything with
 *   credentials, every write and every error are `private, no-store`;
 * - hashed build files under `/assets/`: a year, immutable;
 * - `/healthz`: never cached;
 * - the rest (the HTML shell, `/config.json`, the schema): a few minutes, unless the
 *   response already says otherwise.
 */
export function setCacheHeaders(headers: Headers, input: CacheInput): void {
  const { method, pathname, status } = input;
  const read = method === "GET" || method === "HEAD";
  const ok = (status >= 200 && status < 300) || status === 304;
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/files/")
  ) {
    // A response that sets a cookie (a sign-in) is never shared.
    const shared = read && ok && !input.credentials && !headers.has("Set-Cookie");
    headers.set("Cache-Control", shared ? CACHE.api : CACHE.none);
    headers.set("Vary", mergeVary(headers.get("Vary"), ["Authorization", "Cookie"]));
  } else if (!read || !ok || pathname === "/healthz") {
    headers.set("Cache-Control", CACHE.none);
  } else if (headers.has("Cache-Control")) {
    // The handler knows best, such as the placeholder page.
  } else if (pathname.startsWith("/assets/")) {
    headers.set("Cache-Control", CACHE.immutable);
  } else {
    headers.set("Cache-Control", CACHE.shell);
  }
}

/** Whether a request carries credentials: an `Authorization` header or a cookie. */
export function hasCredentials(request: Request): boolean {
  return request.headers.has("Authorization") || request.headers.has("Cookie");
}

/** Adds header names to a `Vary` value, once each. */
export function mergeVary(current: string | null, add: string[]): string {
  const names = (current ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of add) {
    if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.join(", ");
}
