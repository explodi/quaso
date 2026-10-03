// SPDX-License-Identifier: MIT
/**
 * The models the provider offers (design §5.6, open question 4), for the model picker and
 * `quaso translate --model`: asked once, then kept for ten minutes. A provider that can't
 * answer gives an empty list, and a warning in the log; that answer is kept for a minute,
 * so that callers don't each wait for a provider that is down.
 */
import type { Logger } from "../ports.ts";
import type { TranslationProvider } from "../llm/provider.ts";

/** How long the list is kept. */
export const MODELS_TTL_MS = 10 * 60 * 1000;

/** How long a failure to list the models is kept. */
export const MODELS_FAILURE_TTL_MS = 60 * 1000;

export const SETTINGS_MODELS_WAIT_MS = 1500;

/** Settings can answer while a slow provider's shared model request continues. */
export class SettingsModels {
  #known: string[] = [];
  #abandoned: Promise<string[]> | null = null;

  constructor(private readonly models: () => Promise<string[]>) {}

  async list(): Promise<string[]> {
    const pending = this.models();
    if (pending === this.#abandoned) return this.#known;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SETTINGS_MODELS_WAIT_MS);
    });
    const list = await Promise.race([pending, late]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (list === null) {
      this.#abandoned = pending;
      pending.then((names) => {
        if (names.length > 0) this.#known = names;
      });
      return this.#known;
    }
    if (list.length > 0) this.#known = list;
    return list;
  }
}

export class ModelList {
  readonly #provider: TranslationProvider | null;
  readonly #clock: () => number;
  readonly #logger: Logger;
  #cached: { until: number; models: Promise<string[]> } | null = null;

  constructor(provider: TranslationProvider | null, clock: () => number, logger: Logger) {
    this.#provider = provider;
    this.#clock = clock;
    this.#logger = logger;
  }

  /** The models, sorted; empty without a provider. */
  list(): Promise<string[]> {
    const provider = this.#provider;
    if (provider === null) return Promise.resolve([]);
    const now = this.#clock();
    if (this.#cached !== null && now < this.#cached.until) return this.#cached.models;
    const models: Promise<string[]> = provider.listModels().then(
      (names) => [...new Set(names)].sort(),
      (error) => {
        this.#logger.warn("Couldn't list the provider's models", { error });
        if (this.#cached?.models === models) {
          this.#cached = { until: this.#clock() + MODELS_FAILURE_TTL_MS, models };
        }
        return [];
      },
    );
    this.#cached = { until: now + MODELS_TTL_MS, models };
    return models;
  }
}
