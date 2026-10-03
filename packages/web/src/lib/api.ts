// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { queryCache } from "./data.ts";
import type { JobsResult } from "@quaso/core";
import type { StringsQueue, StringsQueueQuery } from "@quaso/core";
/**
 * A typed client for the HTTP API (design §5.11), over `fetch`: one function per endpoint,
 * with the request and response types of the contract in `@quaso/core`. The website only
 * uses the public API, so anything it does can also be scripted.
 *
 * Errors come back as `ApiError`, from the API's one error shape
 * `{ error: { code, message, details, current } }`; a network failure is an `ApiError` with
 * status 0 and the code `unavailable`.
 */
import type {
  ActivityResult,
  ApiErrorBody,
  CreateJobRequest,
  CreateJobResult,
  EmailRequest,
  ErrorCode,
  ErrorDetail,
  LanguageFilesResult,
  SourceFilesResult,
  HistoryResult,
  InviteCheck,
  ProjectInfo,
  ResetPasswordRequest,
  ReviewRequest,
  ReviewResult,
  SaveTranslationRequest,
  SessionInfo,
  SetupRequest,
  SignInRequest,
  SignUpRequest,
  StringDetail,
  StringsPage,
  StringsQuery,
  SuggestRequest,
  TokenRequest,
  TranslationActionRequest,
  TranslationInfo,
} from "@quaso/core";
import { DEFAULT_CONFIG } from "./config.ts";

export class ApiError extends Error {
  override readonly name = "ApiError";
  /** The HTTP status; 0 when the server couldn't be reached. */
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];
  /** For a conflict on a translation: the current translation (null when there is none). */
  readonly current: TranslationInfo | null | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { details?: ErrorDetail[]; current?: TranslationInfo | null } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = extra.details ?? [];
    this.current = extra.current;
  }

  /**
   * The server has no such endpoint: an older server, before the sprint that adds it. The
   * website then explains that the feature isn't available instead of failing.
   */
  get missingEndpoint(): boolean {
    return (
      this.status === 404 &&
      this.code === "not_found" &&
      this.message.startsWith("There is nothing at ")
    );
  }
}

/** A sentence for people about an error, whatever it is. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Something went wrong in the website. Reload the page and try again.";
  }
  if (error.missingEndpoint) return "This server doesn't support this yet.";
  switch (error.code) {
    case "unauthorized":
      return "You need to sign in to do that.";
    case "forbidden":
      return "You don't have permission to do that.";
    case "rate_limited":
      return "Too many attempts. Wait a minute, then try again.";
    case "llm_unavailable":
      return "LLM translation is off: this server has no LLM provider.";
    default:
      return error.message;
  }
}

/** Whether a value is an `ApiError` with one of the codes. */
export function isApiError(error: unknown, ...codes: ErrorCode[]): error is ApiError {
  return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
}

type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Revalidate with the server instead of taking the browser's cached answer: for reads the
   * website knows have changed. The server lets anonymous reads be cached for a while.
   */
  fresh?: boolean;
}

/** Options of the public reads. */
export interface ReadOptions {
  fresh?: boolean;
  signal?: AbortSignal;
}

/** Where requests go; `configureApi` sets it from `/config.json`. */
const settings = {
  apiBase: DEFAULT_CONFIG.apiBase,
  fetch: (...args: Parameters<Fetch>) => fetch(...args),
  onUnauthorized: undefined as ((path: string) => void) | undefined,
};

/**
 * Sets the API's address, the `fetch` to use (tests pass their own), and what to do when a
 * request answers 401 (the session has expired, say: the session module fetches it again).
 */
export function configureApi(options: {
  apiBase?: string;
  fetch?: Fetch;
  onUnauthorized?: ((path: string) => void) | null;
}): void {
  if (options.apiBase !== undefined) settings.apiBase = options.apiBase;
  if (options.fetch !== undefined) settings.fetch = options.fetch;
  if (options.onUnauthorized !== undefined) {
    settings.onUnauthorized = options.onUnauthorized ?? undefined;
  }
}

