// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The HTTP client (design §5.11, S4.3): JSON over `fetch`, with the API key, a User-Agent,
 * timeouts, and retries with exponential backoff and jitter. The API's errors become
 * `CliError`s with the design's exit codes.
 */
import { API_BASE, type ApiErrorBody, type ErrorDetail } from "@quaso/core";
import { CliError, EXIT, type ExitCode, type Problem } from "./errors.ts";
import { USER_AGENT } from "./version.ts";

/** The default timeout. */
export const TIMEOUT_MS = 30_000;
/** The timeout of uploads, exports and imports, which carry every file. */
export const LONG_TIMEOUT_MS = 5 * 60_000;
/** Retries after the first attempt. */
export const MAX_RETRIES = 3;
/** The first retry's delay, doubled at every retry, with jitter. */
export const BASE_DELAY_MS = 500;
/** The longest `Retry-After` the CLI waits for. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * When a request may be sent again:
 * - `safe`: reads and dry runs, which change nothing: after network errors, timeouts,
 *   429, 502, 503 and 504.
 * - `idempotent`: writes that give the same result when repeated (an upload without renames,
 *   an import): the same, except timeouts, when the first request may still be running.
 * - `once`: other writes: only after 429 and 503, when the server refused to start them.
 */
export type RetryPolicy = "safe" | "idempotent" | "once";

export interface ClientOptions {
  /** The instance, such as `https://translate.yourgame.com`, without a trailing slash. */
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Where retries are reported (stderr). */
  log?: (message: string) => void;
}

