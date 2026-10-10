// SPDX-License-Identifier: MIT
/** Provider requests and retries are shared by the synchronous and async runners. */
import type { ProjectSettings, TextValue } from "@quaso/core";
import type { Facts } from "../facts.ts";
import {
  NO_USAGE,
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type TranslationProvider,
} from "../llm/provider.ts";
import {
  type PromptContext,
  type PromptString,
  renderPrompt,
  responseSchemaFor,
} from "../llm/prompt.ts";
import { checkAnswer } from "../llm/results.ts";
import { checkValue } from "../translations.ts";
import type { Clock } from "../ports.ts";
import { promptString } from "./prompts.ts";
import type { RequestRecord } from "./usage.ts";
import type { Batch } from "./work.ts";
import type { BatchSuccess } from "./write.ts";

export async function translateBatch(input: {
  provider: TranslationProvider;
  settings: ProjectSettings;
  facts: Facts;
  context: PromptContext;
  batch: Batch;
  model: string;
  clock: Clock;
  canRequest(): boolean | Promise<boolean>;
  record(entry: Omit<RequestRecord, "jobId" | "provider">): number | Promise<number>;
  pauseForAuth(error: ProviderError): void | Promise<void>;
}): Promise<{ successes: Map<number, BatchSuccess>; failures: Map<number, string> }> {
  const { provider, settings, facts, context, batch } = input;
  const items = new Map(batch.items.map((item) => [item.stringId, item]));
  const successes = new Map<number, BatchSuccess>();
  const failures = new Map<number, string>();
  const retries = settings.llm.retries;
  const check = (string: PromptString, value: TextValue) =>
    checkValue(
      facts,
      {
        kind: string.kind,
        source: JSON.stringify(items.get(string.id)!.english),
        max_length: string.maxLength,
      },
      batch.language,
      value,
    );

  /** Retries strings that failed as a whole, in two halves (a smaller request may pass). */
  const retryHalves = async (group: PromptString[], reason: string, round: number) => {
    const next = group.map((string) => ({
      ...string,
      refused: { answer: null, reasons: [reason] },
    }));
    const middle = Math.ceil(next.length / 2);
    await attempt(next.slice(0, middle), round + 1);
    if (middle < next.length) await attempt(next.slice(middle), round + 1);
  };

  const attempt = async (group: PromptString[], round: number): Promise<void> => {
    if (group.length === 0 || !(await input.canRequest())) return;
    const rendered = renderPrompt(settings.llm.promptTemplate, group, context);
    const request: ProviderRequest = {
      model: input.model,
      system: rendered.system,
      prompt: rendered.prompt,
      responseSchema: responseSchemaFor(rendered.batch.strings),
      safety: settings.llm.safety,
      batch: rendered.batch,
    };
    const base = { language: batch.language, fileId: batch.fileId, strings: group.length };
    const started = input.clock();
    let result: ProviderResult;
    try {
      result = await provider.translate(request);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      await input.record({
        ...base,
        model: input.model,
        usage: error.usage ?? NO_USAGE,
        durationMs: input.clock() - started,
        outcome: error.kind === "blocked" ? "blocked" : "failed",
        error: error.message,
      });
      if (error.kind === "auth") {
        await input.pauseForAuth(error);
        return;
      }
      const retryable = error.kind === "invalid_answer" || error.kind === "blocked";
      if (retryable && round < retries) return await retryHalves(group, error.message, round);
      for (const string of group) failures.set(string.id, error.message);
      return;
    }
    const model = result.model ?? input.model;
    if (result.blocked !== undefined) {
      await input.record({
        ...base,
        model,
        usage: result.usage,
        durationMs: result.durationMs,
        outcome: "blocked",
        error: `Blocked: ${result.blocked}`,
      });
      const reason = `The answer was blocked by the safety filters (${result.blocked}).`;
      if (round < retries) return await retryHalves(group, reason, round);
      for (const string of group) failures.set(string.id, reason);
      return;
    }
    const checked = checkAnswer(result.answer, group, rendered.masked, check);
    const outcome =
      checked.failed.size === 0 ? "ok" : checked.passed.size === 0 ? "failed" : "partial";
    const requestId = await input.record({
      ...base,
      model,
      usage: result.usage,
      durationMs: result.durationMs,
      outcome,
      error: outcome === "ok" ? null : `${checked.failed.size} of ${group.length} strings failed`,
    });
    for (const [id, passed] of checked.passed) {
      successes.set(id, {
        value: passed.value,
        requestId,
        model,
        ...(passed.ambiguous ? { ambiguous: passed.ambiguous } : {}),
      });
    }
    if (checked.failed.size === 0) return;
    if (round < retries) {
      const next = group
        .filter((string) => checked.failed.has(string.id))
        .map((string) => ({
          ...string,
          refused: checked.failed.get(string.id)!,
        }));
      return await attempt(next, round + 1);
    }
    for (const [id, failed] of checked.failed) failures.set(id, failed.reasons.join(" "));
  };

  await attempt(batch.items.map(promptString), 0);
  return { successes, failures };
}
