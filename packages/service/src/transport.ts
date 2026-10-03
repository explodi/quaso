// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The internal service API (design §5.11): the service over HTTP, for Cloudflare storage.
 * The server calls `createHttpServiceClient`, which implements `ServiceApi` by POSTing
 * `{ actor, input }` to `<SERVICES_URL>/v1/<method>`; the Durable Object answers with
 * `handleServiceRequest`, which calls the real service. One interface describes both the
 * direct call and the HTTP call, so the server doesn't know which one it has.
 *
 * - **Authentication:** `Authorization: Bearer <SERVICE_TOKEN>`, compared in constant time.
 *   The internal API is off unless `SERVICE_TOKEN` is set (design §8).
 * - **Versions:** the path carries the protocol version. Each release accepts its own and the
 *   previous one, because a Cloudflare deploy briefly runs a new Worker with old containers
 *   (design §5.12, Rollouts). The client always sends `SERVICE_API_VERSION`.
 * - **Errors:** a `ServiceError` crosses unchanged (code, message, details, current), marked
 *   with the `X-Quaso-Service-Error` header. Errors of the transport itself (a wrong token,
 *   an unknown method or version, the network) become a `ServiceTransportError`: a 503 for
 *   the people using the website, with the details in the server's log.
 * - **Retries:** only for `SAFE_METHODS` (reads), and only after a network error or a 502,
 *   503 or 504: three attempts, with exponential backoff and jitter.
 */
import { type ApiErrorBody, ERROR_CODES, sha256Hex } from "@quaso/core";
import { ACCOUNTS_METHODS, ACCOUNTS_SAFE_METHODS } from "./accounts_api.ts";
import { LATER_METHODS, LATER_SAFE_METHODS } from "./later_api.ts";
import { LLM_METHODS, LLM_SAFE_METHODS } from "./jobs/llm_service.ts";
import type { Actor, ServiceApi, ServiceMethod } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { type Logger, silentLogger } from "./ports.ts";

/** The version of the internal API this release speaks. */
export const SERVICE_API_VERSION = 1;

/**
 * The versions this release accepts: its own and the previous one. When a release changes
 * the protocol, it raises `SERVICE_API_VERSION` and keeps the previous number here, with
 * whatever translation the old requests need.
 */
export const ACCEPTED_SERVICE_API_VERSIONS: readonly number[] = [1];

/**
 * Every method that crosses the internal API: all of `ServiceApi` (a type test checks the
 * list against it). A method that must never be called over HTTP would be left out here.
 */
export const SERVICE_METHODS = [
  "getProject",
  "listFiles",
  "listStrings",
  "getStringsQueue",
  "getString",
  "getHistory",
  "getActivity",
  "getStatus",
  "upload",
  "exportFiles",
  "getFileVersions",
  "getFileVersion",
  "getPublishedFile",
  "importTranslations",
  "authenticateToken",
  "listApiTokens",
  "createApiToken",
  "revokeApiToken",
  "getHealth",
  "getSettings",
  "testLlm",
  "testEmail",
  "emailStatus",
  "sendEmail",
  "listSecrets",
  "setSecret",
  "removeSecret",
  "updateSettings",
  "addLanguage",
  "updateLanguage",
  "removeLanguage",
  "updateFile",
  "updateString",
  "renameKey",
  "backupInfo",
  "backupTables",
  "beginRestore",
  "restoreRows",
  "finishRestore",
  "recordBackup",
  "checkRestoreToken",
  "getAdminInfo",
  ...ACCOUNTS_METHODS,
  ...LLM_METHODS,
  ...LATER_METHODS,
] as const satisfies readonly ServiceMethod[];

/**
 * The methods that are safe to try again: they only read. (`authenticateToken` records when
 * a key was last used, which is safe to repeat.) Later sprints add their read methods here.
 */
export const SAFE_METHODS = [
  "getProject",
  "listFiles",
  "listStrings",
  "getStringsQueue",
  "getString",
  "getHistory",
  "getActivity",
  "getStatus",
  "exportFiles",
  "getFileVersions",
  "getFileVersion",
  "getPublishedFile",
  "listApiTokens",
  "getHealth",
  "authenticateToken",
  "getSettings",
  "testLlm",
  "emailStatus",
  "listSecrets",
  "backupInfo",
  "backupTables",
  "checkRestoreToken",
  "getAdminInfo",
  ...ACCOUNTS_SAFE_METHODS,
  ...LLM_SAFE_METHODS,
  ...LATER_SAFE_METHODS,
] as const satisfies readonly ServiceMethod[];

/** The header on every request the client sends. */
export const INTERNAL_HEADER = "X-Quaso-Internal";

/** The header that marks an error the service itself raised (as opposed to the transport). */
export const SERVICE_ERROR_HEADER = "X-Quaso-Service-Error";

