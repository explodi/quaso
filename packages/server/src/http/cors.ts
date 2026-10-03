// SPDX-License-Identifier: MIT
/**
 * CORS for a website served from another origin (design §5.12, "Serving the website
 * separately"): only the origins in `CORS_ORIGINS`, with credentials, and only for `/api/`
 * `/auth/` and `/files/`. By default the website is on the same origin and no CORS is needed.
 */
import { mergeVary } from "./headers.ts";

/** The request's origin if CORS allows it, or null. */
export function allowedOrigin(
  request: Request,
  pathname: string,
  origins: string[],
): string | null {
  const origin = request.headers.get("Origin");
  if (!origin || !origins.includes(origin)) return null;
  const allowed =
    pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname.startsWith("/files/");
  return allowed ? origin : null;
}

/** The answer to a preflight request from an allowed origin. */
export function preflightResponse(origin: string): Response {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, If-Match, If-None-Match",
  );
  headers.set("Access-Control-Max-Age", "600");
  setCorsHeaders(headers, origin);
  return new Response(null, { status: 204, headers });
}

/** Lets an allowed origin read the response, with credentials. */
export function setCorsHeaders(headers: Headers, origin: string): void {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Expose-Headers", "X-Request-Id, ETag, Last-Modified");
  headers.set("Vary", mergeVary(headers.get("Vary"), ["Origin"]));
}
