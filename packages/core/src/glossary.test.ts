// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { checkTranslation } from "./checks.ts";
import { glossaryMatches } from "./glossary.ts";

test("glossary: Unicode boundaries, phrases, punctuation, case and canonical equivalents", () => {
  expect(glossaryMatches("endgame game games GAME", "game")).toStrictEqual([
    { start: 8, end: 12 },
    {
      start: 19,
      end: 23,
    },
  ]);
  expect(glossaryMatches("New York, not New Yorkshire", "New York")).toStrictEqual([
    { start: 0, end: 8 },
  ]);
  expect(glossaryMatches("Quaso quaso", "Quaso", true)).toStrictEqual([{ start: 0, end: 5 }]);
  expect(glossaryMatches("Cafe\u0301", "café")).toStrictEqual([{ start: 0, end: 5 }]);
  expect(glossaryMatches("Try C++!", "C++")).toStrictEqual([{ start: 4, end: 7 }]);
  expect(glossaryMatches("nothing", "")).toStrictEqual([]);
});

test("glossary QA: translated and kept terms warn, never block, and respect English whole words", () => {
  const glossary = [
    { term: "game", translation: "Spiel", kind: "translate" as const },
    { term: "Quaso", kind: "keep" as const, caseSensitive: true },
  ];
  const checks = (source: string, translation: string) =>
    checkTranslation({ kind: "text", source, translation, language: "de", glossary }).filter(
      (c) => c.check === "glossary",
    );
  expect(
    checks("The game in Quaso", "Die Anwendung").map((c) => [c.value, c.severity]),
  ).toStrictEqual([
    ["game", "warning"],
    ["Quaso", "warning"],
  ]);
  expect(checks("The game in Quaso", "Das SPIEL in QUASO")).toStrictEqual([]);
  expect(checks("endgame with quaso", "Eine Anwendung")).toStrictEqual([]);
  expect(checks("The game", ""), "empty values only report the empty error").toStrictEqual([]);
});

test("glossary QA: each plural form uses its corresponding source", () => {
  const checks = checkTranslation({
    kind: "plural",
    source: { one: "A game", other: "Many games" },
    translation: { one: "Eine Anwendung", other: "Viele Anwendungen" },
    language: "de",
    glossary: [{ term: "game", translation: "Spiel", kind: "translate" }],
  });
  expect(checks.filter((c) => c.check === "glossary").map((c) => c.form)).toStrictEqual(["one"]);
});
