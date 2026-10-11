// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { LlmSuggestionsResult } from "@quaso/core";
import { ApiError } from "../../lib/api.ts";
import { type SuggestionTarget, SuggestionCache, stringsToAsk } from "./useLlmSuggestion.ts";

const STRING = (id: number): SuggestionTarget => ({ id, source: `English ${id}` });
/** The open string, 1, and the six after it. */
const OPEN_AND_NEXT = [1, 2, 3, 4, 5, 6, 7].map(STRING);

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
  assertEquals(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering()), [1, 2, 3, 4]);
});

test("while three answers wait ahead, it asks about nothing", () => {
  assertEquals(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering(1, 2, 3, 4)), []);
});

test("when fewer than three answers wait ahead, it asks about the next four", () => {
  assertEquals(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering(1, 2, 3)), [4, 5, 6, 7]);
});

test("without an answer for the open string, it asks for it first, even with answers ahead", () => {
  assertEquals(stringsToAsk([1, 2, 3, 4, 5, 6, 7], covering(2, 3, 4)), [1, 5, 6, 7]);
});

test("with no strings, it asks about nothing", () => {
  assertEquals(stringsToAsk([], covering()), []);
});

test("the cache asks about the open string and the next three in one request", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  assertEquals(asked, [{ language: "de", ids: [1, 2, 3, 4] }]);
  assertEquals(cache.stateOf("de", STRING(1)), {
    status: "ready",
    suggestion: { id: 1, value: "de 1", model: "m" },
  });
  assertEquals(cache.stateOf("de", STRING(5)), undefined);
});

test("moving to the next string asks about the next four", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  await cache.askFor("de", [2, 3, 4, 5, 6, 7, 8].map(STRING));
  assertEquals(asked[1], { language: "de", ids: [5, 6, 7, 8] });
});

test("moving on while enough answers wait ahead asks about nothing", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", OPEN_AND_NEXT);
  await cache.askFor("de", [2, 3, 4, 5, 6, 7, 8].map(STRING));
  await cache.askFor("de", [3, 4, 5, 6, 7, 8, 9].map(STRING));
  assertEquals(asked.length, 2);
});

test("a string the LLM couldn't translate fails, with the reason", async () => {
  const { ask } = answering({ 2: "It fails the checks." });
  const cache = new SuggestionCache(ask, () => 1_000);
  await cache.askFor("de", OPEN_AND_NEXT);
  assertEquals(cache.stateOf("de", STRING(2)), {
    status: "failed",
    message: "It fails the checks.",
    failedAt: 1_000,
  });
});

test("a request that fails fails each of its strings", async () => {
  const ask = () => Promise.reject(new ApiError(503, "unavailable", "The LLM is down."));
  const cache = new SuggestionCache(ask, () => 1_000);
  await cache.askFor("de", OPEN_AND_NEXT);
  assertEquals(cache.stateOf("de", STRING(1)), {
    status: "failed",
    message: "The LLM is down.",
    failedAt: 1_000,
  });
  assertEquals(cache.stateOf("de", STRING(4)), {
    status: "failed",
    message: "The LLM is down.",
    failedAt: 1_000,
  });
});

test("a failed string is asked about again after half a minute, not before", async () => {
  let now = 1_000;
  const { ask, asked } = answering({ 1: "No." });
  const cache = new SuggestionCache(ask, () => now);
  await cache.askFor("de", [STRING(1)]);
  now += 29_999;
  await cache.askFor("de", [STRING(1)]);
  assertEquals(asked.length, 1);
  now += 1;
  await cache.askFor("de", [STRING(1)]);
  assertEquals(asked.length, 2);
});

test("the same string with other English is a new question", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", [{ id: 1, source: "Old English" }]);
  await cache.askFor("de", [{ id: 1, source: "New English" }]);
  assertEquals(asked.length, 2);
});

test("the same string in another language is a new question", async () => {
  const { ask, asked } = answering();
  const cache = new SuggestionCache(ask);
  await cache.askFor("de", [STRING(1)]);
  await cache.askFor("fr", [STRING(1)]);
  assertEquals(
    asked.map((request) => request.language),
    ["de", "fr"],
  );
});

test("those waiting hear when the request starts and when it ends", async () => {
  const { ask } = answering();
  const cache = new SuggestionCache(ask);
  let heard = 0;
  cache.subscribe(() => heard++);
  await cache.askFor("de", OPEN_AND_NEXT);
  assertEquals(heard, 2);
});
