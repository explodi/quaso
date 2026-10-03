// SPDX-License-Identifier: MIT
/** Response helpers. */

export const JSON_TYPE = "application/json; charset=utf-8";

const encoder = new TextEncoder();

/**
 * A JSON response, with `application/json; charset=utf-8` and its length (which tells
 * `compress()` whether it is worth compressing).
 */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const bytes = encoder.encode(JSON.stringify(body));
  const headers = new Headers(init.headers);
  headers.set("Content-Type", JSON_TYPE);
  headers.set("Content-Length", String(bytes.length));
  return new Response(bytes, { ...init, headers });
}

/** A plain text response. */
export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { ...init, headers });
}
