// SPDX-License-Identifier: MIT
/**
 * Helpers for the job tests: running the alarm until the jobs are done, and providers the
 * tests script, hold up or count.
 */
import { createFakeTranslator } from "../llm/fake.ts";
import type {
  ProviderRequest,
  ProviderResult,
  TextRequest,
  TextResult,
  TranslationProvider,
} from "../llm/provider.ts";
import type { SyncSql } from "../ports.ts";
import { nextWakeUp } from "../wakeups.ts";

/**
 * Calls `service.alarm()` while a wake-up is due (within a second of the test clock), and
 * returns how many times. Fails if the jobs never settle.
 */
export async function drain(
  instance: { service: { alarm(): Promise<void> }; sql: SyncSql; clock: { now: number } },
  limit = 200,
) {
  for (let runs = 0; runs < limit; runs++) {
    const next = nextWakeUp(instance.sql);
    if (next === null || next > instance.clock.now + 1000) return runs;
    await instance.service.alarm();
  }
  throw new Error(`The jobs didn't settle after ${limit} alarm runs`);
}

/** A provider whose `translate` a test writes; it records every request. */
export interface ScriptedProvider extends TranslationProvider {
  requests: ProviderRequest[];
  texts: TextRequest[];
}

/**
 * A provider that answers with `answer`, or like the fake translator when `answer` returns
 * undefined.
 */
export function scriptedProvider(
  answer: (
    request: ProviderRequest,
    index: number,
  ) => Promise<ProviderResult | undefined> | ProviderResult | undefined = () => undefined,
): ScriptedProvider {
  const fake = createFakeTranslator();
  const requests: ProviderRequest[] = [];
  const texts: TextRequest[] = [];
  return {
    name: "fake",
    requests,
    texts,
    async translate(request) {
      requests.push(request);
      return (await answer(request, requests.length - 1)) ?? (await fake.translate(request));
    },
    generateText(request): Promise<TextResult> {
      texts.push(request);
      return fake.generateText(request);
    },
    listModels: () => Promise.resolve(["model-a", "model-b"]),
  };
}

/** A result with an answer, as a provider gives it. */
export function answered(answer: unknown): ProviderResult {
  return {
    answer,
    usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 5 },
    durationMs: 7,
  };
}

/**
 * A provider that holds every request until the test releases it: `started` resolves when a
 * request arrives.
 */
export function heldProvider(): ScriptedProvider & {
  started: Promise<void>;
  release(): void;
} {
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const provider = scriptedProvider(async () => {
    arrived.resolve();
    await gate.promise;
    return undefined;
  });
  return Object.assign(provider, { started: arrived.promise, release: () => gate.resolve() });
}
