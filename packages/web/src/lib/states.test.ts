// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { Progress, TranslationInfo } from "@quaso/core";
import { colourOf, filterCount, flagsOf, isCompleted, stateSentence } from "./states.ts";

const translation = (patch: Partial<TranslationInfo> = {}): TranslationInfo => ({
  value: "Hallo",
  colour: "green",
  outdated: false,
  revision: 1,
  qa: { errors: 0, warnings: 0 },
  author: { type: "llm", id: null, name: "gemini" },
  approver: null,
  updatedAt: 0,
  ...patch,
});

test("colours and flags", () => {
  assertEquals(colourOf(null), "red");
  assertEquals(colourOf(translation()), "green");
  assertEquals(colourOf(translation({ colour: "blue" })), "blue");
  assertEquals(flagsOf({ translation: translation({ outdated: true }), pending: 2 }), {
    outdated: true,
    pending: 2,
    qa: false,
  });
  assertEquals(
    stateSentence({
      translation: translation({ outdated: true, qa: { errors: 1, warnings: 0 } }),
      pending: 1,
    }),
    "Translated, outdated, 1 pending, QA problems",
  );
  assertEquals(stateSentence({ translation: null, pending: 0 }), "Untranslated");
});

const progress = (patch: Partial<Progress> = {}): Progress => ({
  strings: 10,
  words: 40,
  untranslated: 0,
  green: 4,
  blue: 6,
  outdated: 0,
  pending: 1,
  qa: 0,
  wordsLeft: 0,
  translatedPercent: 100,
  proofreadPercent: 60,
  ...patch,
});

test("completed means translated, up to date and without QA problems", () => {
  assertEquals(isCompleted(progress()), true);
  assertEquals(isCompleted(progress({ untranslated: 1 })), false);
  assertEquals(isCompleted(progress({ outdated: 1 })), false);
  assertEquals(isCompleted(progress({ qa: 1 })), false);
  assertEquals(isCompleted(progress({ strings: 0 })), false);
  assertEquals(filterCount(progress(), "blue"), 6);
  assertEquals(filterCount(progress(), "pending"), 1);
});
