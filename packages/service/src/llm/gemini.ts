// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The Gemini provider (design §5.6, LLM-1, LLM-8): the Gemini API over `fetch`, with no
 * SDK. Structured output with a response schema, safety settings, usage metadata, and
 * retries with exponential backoff and full jitter for rate limits, server errors and
 * network errors, honouring `Retry-After`.
 *
 * The key goes only in the `x-goog-api-key` header: never in a URL, a message or a log.
 */
import {
  type JsonSchemaObject,
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type SafetyLevel,
  type TextRequest,
  type TextResult,
  type TranslationProvider,
  type Usage,
} from "./provider.ts";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/** Attempts per request, the first included. */
export const GEMINI_MAX_ATTEMPTS = 4;

export interface GeminiOptions {
  apiKey: string;
  /** Default: `GEMINI_BASE_URL`. */
  baseUrl?: string;
  /** Default: the global `fetch`. */
  fetch?: Fetch;
  /** Default: `setTimeout`. Tests pass one that records the waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: `Math.random`, for the jitter. */
  random?: () => number;
  /** Default: `Date.now`, for `Retry-After` dates and durations. */
  now?: () => number;
  /** Default: `GEMINI_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** The first retry's longest wait, doubled at every retry. Default: 1 second. */
  baseDelayMs?: number;
  /** The longest wait between attempts. Default: 30 seconds. */
  maxDelayMs?: number;
  /** A `Retry-After` longer than this ends the retries. Default: 60 seconds. */
  maxRetryAfterMs?: number;
  /** Each attempt's timeout. Default: 3 minutes (thinking models can take a while). */
  timeoutMs?: number;
}

/** The harm categories the safety settings name. */
export const HARM_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

/** Finish reasons that mean the answer was blocked. */
const BLOCKED_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

/** Statuses worth another attempt. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * The safety settings for a level: `permissive` turns every filter off (`BLOCK_NONE`), as
 * games talk about violence, sickness, death and crime; `default` sends none (the API's
 * defaults); `strict` blocks from a low probability up.
 */
export function safetySettings(level: SafetyLevel): { category: string; threshold: string }[] {
  if (level === "default") return [];
  const threshold = level === "permissive" ? "BLOCK_NONE" : "BLOCK_LOW_AND_ABOVE";
  return HARM_CATEGORIES.map((category) => ({ category, threshold }));
}

/**
 * A JSON schema as Gemini's response schema (a subset of OpenAPI's): types in upper case
 * (`OBJECT`, `ARRAY`, `STRING`), and only the keywords it knows.
 */
export function toGeminiSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type":
        out.type = String(value).toUpperCase();
        break;
      case "properties":
        out.properties = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchemaObject>).map(([name, property]) => [
            name,
            toGeminiSchema(property),
          ]),
        );
        break;
      case "items":
        out.items = toGeminiSchema(value as JsonSchemaObject);
        break;
      case "required":
      case "enum":
      case "description":
      case "nullable":
      case "format":
      case "propertyOrdering":
      case "minItems":
      case "maxItems":
        out[key] = value;
        break;
      default:
        // additionalProperties, $schema and the rest: Gemini refuses them.
        break;
    }
  }
  return out;
}

/** Creates the Gemini provider. */
export function createGeminiProvider(options: GeminiOptions): TranslationProvider {
  return new GeminiProvider(options);
}

type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
};

class GeminiProvider implements TranslationProvider {
  readonly name = "gemini" as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxRetryAfterMs: number;
  readonly #timeoutMs: number;

