// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import {
  count,
  formatNumber,
  formatPercent,
  formatRelative,
  languageLabel,
  progressText,
  sourcePreview,
  valueText,
  wordsLeftText,
} from "./format.ts";

test("numbers, counts and percentages", () => {
  expect(formatNumber(5800)).toBe("5,800");
  expect(count(1, "word")).toBe("1 word");
  expect(count(1200, "string")).toBe("1,200 strings");
  expect(count(2, "entry", "entries")).toBe("2 entries");
  expect(formatPercent(45.9)).toBe("45%");
  expect(formatPercent(120)).toBe("100%");
  expect(progressText({ translatedPercent: 45, proofreadPercent: 10 })).toStrictEqual(
    "45% translated • 10% proofread",
  );
  expect(wordsLeftText({ wordsLeft: 0 })).toBe("Nothing left");
  expect(wordsLeftText({ wordsLeft: 1 })).toBe("1 word left");
  expect(wordsLeftText({ wordsLeft: 1234 })).toBe("1,234 words left");
});

test("relative dates", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  expect(formatRelative(now - 10_000, now)).toBe("just now");
  expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
  expect(formatRelative(now - 3 * 3600_000, now)).toBe("3 hours ago");
  expect(formatRelative(now - 24 * 3600_000, now)).toBe("yesterday");
  expect(formatRelative(now - 3 * 24 * 3600_000, now)).toBe("3 days ago");
  expect(formatRelative(now - 400 * 24 * 3600_000, now)).toBe("last year");
  expect(formatRelative(now + 2 * 60_000, now)).toBe("in 2 minutes");
});

test("language names and values", () => {
  expect(languageLabel("de")).toBe("German");
  expect(languageLabel("pt-BR")).toBe("Portuguese (Brazil)");
  expect(valueText("Hallo")).toBe("Hallo");
  expect(valueText({ one: "1 Münze", other: "{{count}} Münzen" })).toStrictEqual(
    "one: 1 Münze · other: {{count}} Münzen",
  );
  expect(valueText(null)).toBe("");
  expect(sourcePreview({ one: "{{count}} coin", other: "{{count}} coins" })).toStrictEqual(
    "{{count}} coins",
  );
  expect(sourcePreview("Play")).toBe("Play");
});
