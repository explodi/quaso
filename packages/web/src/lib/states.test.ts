// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(colourOf(null)).toBe("red");
  expect(colourOf(translation())).toBe("green");
  expect(colourOf(translation({ colour: "blue" }))).toBe("blue");
  expect(flagsOf({ translation: translation({ outdated: true }), pending: 2 })).toStrictEqual({
    outdated: true,
    pending: 2,
    qa: false,
  });
  expect(
    stateSentence({
      translation: translation({ outdated: true, qa: { errors: 1, warnings: 0 } }),
      pending: 1,
    }),
  ).toBe("Translated, outdated, 1 pending, QA problems");
  expect(stateSentence({ translation: null, pending: 0 })).toBe("Untranslated");
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
  expect(isCompleted(progress())).toBe(true);
  expect(isCompleted(progress({ untranslated: 1 }))).toBe(false);
  expect(isCompleted(progress({ outdated: 1 }))).toBe(false);
  expect(isCompleted(progress({ qa: 1 }))).toBe(false);
  expect(isCompleted(progress({ strings: 0 }))).toBe(false);
  expect(filterCount(progress(), "blue")).toBe(6);
  expect(filterCount(progress(), "pending")).toBe(1);
});
