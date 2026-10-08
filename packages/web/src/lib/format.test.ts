// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
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
  assertEquals(formatNumber(5800), "5,800");
  assertEquals(count(1, "word"), "1 word");
  assertEquals(count(1200, "string"), "1,200 strings");
  assertEquals(count(2, "entry", "entries"), "2 entries");
  assertEquals(formatPercent(45.9), "45%");
  assertEquals(formatPercent(120), "100%");
  assertEquals(
    progressText({ translatedPercent: 45, proofreadPercent: 10 }),
    "45% translated • 10% proofread",
  );
  assertEquals(wordsLeftText({ wordsLeft: 0 }), "Nothing left");
  assertEquals(wordsLeftText({ wordsLeft: 1 }), "1 word left");
  assertEquals(wordsLeftText({ wordsLeft: 1234 }), "1,234 words left");
});

test("relative dates", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  assertEquals(formatRelative(now - 10_000, now), "just now");
  assertEquals(formatRelative(now - 5 * 60_000, now), "5 minutes ago");
  assertEquals(formatRelative(now - 3 * 3600_000, now), "3 hours ago");
  assertEquals(formatRelative(now - 24 * 3600_000, now), "yesterday");
  assertEquals(formatRelative(now - 3 * 24 * 3600_000, now), "3 days ago");
  assertEquals(formatRelative(now - 400 * 24 * 3600_000, now), "last year");
  assertEquals(formatRelative(now + 2 * 60_000, now), "in 2 minutes");
});

test("language names and values", () => {
  assertEquals(languageLabel("de"), "German");
  assertEquals(languageLabel("pt-BR"), "Portuguese (Brazil)");
  assertEquals(valueText("Hallo"), "Hallo");
  assertEquals(
    valueText({ one: "1 Münze", other: "{{count}} Münzen" }),
    "one: 1 Münze · other: {{count}} Münzen",
  );
  assertEquals(valueText(null), "");
  assertEquals(
    sourcePreview({ one: "{{count}} coin", other: "{{count}} coins" }),
    "{{count}} coins",
  );
  assertEquals(sourcePreview("Play"), "Play");
});
