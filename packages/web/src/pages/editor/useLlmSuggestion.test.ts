// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { LlmSuggestionsResult } from "@quaso/core";
import { ApiError } from "../../lib/api.ts";
import { type SuggestionTarget, SuggestionCache, stringsToAsk } from "./useLlmSuggestion.ts";

const STRING = (id: number): SuggestionTarget => ({ id, source: `English ${id}` });
/** The open string, 1, and the nine after it. */
const OPEN_AND_NEXT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(STRING);
const NO_WAIT = () => Promise.resolve();

const covering =
  (...ids: number[]) =>
  (id: number) =>
    ids.includes(id);

/** An `ask` that answers every string, except those with a reason to fail, and keeps count. */
function answering(failures: Record<number, string> = {}) {
  const asked: { language: string; ids: number[] }[] = [];
  const ask = (language: string, ids: number[]): Promise<LlmSuggestionsResult> => {
    asked.push({ language, ids });
    return Promise.resolve({
      suggestions: ids
        .filter((id) => !(id in failures))
        .map((id) => ({ id, value: `${language} ${id}`, model: "m" })),
      failed: ids.filter((id) => id in failures).map((id) => ({ id, message: failures[id] })),
    });
  };
  return { ask, asked };
}

test("with nothing answered yet, it asks about the open string and the next three", () => {
  expect(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering())).toStrictEqual([1, 2, 3, 4]);
});

test("while six answers wait ahead, it asks about nothing", () => {
  expect(
    stringsToAsk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], covering(1, 2, 3, 4, 5, 6, 7)),
  ).toStrictEqual([]);
});

test("when fewer than six answers wait ahead, it asks about the next four", () => {
  expect(stringsToAsk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], covering(1, 2, 3, 4, 5, 6))).toStrictEqual([
    7, 8, 9, 10,
  ]);
});

test("without an answer for the open string, it asks for it first, even with answers ahead", () => {
  expect(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering(2, 3, 4))).toStrictEqual([1, 5, 6, 7]);
});

test("with no strings, it asks about nothing", () => {
  expect(stringsToAsk([], covering())).toStrictEqual([]);
});

test("the cache asks about the open string and the next seven, four to a request", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  expect(asked).toStrictEqual([
    { language: "de", ids: [1, 2, 3, 4] },
    { language: "de", ids: [5, 6, 7, 8] },
  ]);
  expect(cache.stateOf("de", STRING(1))).toStrictEqual({
    status: "ready",
    suggestion: { id: 1, value: "de 1", model: "m" },
  });
  expect(cache.stateOf("de", STRING(9))).toBe(undefined);
});

test("moving on while six answers wait ahead asks about nothing", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  await cache.askFor("de", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(STRING));
  expect(asked.length).toBe(2);
});

test("moving on when fewer than six answers wait ahead asks about the next four", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  await cache.askFor("de", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(STRING));
  await cache.askFor("de", [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(STRING));
  expect(asked[2]).toStrictEqual({ language: "de", ids: [9, 10, 11, 12] });
});

test("a string the LLM couldn't translate fails, with the reason", async () => {
  const { ask } = answering({ 2: "It fails the checks." });
  const cache = new SuggestionCache(ask, () => 1_000);
  await cache.askFor("de", OPEN_AND_NEXT);
  expect(cache.stateOf("de", STRING(2))).toStrictEqual({
    status: "failed",
    message: "It fails the checks.",
    failedAt: 1_000,
  });
});

test("a request that fails fails each of its strings", async () => {
  const ask = () => Promise.reject(new ApiError(503, "unavailable", "The LLM is down."));
  const cache = new SuggestionCache(ask, () => 1_000, NO_WAIT);
  await cache.askFor("de", [1, 2, 3, 4].map(STRING));
  expect(cache.stateOf("de", STRING(1))).toStrictEqual({
    status: "failed",
    message: "The LLM is down.",
    failedAt: 1_000,
  });
  expect(cache.stateOf("de", STRING(4))).toStrictEqual({
    status: "failed",
    message: "The LLM is down.",
    failedAt: 1_000,
  });
});

test("a request the server couldn't answer is sent again three times, waiting longer each time", async () => {
  let asked = 0;
  const ask = () => {
    asked++;
    return Promise.reject(new ApiError(503, "unavailable", "The project is busy."));
  };
  const waits: number[] = [];
  const wait = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const cache = new SuggestionCache(ask, () => 1_000, wait);
  await cache.askFor("de", [STRING(1)]);
  expect(asked).toBe(4);
  expect(waits).toStrictEqual([1_000, 2_000, 4_000]);
});

test("a request answered on a retry gives its suggestions", async () => {
  const { ask: answer } = answering();
  let busy = true;
  const ask = (language: string, ids: number[]) => {
    if (!busy) return answer(language, ids);
    busy = false;
    return Promise.reject(new ApiError(503, "unavailable", "The project is busy."));
  };
  const cache = new SuggestionCache(ask, () => 1_000, NO_WAIT);
  await cache.askFor("de", [STRING(1)]);
  expect(cache.stateOf("de", STRING(1))).toStrictEqual({
    status: "ready",
    suggestion: { id: 1, value: "de 1", model: "m" },
  });
});

test("a request the server refused isn't sent again", async () => {
  let asked = 0;
  const ask = () => {
    asked++;
    return Promise.reject(new ApiError(403, "forbidden", "No."));
  };
  const cache = new SuggestionCache(ask, () => 1_000, NO_WAIT);
  await cache.askFor("de", [STRING(1)]);
  expect(asked).toBe(1);
});

test("a failed string is asked about again after half a minute, not before", async () => {
  let now = 1_000;
  const { ask, asked } = answering({ 1: "No." });
  const cache = new SuggestionCache(ask, () => now);
  await cache.askFor("de", [STRING(1)]);
  now += 29_999;
  await cache.askFor("de", [STRING(1)]);
  expect(asked.length).toBe(1);
  now += 1;
  await cache.askFor("de", [STRING(1)]);
  expect(asked.length).toBe(2);
});

test("the same string with other English is a new question", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", [{ id: 1, source: "Old English" }]);
  await cache.askFor("de", [{ id: 1, source: "New English" }]);
  expect(asked.length).toBe(2);
});

test("the same string in another language is a new question", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", [STRING(1)]);
  await cache.askFor("fr", [STRING(1)]);
  expect(asked.map((request) => request.language)).toStrictEqual(["de", "fr"]);
});

test("those waiting hear when the request starts and when it ends", async () => {
  const { ask } = answering();
  const cache = new SuggestionCache(ask);
  let heard = 0;
  cache.subscribe(() => heard++);
  await cache.askFor("de", [STRING(1)]);
  expect(heard).toBe(2);
});
