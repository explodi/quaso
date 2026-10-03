// SPDX-License-Identifier: MIT
/**
 * Reading requests: JSON bodies with size limits, query parameters checked against the
 * core request schemas, the request ID and the client's address.
 */
import {
  ArraySchema,
  BooleanSchema,
  formatPath,
  type Issue,
  NullableSchema,
  NumberSchema,
  type ObjectSchema,
  OptionalSchema,
  RefinedSchema,
  type Schema,
  validate,
} from "@quaso/core";
import { ServiceError } from "@quaso/service";

export const MB = 1024 * 1024;

/**
 * Reads a JSON body of at most `limit` bytes: 413 `payload_too_large` above it, 400
 * `bad_request` when it's missing, cut off or isn't JSON.
 */
export async function readJson(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? NaN);
  if (declared > limit) throw tooLarge(limit);
  if (!request.body) throw new ServiceError("bad_request", "The request needs a JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  while (true) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch {
      // The client went away, or the server is stopping: the client's side of the problem.
      throw new ServiceError("bad_request", "The request body didn't arrive in full.");
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(concat(chunks, size));
  } catch {
    throw new ServiceError("bad_request", "The request body isn't valid UTF-8.");
  }
  if (text.trim() === "") throw new ServiceError("bad_request", "The request needs a JSON body.");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ServiceError(
      "bad_request",
      `The request body isn't valid JSON: ${(error as Error).message}`,
    );
  }
}

function tooLarge(limit: number): ServiceError {
  return new ServiceError(
    "payload_too_large",
    `The request body is larger than ${Math.round(limit / MB)} MB.`,
  );
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Checks a value against a schema; 400 `validation_failed` with one detail per problem,
 * `{ path, message }`, otherwise.
 */
export function validateInput<T>(schema: Schema<T>, value: unknown): T {
  const result = validate(schema, value);
  if (result.ok) return result.value;
  throw validationError(result.issues);
}

export function validationError(issues: Issue[]): ServiceError {
  const details = issues.map((issue) => ({
    ...(issue.path.length > 0 ? { path: formatPath(issue.path) } : {}),
    message: issue.message,
  }));
  const first = details[0];
  const summary = first.path ? `${first.path}: ${first.message}` : first.message;
  const more = details.length > 1 ? ` (and ${details.length - 1} more)` : "";
  return new ServiceError("validation_failed", `Invalid request: ${summary}${more}.`, { details });
}

/**
 * Query parameters as the object a schema expects: numbers and booleans converted, lists
 * comma-separated (`languages=de,fr`, or the parameter repeated). Empty values count as
 * missing; unknown parameters are refused.
 */
export function parseQuery<T>(schema: ObjectSchema<any> & Schema<T>, params: URLSearchParams): T {
  const raw: Record<string, unknown> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name).filter((value) => value !== "");
    if (values.length === 0) continue;
    const field: Schema<unknown> | undefined = schema.shape[name];
    raw[name] = field ? fromQuery(field, values) : values[0];
  }
  return validateInput(schema, raw);
}

function fromQuery(schema: Schema<unknown>, values: string[]): unknown {
  const base = unwrap(schema);
  if (base instanceof ArraySchema) {
    return values
      .flatMap((value) => value.split(","))
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => scalar(base.item, item));
  }
  return scalar(base, values[values.length - 1]);
}

function scalar(schema: Schema<unknown>, value: string): unknown {
  const base = unwrap(schema);
  if (base instanceof NumberSchema && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (base instanceof BooleanSchema && (value === "true" || value === "false")) {
    return value === "true";
  }
  return value;
}

/** The schema under `optional()`, `nullable()` and refinements. */
function unwrap(schema: Schema<unknown>): Schema<unknown> {
  let current = schema;
  while (
    current instanceof OptionalSchema ||
    current instanceof NullableSchema ||
    current instanceof RefinedSchema
  ) {
    current = current.inner;
  }
  return current;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

/** The request's ID: the proxy's `X-Request-Id` when we trust the proxy, or a new one. */
export function requestId(request: Request, trustProxy: boolean): string {
  const given = request.headers.get("X-Request-Id");
  if (trustProxy && given && REQUEST_ID.test(given)) return given;
  return crypto.randomUUID();
}

/** What `serveHttp` tells the handler about the connection. */
export interface ConnectionInfo {
  remoteAddr?: { hostname?: string };
}

/**
 * The client's address: the first `X-Forwarded-For` entry when we trust the proxy (it sets
 * the header), or the connection's address.
 */
export function clientIp(
  request: Request,
  info: ConnectionInfo | undefined,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const forwarded = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return info?.remoteAddr?.hostname ?? null;
}