/** The largest request body the internal API reads by default: above the 50 MB uploads. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

const METHODS: ReadonlySet<string> = new Set(SERVICE_METHODS);
const SAFE: ReadonlySet<string> = new Set(SAFE_METHODS);
const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** `…/v<version>/<method>`, at the end of the path, whatever comes before it. */
const PATH = /\/v(\d{1,4})\/([A-Za-z]{1,64})\/?$/;

/** Why the transport failed, for the logs and for the server's start-up check. */
export type TransportFailure =
  /** The request didn't get an answer: DNS, TLS, a reset connection, a timeout. */
  | "network"
  /** A 502, 503 or 504 from something in between, such as Cloudflare. */
  | "gateway"
  /** The token was refused: SERVICE_TOKEN differs between the server and the Worker. */
  | "unauthorized"
  /** 404: the internal API is off, or doesn't know this version or method. */
  | "not_found"
  /** Any other answer that isn't the service's. */
  | "bad_response";

/**
 * The internal API couldn't be reached, or refused the call itself. People see a 503; the
 * `detail` goes to the log.
 */
export class ServiceTransportError extends ServiceError {
  readonly failure: TransportFailure;
  /** The HTTP status, when there was an answer. */
  readonly httpStatus: number | null;
  readonly detail: string;

  constructor(failure: TransportFailure, detail: string, httpStatus: number | null = null) {
    super("unavailable", "The service isn't available right now. Try again in a moment.");
    this.name = "ServiceTransportError";
    this.failure = failure;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export interface HttpServiceClientOptions {
  /** The internal API's address (`SERVICES_URL`), such as `https://translate.yourgame.com/internal`. */
  url: string;
  /** `SERVICE_TOKEN`. */
  token: string;
  /** Default: the global `fetch`. Tests pass one that calls `handleServiceRequest`. */
  fetch?: Fetch;
  /**
   * How many times a safe method is tried again after a network error or a 502, 503 or
   * 504. Default: 2 (three attempts). Other methods are never tried again.
   */
  retries?: number;
  /** The wait before the first retry, doubled before each next one, with jitter. Default: 200 ms. */
  retryDelayMs?: number;
  /** How long one attempt may take. Default: 2 minutes (a large upload). */
  timeoutMs?: number;
  /** Transport problems are logged here. */
  logger?: Logger;
  /** Tests replace the wait and the jitter. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type Outcome = { ok: true; result: unknown } | { ok: false; error: ServiceError; retry: boolean };

/** The service over HTTP: every `ServiceApi` method becomes a POST to the internal API. */
export function createHttpServiceClient(options: HttpServiceClientOptions): ServiceApi {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const retryDelay = options.retryDelayMs ?? 200;
  const timeout = options.timeoutMs ?? 120_000;
  const logger = options.logger ?? silentLogger;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const random = options.random ?? Math.random;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    [INTERNAL_HEADER]: "1",
  };

  async function attempt(method: ServiceMethod, url: string, body: string): Promise<Outcome> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { ok: false, error: new ServiceTransportError("network", detail), retry: true };
    }
    return await readResponse(method, response);
  }

  async function call(method: ServiceMethod, actor: Actor, input: unknown): Promise<unknown> {
    const url = `${base}/v${SERVICE_API_VERSION}/${method}`;
    const body = JSON.stringify({ actor, input: input ?? {} });
    const attempts = SAFE.has(method) ? retries + 1 : 1;
    for (let n = 1; ; n++) {
      const outcome = await attempt(method, url, body);
      if (outcome.ok) return outcome.result;
      const { error } = outcome;
      if (error instanceof ServiceTransportError) {
        const fields = {
          method,
          url,
          attempt: n,
          failure: error.failure,
          status: error.httpStatus ?? undefined,
          detail: error.detail,
        };
        const again = outcome.retry && n < attempts;
        if (again) logger.warn("The internal service API failed; trying again", fields);
        else logger.error("The internal service API failed", fields);
        if (again) {
          // Exponential backoff with jitter: between half and all of the doubled wait.
          const wait = retryDelay * 2 ** (n - 1);
          await sleep(wait / 2 + (random() * wait) / 2);
          continue;
        }
      }
      throw error;
    }
  }

  const client: Partial<Record<ServiceMethod, (actor: Actor, input: unknown) => Promise<unknown>>> =
    {};
  for (const method of SERVICE_METHODS) {
    client[method] = (actor, input) => call(method, actor, input);
  }
  return client as unknown as ServiceApi;
}

