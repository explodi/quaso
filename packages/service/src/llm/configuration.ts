// SPDX-License-Identifier: MIT
/** Each alarm slice captures its providers and limits; later slices read changed settings. */
import type { LlmProviderName, LlmTestResult } from "@quaso/core";
import type { Context } from "../context.ts";
import type { Sql, Statement, Logger } from "../ports.ts";
import { settingsFromData } from "../settings.ts";
import { ModelList, SettingsModels, SETTINGS_MODELS_WAIT_MS } from "../jobs/models.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createFakeTranslator } from "./fake.ts";
import { ProviderError, type TranslationProvider } from "./provider.ts";
import { badRequest, ServiceError } from "../errors.ts";

export interface LlmConfiguration {
  provider: TranslationProvider | null;
  concurrency: number;
  monthlyTokenBudget: number | null;
}

export interface StoredLlmOptions {
  model: string;
  clock: () => number;
  logger: Logger;
  dev?: boolean;
  /** Internal provider overrides support deterministic tests. */
  provider?: TranslationProvider | null;
  providerFactory?: (apiKey: string, provider: LlmProviderName) => TranslationProvider;
  concurrency?: number;
  monthlyTokenBudget?: number | null;
}

const SETTINGS: Statement = { sql: "SELECT data FROM settings WHERE id = 1" };
const KEYS: Statement = {
  sql: "SELECT name, value, updated_at FROM secrets WHERE name IN ('gemini_api_key', 'anthropic_api_key')",
};
type KeyRow = { name: string; value: string; updated_at: number };
const LABELS = { gemini: "Gemini", anthropic: "Anthropic" };
const KEY_LABELS = { gemini: "a Gemini", anthropic: "an Anthropic" };
const PROVIDERS: LlmProviderName[] = ["gemini", "anthropic"];

export function modelProvider(model: string): LlmProviderName {
  return model.startsWith("claude-") ? "anthropic" : "gemini";
}

/** Attribution follows each request's model, including per-job and editor overrides. */
export function requestProvider(provider: TranslationProvider, model: string): string {
  return provider.name === "fake" ? "fake" : modelProvider(model);
}

export class StoredLlm {
  readonly #keys = new Map<LlmProviderName, string | null>();
  readonly #providers = new Map<LlmProviderName, TranslationProvider>();
  readonly #models = new Map<LlmProviderName, ModelList>();
  readonly #availableModels = new Map<LlmProviderName, SettingsModels>();
  #listing: Promise<string[]> | null = null;
  readonly #fake: TranslationProvider | null;
  readonly #overrideModels: ModelList;

