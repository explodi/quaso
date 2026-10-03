// SPDX-License-Identifier: MIT
/** Each alarm slice captures its provider and limits; later slices read changed settings. */
import type { Context } from "../context.ts";
import type { Sql, Statement, Logger } from "../ports.ts";
import { settingsFromData } from "../settings.ts";
import { ModelList } from "../jobs/models.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createFakeTranslator } from "./fake.ts";
import { ProviderError, type TranslationProvider } from "./provider.ts";
import type { LlmTestResult } from "@quaso/core";
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
  providerFactory?: (apiKey: string) => TranslationProvider;
  concurrency?: number;
  monthlyTokenBudget?: number | null;
}

const SETTINGS: Statement = { sql: "SELECT data FROM settings WHERE id = 1" };
const KEY: Statement = {
  sql: "SELECT value, updated_at FROM secrets WHERE name = 'gemini_api_key'",
};

export class StoredLlm {
  #key: string | null | undefined;
  #provider: TranslationProvider | null = null;
  #models: ModelList;
  readonly #fake: TranslationProvider | null;

  constructor(private readonly options: StoredLlmOptions) {
    this.#fake = options.dev ? createFakeTranslator({ delayMs: 300 }) : null;
    this.#models = new ModelList(null, options.clock, options.logger);
  }

  read(ctx: Context): LlmConfiguration {
    const settings = ctx.sql.query<{ data: string }>(SETTINGS.sql)[0]?.data ?? null;
    const key = ctx.sql.query<{ value: string }>(KEY.sql)[0]?.value ?? null;
    return this.configure(settings, key);
  }

  async readAsync(sql: Sql): Promise<LlmConfiguration> {
    const [settings, key] = await sql.read([SETTINGS, KEY]);
    return this.configure((settings[0]?.data as string) ?? null, (key[0]?.value as string) ?? null);
  }

  models(): Promise<string[]> {
    return this.#models.list();
  }

  test(ctx: Context): Promise<LlmTestResult> {
    const row = ctx.sql.query<{ value: string; updated_at: number }>(KEY.sql)[0];
    return this.testKey(row?.value ?? null, row?.updated_at ?? 0);
  }

  async testAsync(sql: Sql): Promise<LlmTestResult> {
    const [rows] = await sql.read([KEY]);
    return this.testKey((rows[0]?.value as string) ?? null, Number(rows[0]?.updated_at ?? 0));
  }

  private async testKey(key: string | null, keyUpdatedAt: number): Promise<LlmTestResult> {
    if (key === null) throw badRequest("Enter a Gemini API key before testing it.");
    let models: string[];
    try {
      const create =
        this.options.providerFactory ??
        ((apiKey) => createGeminiProvider({ apiKey, maxAttempts: 1, timeoutMs: 10_000 }));
      models = await create(key).listModels();
    } catch (error) {
      // Provider diagnostics can contain credentials; return only a known message.
      if (error instanceof ProviderError && error.kind === "auth")
        throw badRequest("Gemini refused this API key. Replace it and try again.");
      throw new ServiceError("unavailable", "Couldn't reach Gemini or list its models. Try again.");
    }
    const names = [...new Set(models)].filter((name) => !name.includes(key)).sort();
    if (names.length === 0)
      throw badRequest("This Gemini key has no available translation models.");
    return { ok: true, models: names, keyUpdatedAt };
  }

  private configure(data: string | null, key: string | null): LlmConfiguration {
    const settings = settingsFromData(data, this.options.model);
    if (key !== this.#key) {
      if (this.options.provider !== undefined) this.#provider = this.options.provider;
      else if (key === null) this.#provider = this.#fake;
      else {
        const create =
          this.options.providerFactory ?? ((apiKey) => createGeminiProvider({ apiKey }));
        this.#provider = create(key);
      }
      this.#key = key;
      this.#models = new ModelList(this.#provider, this.options.clock, this.options.logger);
    }
    return {
      provider: this.#provider,
      concurrency: this.options.concurrency ?? settings.llm.concurrency,
      monthlyTokenBudget:
        this.options.monthlyTokenBudget === undefined
          ? settings.llm.monthlyTokenBudget
          : this.options.monthlyTokenBudget,
    };
  }
}
