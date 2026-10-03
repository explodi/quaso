// SPDX-License-Identifier: MIT
/**
 * Errors as HTTP responses, in the API's one shape (design §5.11):
 * `{ "error": { "code", "message", "details" } }`.
 */
import type { ApiErrorBody, ErrorCode, ErrorDetail } from "@quaso/core";
import { type Logger, ServiceError } from "@quaso/service";
import { json } from "./response.ts";

/** A response with the API's error shape. */
export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extra: { details?: ErrorDetail[]; headers?: HeadersInit } = {},
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  if (extra.details && extra.details.length > 0) body.error.details = extra.details;
  return json(body, { status, headers: extra.headers });
}

export function notFoundResponse(path: string): Response {
  return errorResponse(404, "not_found", `There is nothing at ${path}.`);
}

export function methodNotAllowedResponse(method: string, path: string, allowed: string[]) {
  return errorResponse(
    405,
    "bad_request",
    `${method} is not allowed on ${path}. Allowed: ${allowed.join(", ")}.`,
    { headers: { Allow: allowed.join(", ") } },
  );
}

/**
 * The response for an error thrown while handling a request: a `ServiceError` becomes its
 * status and body; anything else is a 500 with the request ID, and is logged.
 */
export function toErrorResponse(
  error: unknown,
  context: { requestId: string; log: Logger; method: string; path: string },
): Response {
  if (error instanceof ServiceError) {
    const response = json(error.toBody(), { status: error.status });
    // A rate limit (`rate_limited`) says when to try again.
    const wait = (error as { retryAfter?: unknown }).retryAfter;
    if (typeof wait === "number") response.headers.set("Retry-After", String(wait));
    return response;
  }
  context.log.error("Request failed", {
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    error,
  });
  return errorResponse(
    500,
    "internal",
    `Something went wrong on the server. The request ID is ${context.requestId}.`,
  );
}
