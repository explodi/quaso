// SPDX-License-Identifier: MIT
/**
 * The editor's LLM suggestions: while someone types a translation, the LLM translates the
 * same string in the background, and its answer is offered next to the input. Asking never
 * delays the editor: the request starts when the string opens, and the panel shows the
 * answer whenever it comes.
 */
import type { LlmSuggestion } from "@quaso/core";
import { useCallback, useEffect, useState } from "react";
import { suggestWithLlm } from "../../lib/api.ts";

export type LlmSuggestionState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; suggestion: LlmSuggestion }
  | { status: "failed"; message: string };

/**
 * Answers by language and string, while the page stays open: going back to a string shows
 * its suggestion at once, without paying for another request. Failures are dropped, so that
 * the next visit asks again.
 */
const answers = new Map<string, Promise<LlmSuggestion>>();

function ask(id: number, language: string): Promise<LlmSuggestion> {
  const key = `${language}:${id}`;
  let answer = answers.get(key);
  if (answer === undefined) {
    answer = suggestWithLlm(id, language);
    answers.set(key, answer);
    answer.catch(() => answers.delete(key));
  }
  return answer;
}

export function useLlmSuggestion(
  id: number,
  language: string,
  wanted: boolean,
): LlmSuggestionState {
  const key = `${language}:${id}`;
  // The answer, with the string it is for: until the answer for this string comes, it is loading.
  const [settled, setSettled] = useState<{ key: string; state: LlmSuggestionState } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    // The request goes on after the person moves to another string: its answer waits in
    // `answers` for their return.
    let shown = true;
    ask(id, language).then(
      (suggestion) => {
        if (shown) setSettled({ key, state: { status: "ready", suggestion } });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (shown) setSettled({ key, state: { status: "failed", message } });
      },
    );
    return () => {
      shown = false;
    };
  }, [id, language, key, wanted]);
  if (!wanted) return { status: "off" };
  if (settled?.key !== key) return { status: "loading" };
  return settled.state;
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
