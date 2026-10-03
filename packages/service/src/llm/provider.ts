// SPDX-License-Identifier: MIT
/**
 * The `TranslationProvider` interface (design §5.6, LLM-8): what jobs talk to. Two
 * implementations ship: Gemini over `fetch` (`gemini.ts`) and the fake translator
 * (`fake.ts`) for development, tests and demos.
 */
import type { InterpolationSyntax, LlmSettings, PluralCategory, TextValue } from "@quaso/core";

/** The safety filters: as permissive as the API allows by default (design §5.6). */
export type SafetyLevel = LlmSettings["safety"];

/** Tokens a request used. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

/** A JSON schema, as plain data. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * A machine-readable copy of a batch, for providers that don't read prompts (the fake
 * translator). The Gemini provider ignores it.
 */
export interface ProviderBatch {
  sourceLanguage: string;
  targetLanguage: string;
  syntax: InterpolationSyntax;
  strings: ProviderString[];
}

export interface ProviderString {
  /** The ID the answer must give back, such as `s812`. */
  id: string;
  kind: "text" | "plural" | "ordinal";
  /** The English, with references masked as `⟦n⟧`. */
  english: TextValue;
  /** For plural and ordinal strings: the forms the answer must give. */
  forms?: PluralCategory[];
  maxLength?: number;
}

export interface ProviderRequest {
  model: string;
  /** The system instruction: the stable part of the prompt. */
  system: string;
  prompt: string;
  /** The JSON schema of the answer (`RESPONSE_SCHEMA` in `prompt.ts`). */
  responseSchema: JsonSchemaObject;
  safety: SafetyLevel;
  signal?: AbortSignal;
  batch?: ProviderBatch;
}

export interface ProviderResult {
  /** The answer, parsed from JSON; `null` when blocked. */
  answer: unknown;
  usage: Usage;
  durationMs: number;
  /** Why the answer was blocked (the safety filter's reason), if it was. */
  blocked?: string;
  /** The model that answered, when it isn't the one asked for (the fake says "fake"). */
  model?: string;
}

export interface TextRequest {
  model: string;
  system: string;
  prompt: string;
  /** Default: permissive. */
  safety?: SafetyLevel;
  signal?: AbortSignal;
}

export interface TextResult {
  text: string;
  usage: Usage;
  durationMs?: number;
  model?: string;
}

export interface TranslationProvider {
  readonly name: "gemini" | "fake";
  /** Translates a batch: the answer follows `request.responseSchema`. */
  translate(request: ProviderRequest): Promise<ProviderResult>;
  /** Free text, such as a file's context. */
  generateText(request: TextRequest): Promise<TextResult>;
  /** The models the provider offers, by name. */
  listModels(): Promise<string[]>;
}

export const PROVIDER_ERROR_KINDS = [
  /** 429, after the provider's own retries. */
  "rate_limited",
  /** 5xx, after the provider's own retries. */
  "server",
  /** No answer: DNS, TLS, a reset connection, a timeout. */
  "network",
  /** 400 or 404: a bad request, or a model that doesn't exist. */
  "invalid_request",
  /** 401 or 403: the key was refused. */
  "auth",
  /** The answer was blocked. */
  "blocked",
  /** The answer isn't what was asked for: cut off (MAX_TOKENS), or not JSON. */
  "invalid_answer",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** A request that failed, after the provider's own retries. Never carries the key. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** How long the provider asked to wait, when it said. */
  readonly retryAfterMs: number | null;
  /** The HTTP status, when there was an answer. */
  readonly status: number | null;
  /** Tokens the failed request still used, if the answer said. */
  readonly usage: Usage | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryAfterMs?: number | null; status?: number | null; usage?: Usage | null } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
    this.usage = options.usage ?? null;
  }
}

/** Total tokens of a usage. */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.thinkingTokens;
}