export interface RequestOptions {
  query?: Record<string, string | readonly string[] | undefined>;
  body?: unknown;
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  get<T>(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, { retry: "safe", ...options });
  }

  post<T>(path: string, body: unknown, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("POST", path, { retry: "once", ...options, body });
  }

  /** The URL of an API path, such as `/status`, with its query. */
  url(path: string, query: RequestOptions["query"] = {}): string {
    const url = new URL(`${this.baseUrl}${API_BASE}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (typeof value === "string") url.searchParams.set(name, value);
      else if (value.length > 0) url.searchParams.set(name, value.join(","));
    }
    return url.toString();
  }

  async request<T>(method: "GET" | "POST", path: string, options: RequestOptions): Promise<T> {
    const url = this.url(path, options.query);
    const policy = options.retry ?? (method === "GET" ? "safe" : "once");
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const headers = requestHeaders(this.#apiKey, options.body !== undefined);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let text: string;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body,
          // Never follow a redirect: it would send the key elsewhere, or lose it.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          throw redirectError(response, url);
        }
        // The body is read inside the retry: a connection can break after the headers.
        text = await readBody(response);
      } catch (error) {
        if (error instanceof CliError) throw error;
        const failure = networkError(error, method, url, timeoutMs);
        // After a 2xx, a write may have happened: like a timeout, only reads retry it.
        const unsure = failure.code === "timeout" || response?.ok === true;
        const retryable = policy === "safe" || (policy === "idempotent" && !unsure);
        if (retryable && attempt < MAX_RETRIES) {
          const delay = backoffMs(attempt, this.#random);
          this.#log(retrying(failure, delay, attempt));
          await this.#sleep(delay);
          continue;
        }
        throw failure;
      }
      if (response.ok) return parseSuccess<T>(text, response, method, url);
      const failure = apiError(response.status, text, method, url);
      if (attempt < MAX_RETRIES && shouldRetry(policy, response.status, failure.code)) {
        const after = retryAfterMs(response.headers.get("Retry-After"), this.#now());
        if (after === null || after <= MAX_RETRY_AFTER_MS) {
          const delay = after ?? backoffMs(attempt, this.#random);
          this.#log(retrying(failure, delay, attempt));
          await this.#sleep(delay);
          continue;
        }
      }
      throw failure;
    }
  }
}

/**
 * The request's headers, built once and before any request, so that a header the runtime
 * refuses is never mistaken for a network error. The message never includes the key.
 */
function requestHeaders(apiKey: string, json: boolean): Headers {
  try {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
    });
    if (json) headers.set("Content-Type", "application/json");
    return headers;
  } catch {
    throw invalidKeyError();
  }
}

/** QUASO_API_KEY with characters no API key has (a quote, a line break), never echoed. */
export function invalidKeyError(): CliError {
  return new CliError(EXIT.auth, "QUASO_API_KEY contains characters an API key can't have.", {
    code: "invalid_key",
    hint:
      "Copy the key again: an API key is one word of letters, digits, _ and -, " +
      "without quotes or spaces.",
  });
}

/**
 * A response's body as text. The body of an error answer that breaks off is read as
 * empty: its status says enough.
 */
async function readBody(response: Response): Promise<string> {
  if (response.ok) return await response.text();
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function shouldRetry(policy: RetryPolicy, status: number, code: string): boolean {
  if (code === "budget_exceeded" || code === "llm_unavailable") return false;
  if (status === 429 || status === 503) return true;
  return policy !== "once" && (status === 502 || status === 504);
}

/**
 * The delay before retry number `attempt + 1`: `BASE_DELAY_MS × 2^attempt`, of which the
 * second half is random ("equal jitter"), so that many clients don't retry together.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const delay = BASE_DELAY_MS * 2 ** attempt;
  return Math.round(delay / 2 + random() * (delay / 2));
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date. Null when absent or invalid. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function retrying(failure: CliError, delay: number, attempt: number): string {
  const seconds = (delay / 1000).toFixed(1);
  return `${failure.message} Retrying in ${seconds} s (attempt ${attempt + 2} of ${
    MAX_RETRIES + 1
  }).`;
}

/**
 * The exit code for an API error (design §5.10): 2 for bad requests (including what the
 * instance doesn't have, and requests too large for it), 3 for authentication and
 * permissions, 4 when the server is unavailable (5xx, rate limits: safe to retry), 5 for
 * invalid source files, 6 for values the checks refused, 1 for anything else.
 */
export function exitCodeFor(code: string | undefined, status: number): ExitCode {
  switch (code) {
    case "bad_request":
    case "validation_failed":
    case "not_found":
    case "payload_too_large":
      return EXIT.usage;
    case "unauthorized":
    case "forbidden":
    case "setup_required":
      return EXIT.auth;
    case "invalid_source":
      return EXIT.invalidSource;
    case "qa_failed":
      return EXIT.refused;
    case "rate_limited":
    case "unavailable":
    case "llm_unavailable":
    case "budget_exceeded":
      return EXIT.network;
  }
  if (status >= 500) return EXIT.network;
  if (status === 401 || status === 403) return EXIT.auth;
  // Not a Quaso instance at that address (404, 405), or a proxy's size limit (413).
  if (status === 400 || status === 404 || status === 405 || status === 413) return EXIT.usage;
  return EXIT.unexpected;
}

/** Hints for errors people can fix. */
function hintFor(code: string, status: number): string | undefined {
  switch (code) {
    case "unauthorized":
      return "Check QUASO_API_KEY: the key may be wrong or revoked.";
    case "forbidden":
      return "The API key may lack the scope: upload and import need the upload scope.";
    case "rate_limited":
    case "unavailable":
      return "The server is busy or restarting. Try again in a moment.";
    case "payload_too_large":
      return "Send fewer files at a time with --file.";
    case "llm_unavailable":
      return "The instance has no LLM: its operator sets GEMINI_API_KEY.";
    case "budget_exceeded":
      return (
        "LLM translation resumes next month, or when the instance's operator raises " +
        "LLM_MONTHLY_TOKEN_BUDGET."
      );
  }
  return status >= 500
    ? "Try again in a moment; if it persists, tell the instance's operator."
    : undefined;
}

/** An API error response as a `CliError`, with the error shape's code and details. */
export function apiError(status: number, text: string, method: string, url: string): CliError {
  const body = parseErrorBody(text);
  if (body === null) {
    const code =
      status === 429
        ? "rate_limited"
        : status === 413
          ? "payload_too_large"
          : status >= 500
            ? "unavailable"
            : "http_error";
    return new CliError(
      exitCodeFor(code, status),
      `The server answered ${status} to ${method} ${url}.`,
      {
        code,
        status,
        hint:
          status === 404 || status === 405
            ? "Is QUASO_HOSTNAME a Quaso instance? It didn't answer like one."
            : hintFor(code, status),
      },
    );
  }
  const { code, message, details } = body.error;
  return new CliError(exitCodeFor(code, status), message, {
    code,
    status,
    details: (details ?? []).map(problemFromDetail),
    hint: hintFor(code, status),
  });
}

function parseErrorBody(text: string): ApiErrorBody | null {
  try {
    const body = JSON.parse(text);
    if (
      typeof body === "object" &&
      body !== null &&
      typeof body.error === "object" &&
      body.error !== null &&
      typeof body.error.code === "string" &&
      typeof body.error.message === "string"
    ) {
      return body as ApiErrorBody;
    }
  } catch {
    // Not JSON: a proxy's error page, or not a Quaso instance.
  }
  return null;
}

/** An API error detail as a problem; the server's file path stays until a command maps it. */
export function problemFromDetail(detail: ErrorDetail): Problem {
  const problem: Problem = { message: detail.message ?? detail.check ?? "" };
  if (detail.file !== undefined) problem.file = detail.file;
  if (detail.key !== undefined) problem.key = detail.key;
  else if (detail.path !== undefined) problem.key = detail.path;
  if (detail.language !== undefined) problem.language = detail.language;
  if (detail.line !== undefined) problem.line = detail.line;
  if (detail.column !== undefined) problem.column = detail.column;
  if (detail.check !== undefined) problem.check = detail.check;
  return problem;
}

function networkError(error: unknown, method: string, url: string, timeoutMs: number): CliError {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new CliError(
      EXIT.network,
      `${method} ${url} timed out after ${Math.round(timeoutMs / 1000)} s.`,
      { code: "timeout" },
    );
  }
  return new CliError(
    EXIT.network,
    `Can't reach ${new URL(url).origin}: ${describeNetworkError(error)}.`,
    {
      code: "network",
      hint: "Check QUASO_HOSTNAME and the network. It is safe to try again.",
    },
  );
}