/** A query string from values: arrays are joined with commas, empty values left out. */
export function toQueryString(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(name, value.join(","));
    } else {
      params.set(name, String(value));
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The full address of an API path, such as `/strings/5`. */
export function apiUrl(path: string, query?: Record<string, QueryValue>): string {
  return `${settings.apiBase}${path}${toQueryString(query)}`;
}

/**
 * Where the browser goes for sign-in redirects (`/auth/github`, `/auth/dev-login`): on the
 * API's origin, which is this one unless `/config.json` points elsewhere.
 */
export function browserAuthUrl(path: string, next?: string): string {
  let origin = "";
  if (/^https?:\/\//.test(settings.apiBase)) origin = new URL(settings.apiBase).origin;
  return `${origin}${path}${toQueryString({ next })}`;
}

function sameOrigin(): boolean {
  if (!/^https?:\/\//.test(settings.apiBase)) return true;
  return typeof location !== "undefined" && new URL(settings.apiBase).origin === location.origin;
}

/** Sends a request to the API and returns its JSON, or throws an `ApiError`. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await settings.fetch(apiUrl(path, options.query), {
      method,
      headers,
      body,
      signal: options.signal,
      // Cookies go with requests to our own origin; a separate API origin must allow
      // credentials through CORS (design §5.12).
      credentials: sameOrigin() ? "same-origin" : "include",
      ...(options.fresh ? { cache: "no-cache" as const } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "unavailable",
      "The server can't be reached. Check your connection and try again.",
    );
  }
  const text = await response.text();
  if (!response.ok) {
    const error = errorFromResponse(response.status, text);
    // Signed out meanwhile (an expired session). Not for the sign-in endpoints, where 401
    // means a wrong password, or the session itself, which would ask again and again.
    if (error.code === "unauthorized" && !path.startsWith("/auth/")) {
      settings.onUnauthorized?.(path);
    }
    throw error;
  }
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, "internal", "The server's answer isn't valid JSON.");
  }
}

/** The `ApiError` for a failed response's status and body. */
export function errorFromResponse(status: number, text: string): ApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = (parsed as Partial<ApiErrorBody> | undefined)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiError(status, error.code, error.message, {
      details: Array.isArray(error.details) ? error.details : [],
      current: error.current,
    });
  }
  return new ApiError(status, codeForStatus(status), `The server answered with HTTP ${status}.`);
}

/** The error code for a status, when the answer has no error body (from a proxy, say). */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "bad_request";
  }
}

// =======================================================================================
// Public reads

export function getProject(options: ReadOptions = {}): Promise<ProjectInfo> {
  return request("/project", { ...options });
}

export function listFiles(
  language: string,
  options: ReadOptions = {},
): Promise<LanguageFilesResult> {
  return request("/files", { query: { language }, ...options });
}

export function listSources(options: ReadOptions = {}): Promise<SourceFilesResult> {
  return request("/files", { ...options });
}

export function listStrings(query: StringsQuery, options: ReadOptions = {}): Promise<StringsPage> {
  return request("/strings", { query: { ...query }, ...options });
}

export function getString(
  id: number,
  language: string,
  options: ReadOptions = {},
): Promise<StringDetail> {
  return request(`/strings/${id}`, { query: { language }, ...options });
}

export function getHistory(
  id: number,
  language?: string,
  options: ReadOptions = {},
): Promise<HistoryResult> {
  return request(`/strings/${id}/history`, { query: { language }, ...options });
}

export function getActivity(
  cursor?: string,
  limit?: number,
  options: ReadOptions = {},
): Promise<ActivityResult> {
  return request("/activity", { query: { cursor, limit }, ...options });
}

// =======================================================================================
// Sign-in and accounts

/** Signed out, with no sign-in method but email and password. */
export const SIGNED_OUT: SessionInfo = {
  user: null,
  setupRequired: false,
  dev: false,
  providers: { github: false, discord: false, email: false },
  humanCheck: null,
};

export interface SessionState {
  info: SessionInfo;
  /** False when the server has no accounts yet (`/auth/session` answers 404). */
  accounts: boolean;
}

