// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { checkTranslation } from "./checks.ts";
import { glossaryMatches } from "./glossary.ts";

test("glossary: Unicode boundaries, phrases, punctuation, case and canonical equivalents", () => {
  assertEquals(glossaryMatches("endgame game games GAME", "game"), [
    { start: 8, end: 12 },
    {
      start: 19,
      end: 23,
    },
  ]);
  assertEquals(glossaryMatches("New York, not New Yorkshire", "New York"), [{ start: 0, end: 8 }]);
  assertEquals(glossaryMatches("Quaso quaso", "Quaso", true), [{ start: 0, end: 5 }]);
  assertEquals(glossaryMatches("Cafe\u0301", "café"), [{ start: 0, end: 5 }]);
  assertEquals(glossaryMatches("Try C++!", "C++"), [{ start: 4, end: 7 }]);
  assertEquals(glossaryMatches("nothing", ""), []);
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
  assertEquals(
    checks("The game in Quaso", "Die Anwendung").map((c) => [c.value, c.severity]),
    [
      ["game", "warning"],
      ["Quaso", "warning"],
    ],
  );
  assertEquals(checks("The game in Quaso", "Das SPIEL in QUASO"), []);
  assertEquals(checks("endgame with quaso", "Eine Anwendung"), []);
  assertEquals(checks("The game", ""), [], "empty values only report the empty error");
});

test("glossary QA: each plural form uses its corresponding source", () => {
  const checks = checkTranslation({
    kind: "plural",
    source: { one: "A game", other: "Many games" },
    translation: { one: "Eine Anwendung", other: "Viele Anwendungen" },
    language: "de",
    glossary: [{ term: "game", translation: "Spiel", kind: "translate" }],
  });
  assertEquals(
    checks.filter((c) => c.check === "glossary").map((c) => c.form),
    ["one"],
  );
});
