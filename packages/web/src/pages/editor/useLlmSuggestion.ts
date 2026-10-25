// SPDX-License-Identifier: MIT
/**
 * The editor's LLM suggestions: while someone types a translation, the LLM translates the
 * string in the background, and its answer is offered next to the input. The editor knows
 * which strings come next, so they are asked about too, several to a request: by the time
 * the translator gets to a string, its suggestion is usually there.
 */
import type { LlmSuggestion, LlmSuggestionsResult, TextValue } from "@quaso/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, errorMessage, suggestWithLlm } from "../../lib/api.ts";

/** A string the LLM may be asked about. */
export interface SuggestionTarget {
  id: number;
  /** A suggestion is for the English it was asked about. */
  source: TextValue;
}

export type LlmSuggestionState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; suggestion: LlmSuggestion }
  | { status: "failed"; message: string; failedAt: number };

type Entry = Exclude<LlmSuggestionState, { status: "off" }>;

/** Strings in one request. */
const CHUNK = 4;
/**
 * Ask again when fewer strings than this, after the open one, are answered or on their way:
 * an answer takes several strings' worth of the translator's time to arrive.
 */
const REFILL_BELOW = 6;
/** How many strings after the open one the editor hands over: enough for a refill to fill its request. */
export const LOOKAHEAD = REFILL_BELOW - 1 + CHUNK;
/** How long the person stays on a string before the LLM is asked: skimming past costs nothing. */
const ASK_DELAY_MS = 500;
/** A string that got no suggestion isn't asked about again for this long. */
const RETRY_AFTER_MS = 30_000;
/** A request the server couldn't answer, busy or out of reach, is sent again this many times. */
const REQUEST_RETRIES = 3;
/** The wait before the first of those, doubled before each next one. */
const REQUEST_RETRY_DELAY_MS = 1_000;

const OFF: LlmSuggestionState = { status: "off" };
const LOADING: Entry = { status: "loading" };

/**
 * Which of the open string and those after it to ask the LLM about now, in one request. It
 * waits until the open string has no answer, or the answers ahead run low, so that a request
 * carries `CHUNK` strings rather than one.
 */
export function stringsToAsk<T>(openAndNext: T[], covered: (string: T) => boolean): T[] {
  if (openAndNext.length === 0) return [];
  const [open, ...ahead] = openAndNext;
  const openNeedsAnswer = !covered(open);
  const firstUncoveredAhead = ahead.findIndex((string) => !covered(string));
  const coveredAhead = firstUncoveredAhead === -1 ? ahead.length : firstUncoveredAhead;
  const aheadRunsLow = coveredAhead < REFILL_BELOW;
  if (!openNeedsAnswer && !aheadRunsLow) return [];
  return openAndNext.filter((string) => !covered(string)).slice(0, CHUNK);
}

function keyOf(language: string, string: SuggestionTarget): string {
  return `${language}:${string.id}:${JSON.stringify(string.source)}`;
}

/** The suggestions asked for so far, by language, string and English, and who waits for them. */
export class SuggestionCache {
  readonly #ask: (language: string, ids: number[]) => Promise<LlmSuggestionsResult>;
  readonly #now: () => number;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  constructor(
    ask: (language: string, ids: number[]) => Promise<LlmSuggestionsResult>,
    now: () => number = Date.now,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.#ask = ask;
    this.#now = now;
    this.#wait = wait;
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** What is known about the string, when it was asked about. */
  stateOf(language: string, string: SuggestionTarget): LlmSuggestionState | undefined {
    return this.#entries.get(keyOf(language, string));
  }

  /**
   * Asks about what the open string and those after it need, in as many requests as it takes to
   * cover them, sent together, and settles when the answers come.
   */
  async askFor(language: string, openAndNext: SuggestionTarget[]): Promise<void> {
    const requests: Promise<void>[] = [];
    for (;;) {
      const strings = stringsToAsk(openAndNext, (string) => this.#isCovered(language, string));
      if (strings.length === 0) break;
      for (const string of strings) this.#entries.set(keyOf(language, string), LOADING);
      requests.push(this.#request(language, strings));
    }
    if (requests.length === 0) return;
    this.#notify();
    await Promise.all(requests);
  }

  async #request(language: string, strings: SuggestionTarget[]): Promise<void> {
    try {
      const result = await this.#askWithRetries(
        language,
        strings.map((string) => string.id),
      );
      this.#settle(language, strings, result);
    } catch (error) {
      const message = errorMessage(error);
      const failed = strings.map((string) => ({ id: string.id, message }));
      this.#settle(language, strings, { suggestions: [], failed });
    }
    this.#notify();
  }

  /** The strings stay loading while a request the server couldn't answer is sent again. */
  async #askWithRetries(language: string, ids: number[]): Promise<LlmSuggestionsResult> {
    for (let retry = 0; ; retry++) {
      try {
        return await this.#ask(language, ids);
      } catch (error) {
        const serverUnavailable = error instanceof ApiError && error.code === "unavailable";
        if (!serverUnavailable || retry === REQUEST_RETRIES) throw error;
        await this.#wait(REQUEST_RETRY_DELAY_MS * 2 ** retry);
      }
    }
  }

  /** Whether the string has an answer, is waiting for one, or failed too recently to ask again. */
  #isCovered(language: string, string: SuggestionTarget): boolean {
    const entry = this.#entries.get(keyOf(language, string));
    if (entry === undefined) return false;
    if (entry.status !== "failed") return true;
    return this.#now() - entry.failedAt < RETRY_AFTER_MS;
  }

  #settle(language: string, strings: SuggestionTarget[], result: LlmSuggestionsResult): void {
    const suggestions = new Map(
      result.suggestions.map((suggestion) => [suggestion.id, suggestion]),
    );
    const reasons = new Map(result.failed.map((failure) => [failure.id, failure.message]));
    for (const string of strings) {
      const suggestion = suggestions.get(string.id);
      this.#entries.set(
        keyOf(language, string),
        suggestion
          ? { status: "ready", suggestion }
          : {
              status: "failed",
              message: reasons.get(string.id) ?? "The LLM sent no suggestion.",
              failedAt: this.#now(),
            },
      );
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** One for the page's lifetime: going back to a string shows its suggestion at once. */
const cache = new SuggestionCache(suggestWithLlm);

/**
 * The LLM's suggestion for the open string. While it is `wanted`, the open string and the ones
 * after it are asked about, once the person has stayed on it a moment.
 */
export function useLlmSuggestion(
  language: string,
  open: SuggestionTarget,
  upcoming: SuggestionTarget[],
  wanted: boolean,
): LlmSuggestionState {
  const state = useSyncExternalStore(cache.subscribe, () => cache.stateOf(language, open));
  const openAndNext = [open, ...upcoming];
  const openAndNextKey = openAndNext.map((string) => keyOf(language, string)).join("\n");
  useEffect(() => {
    if (!wanted) return;
    const timer = setTimeout(() => cache.askFor(language, openAndNext), ASK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [language, wanted, openAndNextKey]);
  if (!wanted) return OFF;
  return state ?? LOADING;
}

const PREFERENCE = "quaso:llm-suggestions";

/** Whether the person turned LLM suggestions on, remembered in this browser. Off at first. */
export function useLlmSuggestionsPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(PREFERENCE) === "on";
    } catch {
      // Private windows may disable storage: suggestions start off.
      return false;
    }
  });
  const change = useCallback((next: boolean) => {
    setOn(next);
    try {
      globalThis.localStorage?.setItem(PREFERENCE, next ? "on" : "off");
    } catch {
      // The choice still holds while the page stays open.
    }
  }, []);
  return [on, change];
}
