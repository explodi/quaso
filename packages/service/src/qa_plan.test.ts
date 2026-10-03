// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
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
  kind: "text",
  source: '"Hello"',
  max_length: null,
};

test("QA plan leaves unchanged counts alone", () => {
  assertEquals(planQa([ROW], FACTS), []);
});

test("QA plan catches a placeholder added to the source without changing the translation", () => {
  const row = { ...ROW, source: '"Hello {{name}}"' };
  const statements = planQa([row], FACTS);
  assertEquals(statements[0].params, [1, 0, 1, "de"]);
  assertEquals(row.value, '"Hallo"');
  assertEquals(row.qa_errors, 0);
});

test("QA plan applies a new length limit and clears counts when it is removed", () => {
  assertEquals(planQa([{ ...ROW, max_length: 3 }], FACTS)[0].params, [1, 0, 1, "de"]);
  assertEquals(planQa([{ ...ROW, qa_errors: 1 }], FACTS)[0].params, [0, 0, 1, "de"]);
});

test("QA plan counts warnings separately from errors", () => {
  assertEquals(planQa([{ ...ROW, value: ROW.source }], FACTS)[0].params, [0, 1, 1, "de"]);
});

test("QA plan uses the project's interpolation syntax", () => {
  const facts = { ...FACTS, syntax: { prefix: "%", suffix: "%" } };
  const row = { ...ROW, source: '"Hello %name%"' };
  assertEquals(planQa([row], facts)[0].params, [1, 0, 1, "de"]);
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
  assertEquals(planQa([row], facts)[0].params, [0, 0, 1, "de"]);
});