  private readonly options: StoredLlmOptions;
  constructor(options: StoredLlmOptions) {
    this.options = options;
    this.#fake = options.dev ? createFakeTranslator({ delayMs: 300 }) : null;
    this.#overrideModels = new ModelList(
      options.provider ?? this.#fake,
      options.clock,
      options.logger,
    );
  }

  read(ctx: Context): LlmConfiguration {
    const settings = ctx.sql.query<{ data: string }>(SETTINGS.sql)[0]?.data ?? null;
    return this.configure(settings, ctx.sql.query<KeyRow>(KEYS.sql));
  }

  async readAsync(sql: Sql): Promise<LlmConfiguration> {
    const [settings, keys] = await sql.read([SETTINGS, KEYS]);
    return this.configure((settings[0]?.data as string) ?? null, keys as KeyRow[]);
  }

  models(): Promise<string[]> {
    if (this.options.provider !== undefined || this.#providers.size === 0)
      return this.#overrideModels.list();
    if (this.#listing !== null) return this.#listing;
    const pending = Promise.all([...this.#availableModels.values()].map((models) => models.list()))
      .then((lists) => [...new Set(lists.flat())].sort())
      .finally(() => {
        if (this.#listing === pending) this.#listing = null;
      });
    this.#listing = pending;
    return pending;
  }

  test(ctx: Context, provider: LlmProviderName = "gemini"): Promise<LlmTestResult> {
    const row = ctx.sql.query<KeyRow>(KEYS.sql).find((key) => key.name === `${provider}_api_key`);
    return this.testKey(provider, row?.value ?? null, row?.updated_at ?? 0);
  }

  async testAsync(sql: Sql, provider: LlmProviderName = "gemini"): Promise<LlmTestResult> {
    const [rows] = await sql.read([KEYS]);
    const row = (rows as KeyRow[]).find((key) => key.name === `${provider}_api_key`);
    return this.testKey(provider, row?.value ?? null, row?.updated_at ?? 0);
  }

  private create(provider: LlmProviderName, apiKey: string, test = false): TranslationProvider {
    if (this.options.providerFactory) return this.options.providerFactory(apiKey, provider);
    const options = { apiKey, ...(test ? { maxAttempts: 1, timeoutMs: 10_000 } : {}) };
    return provider === "anthropic"
      ? createAnthropicProvider(options)
      : createGeminiProvider(options);
  }

  private async testKey(
    provider: LlmProviderName,
    key: string | null,
    keyUpdatedAt: number,
  ): Promise<LlmTestResult> {
    const label = LABELS[provider];
    if (key === null) throw badRequest(`Enter ${KEY_LABELS[provider]} API key before testing it.`);
    let models: string[];
    try {
      models = await this.create(provider, key, true).listModels();
    } catch (error) {
      // Provider diagnostics can contain credentials; return only a known message.
      if (error instanceof ProviderError && error.kind === "auth")
        throw badRequest(`${label} refused this API key. Replace it and try again.`);
      throw new ServiceError(
        "unavailable",
        `Couldn't reach ${label} or list its models. Try again.`,
      );
    }
    const names = [...new Set(models)].filter((name) => !name.includes(key)).sort();
    if (names.length === 0)
      throw badRequest(`This ${label} key has no available translation models.`);
    if (this.#keys.get(provider) === key) this.#models.get(provider)?.remember(names);
    return { ok: true, models: names, keyUpdatedAt };
  }

  private configure(data: string | null, rows: KeyRow[]): LlmConfiguration {
    const settings = settingsFromData(data, this.options.model);
    for (const name of PROVIDERS) {
      const key = rows.find((row) => row.name === `${name}_api_key`)?.value ?? null;
      if (this.#keys.get(name) === key) continue;
      this.#keys.set(name, key);
      this.#providers.delete(name);
      this.#models.delete(name);
      this.#availableModels.delete(name);
      this.#listing = null;
      if (key !== null && this.options.provider === undefined) {
        const provider = this.create(name, key);
        this.#providers.set(name, provider);
        const models = new ModelList(provider, this.options.clock, this.options.logger);
        this.#models.set(name, models);
        // Each provider gets time to answer without holding the other past the settings deadline.
        this.#availableModels.set(
          name,
          new SettingsModels(() => models.list(), SETTINGS_MODELS_WAIT_MS / 2),
        );
      }
    }
    // A copied map keeps key rotation from changing an in-flight alarm slice.
    const providers = new Map(this.#providers);
    const select = (model: string): TranslationProvider => {
      const name = modelProvider(model);
      const provider = providers.get(name);
      if (!provider)
        throw new ProviderError(
          "auth",
          `Enter ${KEY_LABELS[name]} API key in Settings to use ${model}.`,
        );
      return provider;
    };
    let provider: TranslationProvider | null = this.options.provider ?? this.#fake;
    if (this.options.provider === null) provider = null;
    else if (this.options.provider === undefined && providers.size > 0) {
      provider = {
        name: modelProvider(settings.llm.model),
        translate: (request) => select(request.model).translate(request),
        generateText: (request) => select(request.model).generateText(request),
        listModels: () => this.models(),
      };
    }
    return {
      provider,
      concurrency: this.options.concurrency ?? settings.llm.concurrency,
      monthlyTokenBudget:
        this.options.monthlyTokenBudget === undefined
          ? settings.llm.monthlyTokenBudget
          : this.options.monthlyTokenBudget,
    };
  }
}