/**
 * A network error's cause, as Node (`fetch failed`, caused by `connect ECONNREFUSED …`) and
 * Deno (`error sending request for url (…): … Connection refused`) report it.
 */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    const { message, code } = current as { message?: string; code?: string };
    const text = (message || code || "").replace(/^error sending request for url \([^)]*\): /, "");
    if (text !== "" && text !== "fetch failed" && !parts.some((part) => part.includes(text))) {
      parts.push(text);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(": ") : "network error";
}

function redirectError(response: Response, url: string): CliError {
  const location = response.headers.get("Location");
  const target = location ? new URL(location, url) : null;
  return new CliError(
    EXIT.usage,
    `The server redirected ${url} to ${target?.toString() ?? "another address"}.`,
    {
      code: "redirect",
      status: response.status,
      hint: target
        ? `Set QUASO_HOSTNAME to ${target.origin}; the CLI doesn't follow redirects, ` +
          "so the API key only goes where you point it."
        : undefined,
    },
  );
}

function parseSuccess<T>(text: string, response: Response, method: string, url: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = response.headers.get("Content-Type") ?? "no content type";
    throw new CliError(
      EXIT.usage,
      `The server's answer to ${method} ${url} isn't JSON (${type}).`,
      {
        code: "bad_response",
        status: response.status,
        hint: "Is QUASO_HOSTNAME a Quaso instance? It didn't answer like one.",
      },
    );
  }
}