/** Turns an answer into a result, a `ServiceError`, or a transport failure. */
async function readResponse(method: ServiceMethod, response: Response): Promise<Outcome> {
  const text = await response.text().catch(() => null);
  const body = text === null ? undefined : parseJson(text);
  if (response.status === 200 && isObject(body) && "result" in body) {
    return { ok: true, result: body.result };
  }
  if (response.headers.get(SERVICE_ERROR_HEADER) === "1" && isErrorBody(body)) {
    return { ok: false, error: ServiceError.fromBody(body), retry: false };
  }
  const status = response.status;
  const said = isErrorBody(body) ? `${body.error.code}: ${body.error.message}` : `HTTP ${status}`;
  if (text === null) {
    const error = new ServiceTransportError("network", `${method}: the answer broke off`, status);
    return { ok: false, error, retry: true };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { ok: false, error: new ServiceTransportError("gateway", said, status), retry: true };
  }
  const failure: TransportFailure =
    status === 401 ? "unauthorized" : status === 404 ? "not_found" : "bad_response";
  const hint =
    failure === "unauthorized"
      ? " (SERVICE_TOKEN must be the same on the server and the Worker)"
      : failure === "not_found"
        ? " (is SERVICE_TOKEN set on the Worker, and does it run a compatible release?)"
        : "";
  return {
    ok: false,
    error: new ServiceTransportError(failure, `${method}: ${said}${hint}`, status),
    retry: false,
  };
}

export interface ServiceRequestOptions {
  /** `SERVICE_TOKEN`. When it is empty or missing, the internal API is off: every request is a 404. */
  token: string | null | undefined;
  /** Unexpected errors from the service are logged here. */
  logger?: Logger;
  /** The largest request body, in bytes. Default: `DEFAULT_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
}

/**
 * Answers one request to the internal API: checks the token (in constant time), the
 * method, the version and the method name, and the body's shape; then calls the service
 * and answers `{ result }`, or the error's body with its status. The service validates the
 * actor and the input itself, as it does for direct calls.
 */
export async function handleServiceRequest(
  request: Request,
  service: ServiceApi,
  options: ServiceRequestOptions,
): Promise<Response> {
  const token = options.token ?? "";
  if (token === "") {
    return transportError(
      404,
      "not_found",
      "The internal service API is off. Set SERVICE_TOKEN to turn it on.",
    );
  }
  if (!timingSafeEqual(bearerToken(request) ?? "", token)) {
    return transportError(401, "unauthorized", "The service token is missing or wrong.", {
      "WWW-Authenticate": 'Bearer realm="quaso-internal"',
    });
  }
  if (request.method !== "POST") {
    return transportError(405, "bad_request", "The internal service API only takes POST.", {
      Allow: "POST",
    });
  }
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) {
    return transportError(404, "not_found", "Call the internal service API at …/v1/<method>.");
  }
  const version = Number(match[1]);
  if (!ACCEPTED_SERVICE_API_VERSIONS.includes(version)) {
    const accepted = ACCEPTED_SERVICE_API_VERSIONS.map((v) => `v${v}`).join(", ");
    return transportError(
      404,
      "not_found",
      `This release doesn't speak v${version} of the internal service API, only ${accepted}.`,
    );
  }
  const method = match[2];
  if (!METHODS.has(method)) {
    return transportError(404, "not_found", `The service has no method ${method}.`);
  }

  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const text = await readText(request, limit);
  if (text === null) {
    return transportError(
      413,
      "payload_too_large",
      `The request body is larger than ${limit} bytes.`,
    );
  }
  const body = parseJson(text);
  if (!isObject(body) || !isObject(body.actor)) {
    return transportError(400, "bad_request", "The body must be JSON: { actor, input }.");
  }
  if (body.input !== undefined && !isObject(body.input)) {
    return transportError(400, "bad_request", "The input must be a JSON object.");
  }

  const call = service[method as ServiceMethod] as (
    actor: Actor,
    input: unknown,
  ) => Promise<unknown>;
  try {
    const result = await call.call(service, body.actor as Actor, body.input ?? {});
    return jsonResponse(200, { result: result ?? null });
  } catch (error) {
    if (error instanceof ServiceError) {
      return jsonResponse(error.status, error.toBody(), { [SERVICE_ERROR_HEADER]: "1" });
    }
    (options.logger ?? silentLogger).error("The service failed", { method, error });
    const internal = new ServiceError("internal", "Something went wrong in the service.");
    return jsonResponse(internal.status, internal.toBody(), { [SERVICE_ERROR_HEADER]: "1" });
  }
}

/**
 * Compares two secrets in constant time: their SHA-256 digests, byte by byte, without
 * stopping at the first difference. The time depends on neither where they differ nor
 * the stored secret's length.
 */
export function timingSafeEqual(given: string, expected: string): boolean {
  const a = sha256Hex(given);
  const b = sha256Hex(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The token of `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/** An error of the transport itself: the API's error shape, without the service's mark. */
function transportError(
  status: number,
  code: ApiErrorBody["error"]["code"],
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

/** The body as text, or null when it is longer than `limit` bytes. */
async function readText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? NaN);
  if (declared > limit) {
    await request.body?.cancel();
    return null;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (!isObject(value) || !isObject(value.error)) return false;
  const { code, message } = value.error;
  return typeof code === "string" && KNOWN_CODES.has(code) && typeof message === "string";
}
