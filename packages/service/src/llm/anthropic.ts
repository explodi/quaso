// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import {
  type JsonSchemaObject,
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type TextRequest,
  type TextResult,
  type TranslationProvider,
  type Usage,
} from "./provider.ts";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_MAX_ATTEMPTS = 4;

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  timeoutMs?: number;
}

type Message = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
};

/** Claude requires closed objects and doesn't accept Gemini's property ordering hint. */
export function toAnthropicSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "propertyOrdering") continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchemaObject>).map(([name, property]) => [
          name,
          toAnthropicSchema(property),
        ]),
      );
    } else if (key === "items") {
      out.items = toAnthropicSchema(value as JsonSchemaObject);
    } else {
      out[key] = value;
    }
  }
  if (schema.type === "object") out.additionalProperties = false;
  return out;
}

export function createAnthropicProvider(options: AnthropicOptions): TranslationProvider {
  return new AnthropicProvider(options);
}

class AnthropicProvider implements TranslationProvider {
  readonly name = "anthropic" as const;
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

  constructor(options: AnthropicOptions) {
    if (options.apiKey.trim() === "") throw new Error("The Anthropic API key is empty");
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? ANTHROPIC_MAX_ATTEMPTS);
    this.#baseDelayMs = options.baseDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  async translate(request: ProviderRequest): Promise<ProviderResult> {
    const started = this.#now();
    const response = await this.#generate(request, {
      output_config: {
        format: { type: "json_schema", schema: toAnthropicSchema(request.responseSchema) },
      },
    });
    const usage = usageOf(response);
    const durationMs = this.#now() - started;
    if (response.stop_reason === "refusal") {
      return { answer: null, usage, durationMs, blocked: "refusal" };
    }
    const text = answerText(response, usage);
    try {
      return { answer: JSON.parse(text), usage, durationMs };
    } catch {
      throw new ProviderError("invalid_answer", "The answer isn't valid JSON.", { usage });
    }
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const started = this.#now();
    const response = await this.#generate(request);
    const usage = usageOf(response);
    if (response.stop_reason === "refusal") {
      throw new ProviderError("blocked", "The answer was blocked (refusal).", { usage });
    }
    return { text: answerText(response, usage), usage, durationMs: this.#now() - started };
  }

  async listModels(): Promise<string[]> {
    const models = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${this.#baseUrl}/v1/models`);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
      const body = (await this.#request(url.toString(), { method: "GET" })) as {
        data?: { id?: string; lifecycle?: string }[];
        has_more?: boolean;
        last_id?: string;
      };
      for (const model of body.data ?? []) {
        if (typeof model.id !== "string" || !model.id.startsWith("claude-")) continue;
        if (model.lifecycle !== "retired") models.add(model.id);
      }
      if (!body.has_more) break;
      if (!body.last_id || body.last_id === cursor) {
        throw new ProviderError("invalid_answer", "The Anthropic model list has no next page.");
      }
      cursor = body.last_id;
    }
    return [...models];
  }

  #generate(request: TextRequest, extra: Record<string, unknown> = {}): Promise<Message> {
    if (!/^claude-[\w.-]+$/.test(request.model)) {
      return Promise.reject(new ProviderError("invalid_request", "Not a Claude model name."));
    }
    return this.#request(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        max_tokens: 16_384,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        ...extra,
      }),
    }) as Promise<Message>;
  }

  async #request(
    url: string,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "x-api-key": this.#apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
    let failure: ProviderError | null = null;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      if (init.signal?.aborted) throw new ProviderError("network", "The request was cancelled.");
      if (attempt > 0) {
        const cap = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
        await waitForRetry(
          this.#sleep,
          failure?.retryAfterMs ?? Math.round(this.#random() * cap),
          init.signal,
        );
      }
      if (init.signal?.aborted) throw new ProviderError("network", "The request was cancelled.");
      let response: Response;
      let text: string;
      try {
        const signals = [AbortSignal.timeout(this.#timeoutMs)];
        if (init.signal) signals.push(init.signal);
        response = await this.#fetch(url, {
          ...init,
          headers,
          // workerd supports manual redirects; following one would send the key to another host.
          redirect: "manual",
          signal: AbortSignal.any(signals),
        });
        text = await response.text();
      } catch (error) {
        if (init.signal?.aborted) throw new ProviderError("network", "The request was cancelled.");
        const message = error instanceof Error ? error.message : String(error);
        failure = new ProviderError(
          "network",
          this.#redact(`Can't reach the Anthropic API: ${message}`),
        );
        continue;
      }
      const responseType: string = response.type;
      const redirected =
        responseType === "opaqueredirect" || (response.status >= 300 && response.status < 400);
      if (redirected) {
        throw new ProviderError(
          "invalid_request",
          "The Anthropic API answered with a redirect, which isn't followed.",
          { status: response.status },
        );
      }
      if (response.ok) {
        try {
          const body = JSON.parse(text);
          if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
          return body;
        } catch {
          throw new ProviderError(
            "invalid_answer",
            "The Anthropic API's answer isn't a JSON object.",
            { status: response.status },
          );
        }
      }
      failure = this.#httpError(response, text);
      const retryable = response.status === 429 || response.status >= 500;
      const waitTooLong =
        failure.retryAfterMs !== null && failure.retryAfterMs > this.#maxRetryAfterMs;
      if (!retryable || waitTooLong) throw failure;
    }
    throw failure ?? new ProviderError("network", "The request failed.");
  }

  #httpError(response: Response, text: string): ProviderError {
    const status = response.status;
    let message = `HTTP ${status}`;
    try {
      const body = JSON.parse(text);
      if (typeof body.error?.message === "string") message += `: ${body.error.message}`;
    } catch {
      // Non-JSON errors still have a useful HTTP status.
    }
    const header = response.headers.get("Retry-After")?.trim();
    let retryAfterMs: number | null = null;
    if (header) {
      const seconds = /^\d+(\.\d+)?$/.test(header);
      const duration = seconds ? Number(header) * 1000 : Date.parse(header) - this.#now();
      if (Number.isFinite(duration)) retryAfterMs = Math.max(0, Math.round(duration));
    }
    const kind =
      status === 401 || status === 403
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

function usageOf(response: Message): Usage {
  const usage = response.usage ?? {};
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens ?? 0;
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    // Anthropic includes thinking in output_tokens, unlike Gemini.
    outputTokens: Math.max(0, (usage.output_tokens ?? 0) - thinkingTokens),
    thinkingTokens,
  };
}

function answerText(response: Message, usage: Usage): string {
  if (response.stop_reason === "max_tokens") {
    throw new ProviderError(
      "invalid_answer",
      "The answer was cut off at the maximum number of tokens (max_tokens).",
      { usage },
    );
  }
  if (response.stop_reason !== "end_turn") {
    throw new ProviderError("invalid_answer", "The Anthropic answer did not finish.", { usage });
  }
  if (!Array.isArray(response.content)) {
    throw new ProviderError("invalid_answer", "The answer has no content blocks.", { usage });
  }
  const text = response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new ProviderError("invalid_answer", "The answer is empty.", { usage });
  return text;
}

async function waitForRetry(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return await sleep(ms);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError("network", "The request was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([sleep(ms), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