  constructor(options: GeminiOptions) {
    if (options.apiKey.trim() === "") throw new Error("The Gemini API key is empty");
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? GEMINI_MAX_ATTEMPTS);
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  async translate(request: ProviderRequest): Promise<ProviderResult> {
    const started = this.#now();
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(request.responseSchema),
        temperature: 0.2,
      },
      safetySettings: safetySettings(request.safety),
    };
    const response = await this.#generate(request.model, body, request.signal);
    const usage = usageOf(response);
    const durationMs = this.#now() - started;
    const blocked = blockReason(response);
    if (blocked !== null) return { answer: null, usage, durationMs, blocked };
    const text = answerText(response, usage);
    try {
      return { answer: JSON.parse(text), usage, durationMs };
    } catch {
      throw new ProviderError("invalid_answer", "The answer isn't valid JSON.", { usage });
    }
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const started = this.#now();
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: { temperature: 0.2 },
      safetySettings: safetySettings(request.safety ?? "permissive"),
    };
    const response = await this.#generate(request.model, body, request.signal);
    const usage = usageOf(response);
    const blocked = blockReason(response);
    if (blocked !== null) {
      throw new ProviderError("blocked", `The answer was blocked (${blocked}).`, { usage });
    }
    return { text: answerText(response, usage).trim(), usage, durationMs: this.#now() - started };
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${this.#baseUrl}/v1beta/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = (await this.#request(url.toString(), { method: "GET" })) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const model of body.models ?? []) {
        if (typeof model.name !== "string") continue;
        if (!(model.supportedGenerationMethods ?? []).includes("generateContent")) continue;
        models.push(model.name.replace(/^models\//, ""));
      }
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return models;
  }

  #generate(model: string, body: unknown, signal?: AbortSignal): Promise<GeminiResponse> {
    if (!/^[\w.-]+$/.test(model)) {
      return Promise.reject(new ProviderError("invalid_request", `Not a model name: ${model}`));
    }
    const url = `${this.#baseUrl}/v1beta/models/${model}:generateContent`;
    return this.#request(url, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }) as Promise<GeminiResponse>;
  }

  /** One API call, with retries. Returns the parsed JSON body of a 2xx answer. */
  async #request(
    url: string,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const headers: Record<string, string> = { "x-goog-api-key": this.#apiKey };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let failure: ProviderError | null = null;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      if (attempt > 0) {
        const wait = failure?.retryAfterMs ?? this.#backoff(attempt - 1);
        await this.#sleep(wait);
      }
      if (init.signal?.aborted) throw new ProviderError("network", "The request was cancelled.");
      let response: Response;
      let text: string;
      try {
        const signals = [AbortSignal.timeout(this.#timeoutMs)];
        if (init.signal) signals.push(init.signal);
        response = await this.#fetch(url, {
          method: init.method,
          headers,
          body: init.body,
          // Never follow a redirect: the key header would go with it. Not "error", which
          // workerd refuses (it throws before sending anything), so a Durable Object could
          // never reach the API; a redirect is refused below instead.
          redirect: "manual",
          signal: AbortSignal.any(signals),
        });
        text = await response.text();
      } catch (error) {
        if (init.signal?.aborted) throw new ProviderError("network", "The request was cancelled.");
        failure = new ProviderError("network", this.#redact(networkMessage(error)));
        continue;
      }
      if (isRedirect(response)) {
        const status = response.status === 0 ? null : response.status;
        throw new ProviderError(
          "invalid_request",
          `The Gemini API answered with a redirect${
            status === null ? "" : ` (HTTP ${status})`
          }, which isn't followed; check the base URL.`,
          { status },
        );
      }
      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new ProviderError("invalid_answer", "The Gemini API's answer isn't JSON.", {
            status: response.status,
          });
        }
      }
      const error = this.#httpError(response, text);
      if (!RETRY_STATUSES.has(response.status)) throw error;
      if (error.retryAfterMs !== null && error.retryAfterMs > this.#maxRetryAfterMs) throw error;
      failure = error;
    }
    throw failure ?? new ProviderError("network", "The request failed.");
  }

  /** Full jitter: a random wait up to `base × 2^attempt`, capped. */
  #backoff(attempt: number): number {
    const cap = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
    return Math.round(this.#random() * cap);
  }

  #httpError(response: Response, text: string): ProviderError {
    const status = response.status;
    let message = `HTTP ${status}`;
    let retryDelay: number | null = null;
    let badKey = false;
    try {
      const body = JSON.parse(text) as {
        error?: { message?: string; details?: { retryDelay?: string; reason?: string }[] };
      };
      if (typeof body.error?.message === "string") message += `: ${body.error.message}`;
      for (const detail of body.error?.details ?? []) {
        retryDelay ??= parseRetryDelay(detail.retryDelay);
        // An invalid key is a 400 with this reason, not a 401.
        if (detail.reason === "API_KEY_INVALID") badKey = true;
      }
    } catch {
      // Not JSON: the status says enough.
    }
    const retryAfterMs =
      parseRetryAfter(response.headers.get("Retry-After"), this.#now()) ?? retryDelay;
    const kind =
      status === 401 || status === 403 || badKey
        ? "auth"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "server"
            : "invalid_request";
    return new ProviderError(kind, this.#redact(message), { status, retryAfterMs });
  }

  #redact(message: string): string {
    return message.replaceAll(this.#apiKey, "[redacted]");
  }
}

/** A redirect answer: a 3xx, or a browser's opaque redirect (status 0). */
function isRedirect(response: Response): boolean {
  // workerd's types list only "default" and "error".
  const type: string = response.type;
  return type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/** Tokens from `usageMetadata`. */
function usageOf(response: GeminiResponse): Usage {
  const metadata = response.usageMetadata ?? {};
  return {
    inputTokens: metadata.promptTokenCount ?? 0,
    outputTokens: metadata.candidatesTokenCount ?? 0,
    thinkingTokens: metadata.thoughtsTokenCount ?? 0,
  };
}

/** Why the answer was blocked, or null. */
function blockReason(response: GeminiResponse): string | null {
  const prompt = response.promptFeedback?.blockReason;
  if (prompt) return prompt;
  const finish = response.candidates?.[0]?.finishReason;
  return finish && BLOCKED_REASONS.has(finish) ? finish : null;
}

/** The answer's text: its text parts, without the thoughts. */
function answerText(response: GeminiResponse, usage: Usage): string {
  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new ProviderError("invalid_answer", "The answer has no candidates.", { usage });
  }
  if (candidate.finishReason === "MAX_TOKENS") {
    throw new ProviderError(
      "invalid_answer",
      "The answer was cut off at the maximum number of tokens (MAX_TOKENS).",
      { usage },
    );
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (text.trim() === "") {
    const reason = candidate.finishReason ? ` (${candidate.finishReason})` : "";
    throw new ProviderError("invalid_answer", `The answer is empty${reason}.`, { usage });
  }
  return text;
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date. Null when absent or invalid. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Google's `RetryInfo.retryDelay`, such as `"30s"` or `"1.5s"`, in milliseconds. */
function parseRetryDelay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

function networkMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The Gemini API didn't answer in time.";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Can't reach the Gemini API: ${message}`;
}