/** The session; a server without accounts yet (404) means signed out, with no providers. */
export async function getSession(options: ReadOptions = {}): Promise<SessionState> {
  try {
    const info = await request<SessionInfo>("/auth/session", { ...options });
    return { info: { ...SIGNED_OUT, ...info }, accounts: true };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { info: SIGNED_OUT, accounts: false };
    }
    throw error;
  }
}

export function signUp(body: SignUpRequest): Promise<unknown> {
  return request("/auth/signup", { method: "POST", body });
}

export function signIn(body: SignInRequest): Promise<unknown> {
  return request("/auth/signin", { method: "POST", body });
}

export function signOut(): Promise<unknown> {
  return request("/auth/signout", { method: "POST", body: {} });
}

export function setUp(body: SetupRequest): Promise<unknown> {
  return request("/auth/setup", { method: "POST", body });
}

export function requestPasswordReset(body: EmailRequest): Promise<unknown> {
  return request("/auth/password-reset/request", { method: "POST", body });
}

export function resetPassword(body: ResetPasswordRequest): Promise<unknown> {
  return request("/auth/password-reset", { method: "POST", body });
}

export function verifyEmail(body: TokenRequest): Promise<unknown> {
  return request("/auth/verify-email", { method: "POST", body });
}

export function requestEmailLink(body: EmailRequest): Promise<unknown> {
  return request("/auth/email-link/request", { method: "POST", body });
}

export function signInWithLink(body: TokenRequest): Promise<unknown> {
  return request("/auth/email-link", { method: "POST", body });
}

export function checkInvite(token: string): Promise<InviteCheck> {
  return request(`/invites/${encodeURIComponent(token)}`);
}

// =======================================================================================
// Translations, suggestions, review and the LLM

function translationPath(id: number, language: string): string {
  return `/strings/${id}/translations/${encodeURIComponent(language)}`;
}

/** A manager's save: blue. */
export function saveTranslation(
  id: number,
  language: string,
  body: SaveTranslationRequest,
): Promise<unknown> {
  return request(translationPath(id, language), { method: "PUT", body });
}

export function approveTranslation(
  id: number,
  language: string,
  body: TranslationActionRequest,
): Promise<unknown> {
  return request(`${translationPath(id, language)}/approve`, { method: "POST", body });
}

export function unapproveTranslation(
  id: number,
  language: string,
  body: TranslationActionRequest,
): Promise<unknown> {
  return request(`${translationPath(id, language)}/unapprove`, { method: "POST", body });
}

export function deleteTranslation(
  id: number,
  language: string,
  body: TranslationActionRequest,
): Promise<unknown> {
  return request(translationPath(id, language), { method: "DELETE", body });
}

/** A contributor's pending change: a translation, a correction or "looks good". */
export function suggest(id: number, language: string, body: SuggestRequest): Promise<unknown> {
  return request(`/strings/${id}/suggestions/${encodeURIComponent(language)}`, {
    method: "POST",
    body,
  });
}

/** Withdraws one's own pending suggestion. */
export function withdrawSuggestion(id: number): Promise<unknown> {
  return request(`/suggestions/${id}`, { method: "DELETE" });
}

export function reviewSuggestions(body: ReviewRequest): Promise<ReviewResult> {
  return request("/suggestions/review", { method: "POST", body });
}

/** "Translate with the LLM": a job for some strings in some languages. */
export async function createJob(body: CreateJobRequest): Promise<CreateJobResult> {
  const result = await request<CreateJobResult>("/jobs", { method: "POST", body });
  if (result.job) {
    const job = result.job;
    queryCache.setData<JobsResult>(["jobs", "active"], (current) => ({
      jobs: [job, ...(current?.jobs ?? []).filter((existing) => existing.id !== job.id)],
    }));
    await queryCache.invalidate(["jobs"]);
  }
  return result;
}

export function getStringsQueue(
  query: StringsQueueQuery,
  options: ReadOptions = {},
): Promise<StringsQueue> {
  return request("/strings/queue", { query: { ...query }, ...options });
}
