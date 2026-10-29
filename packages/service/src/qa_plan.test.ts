// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { DEFAULT_SYNTAX } from "@quaso/core";
import type { Facts } from "./facts.ts";
import { planQa, type QaRow } from "./translations.ts";

const FACTS: Facts = { sourceLanguage: "en", syntax: DEFAULT_SYNTAX, languages: new Map() };
const ROW: QaRow = {
  string_id: 1,
  language: "de",
  value: '"Hallo"',
  qa_errors: 0,
  qa_warnings: 0,
  key: '["greeting"]',
  kind: "text",
  source: '"Hello"',
  max_length: null,
  arguments: null,
};

test("QA plan leaves unchanged counts alone", () => {
  expect(planQa([ROW], FACTS)).toStrictEqual([]);
});

test("QA plan catches a placeholder added to the source without changing the translation", () => {
  const row = { ...ROW, source: '"Hello {{name}}"' };
  const statements = planQa([row], FACTS);
  expect(statements[0].params).toStrictEqual([1, 0, 1, "de"]);
  expect(row.value).toBe('"Hallo"');
  expect(row.qa_errors).toBe(0);
});

test("QA plan applies a new length limit and clears counts when it is removed", () => {
  expect(planQa([{ ...ROW, max_length: 3 }], FACTS)[0].params).toStrictEqual([1, 0, 1, "de"]);
  expect(planQa([{ ...ROW, qa_errors: 1 }], FACTS)[0].params).toStrictEqual([0, 0, 1, "de"]);
});

test("QA plan counts warnings separately from errors", () => {
  expect(planQa([{ ...ROW, value: ROW.source }], FACTS)[0].params).toStrictEqual([0, 1, 1, "de"]);
});

test("QA plan uses the project's interpolation syntax", () => {
  const facts = { ...FACTS, syntax: { prefix: "%", suffix: "%" } };
  const row = { ...ROW, source: '"Hello %name%"' };
  expect(planQa([row], facts)[0].params).toStrictEqual([1, 0, 1, "de"]);
});

test("QA plan applies the arguments a string receives, with ICU MessageFormat", () => {
  const facts = { ...FACTS, syntax: { ...DEFAULT_SYNTAX, icu: true } };
  const row = {
    ...ROW,
    language: "es",
    source: JSON.stringify("Excited to join {company}!"),
    value: JSON.stringify(
      "{authorGender, select, female {¡Emocionada de unirme a {company}!} other {¡Con ganas de unirme a {company}!}}",
    ),
    arguments: JSON.stringify([{ name: "authorGender", cases: ["female"], description: "" }]),
    qa_errors: 1,
  };
  expect(planQa([row], facts)[0].params).toStrictEqual([0, 0, 1, "es"]);
});

test("QA plan uses language plural overrides", () => {
  const facts: Facts = {
    ...FACTS,
    languages: new Map([
      [
        "de",
        { tag: "de", instructions: "", pluralOverride: { cardinal: ["other"] }, createdAt: 0 },
      ],
    ]),
  };
  const row = {
    ...ROW,
    kind: "plural",
    source: '{"one":"One coin","other":"Coins"}',
    value: '{"other":"Münzen"}',
    qa_errors: 1,
  };
  expect(planQa([row], facts)[0].params).toStrictEqual([0, 0, 1, "de"]);
});
