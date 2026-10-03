// SPDX-License-Identifier: MIT
/**
 * The LLM provider in the Durable Object (design §5.6, §5.12): Gemini when the
 * `GEMINI_API_KEY` secret is set, otherwise none (LLM translation is then off, with a clear
 * message). `LLM_CONCURRENCY` and `LLM_MONTHLY_TOKEN_BUDGET` are variables of
 * `wrangler.jsonc`. The key never reaches a log.
 */
import { createGeminiProvider, type Logger, type TranslationProvider } from "@quaso/service";

/** The variables this reads. */
export interface LlmEnv {
  GEMINI_API_KEY?: string;
  LLM_CONCURRENCY?: string;
  LLM_MONTHLY_TOKEN_BUDGET?: string;
}

/** The service's LLM options from the Worker's environment. */
export function llmOptionsFromEnv(
  env: LlmEnv,
  log: Logger,
): {
  provider: TranslationProvider | null;
  llmConcurrency: number;
  monthlyTokenBudget: number | null;
} {
  const key = env.GEMINI_API_KEY?.trim() ?? "";
  return {
    provider: key === "" ? null : createGeminiProvider({ apiKey: key }),
    llmConcurrency: wholeNumber(env.LLM_CONCURRENCY, "LLM_CONCURRENCY", 1, 64, log) ?? 4,
    monthlyTokenBudget: wholeNumber(
      env.LLM_MONTHLY_TOKEN_BUDGET,
      "LLM_MONTHLY_TOKEN_BUDGET",
      1,
      1e15,
      log,
    ),
  };
}

/** A whole number from a variable, or null when empty; a wrong one is logged and ignored. */
function wholeNumber(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
  log: Logger,
): number | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isSafeInteger(number) && number >= min && number <= max) return number;
  log.error(`${name} must be a whole number from ${min} to ${max}; it is ignored`, { value: text });
  return null;
}
