// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { checkTranslation, DEFAULT_SYNTAX, type TextValue } from "@quaso/core";
import { maskString, promptId, type PromptString } from "./prompt.ts";
import { checkAnswer, NO_TRANSLATION } from "./results.ts";

const STRINGS: PromptString[] = [
  {
    id: 1,
    key: "greeting",
    kind: "text",
    english: "Hello, {{name}}!",
    description: "",
    maxLength: 20,
  },
  {
    id: 2,
    key: "coins",
    kind: "plural",
    english: { one: "{{count}} coin", other: "{{count}} coins" },
    description: "",
    maxLength: null,
  },
  {
    id: 3,
    key: "again",
    kind: "text",
    english: "$t(common:play) again",
    description: "",
    maxLength: null,
  },
];

const masked = new Map(
  STRINGS.map((string) => [promptId(string.id), maskString(string, "pl", DEFAULT_SYNTAX)]),
);

function check(string: PromptString, value: TextValue) {
  return checkTranslation({
    kind: string.kind,
    source: string.english,
    translation: value,
    language: "pl",
    maxLength: string.maxLength,
  });
}

const FORMS = {
  one: "{{count}} moneta",
  few: "{{count}} monety",
  many: "{{count}} monet",
  other: "{{count}} monety",
};

test("results: passing answers are unmasked; extra forms and unknown IDs are dropped", () => {
  const result = checkAnswer(
    {
      translations: [
        { id: "s1", text: "Cześć, {{name}}!" },
        { id: "s2", forms: { ...FORMS, zero: "zero" } },
        { id: "s3", text: "⟦1⟧ ponownie" },
        { id: "s99", text: "?" },
        { id: "s1", text: "Ignored: the first answer counts" },
      ],
    },
    STRINGS,
    masked,
    check,
  );
  assertEquals(result.failed.size, 0);
  assertEquals(result.passed.get(1)?.value, "Cześć, {{name}}!");
  assertEquals(result.passed.get(2)?.value, FORMS);
  assertEquals(result.passed.get(3)?.value, "$t(common:play) ponownie");
});

test("results: missing answers, wrong shapes and failed checks, with reasons", () => {
  const result = checkAnswer(
    {
      translations: [
        { id: "s1", text: "Cześć, mój drogi przyjacielu {{name}}!" },
        { id: "s2", text: "{{count}} monet" },
      ],
    },
    STRINGS,
    masked,
    check,
  );
  assertEquals(result.passed.size, 0);
  assertEquals(result.failed.get(1), {
    answer: "Cześć, mój drogi przyjacielu {{name}}!",
    reasons: ["At most 20 characters; this has 38."],
  });
  assertEquals(result.failed.get(2), {
    answer: null,
    reasons: ["Plural forms (one, few, many, other) were expected, but a text was given."],
  });
  assertEquals(result.failed.get(3), { answer: null, reasons: [NO_TRANSLATION] });
});

test("results: a dropped placeholder in the Polish few form is a failure that says so", () => {
  const result = checkAnswer(
    {
      translations: [{ id: "s2", forms: { ...FORMS, few: "kilka monet" } }],
    },
    [STRINGS[1]],
    masked,
    check,
  );
  assertEquals(result.failed.get(2)?.reasons, [
    "Placeholder {{count}} is missing from the few form.",
  ]);
});

test("results: reasons show references as the model saw them", () => {
  const result = checkAnswer(
    { translations: [{ id: "s3", text: "ponownie" }] },
    [STRINGS[2]],
    masked,
    check,
  );
  assertEquals(result.failed.get(3)?.reasons, ["Reference ⟦1⟧ is missing."]);
});

test("results: a length reason counts as the model does, references masked", () => {
  const strings: PromptString[] = [
    {
      id: 4,
      key: "again",
      kind: "text",
      english: "$t(title) again",
      description: "",
      maxLength: 40,
    },
    {
      id: 5,
      key: "lives",
      kind: "plural",
      english: { one: "$t(title): {{count}} life", other: "$t(title): {{count}} lives" },
      description: "",
      maxLength: 30,
    },
  ];
  const masks = new Map(
    strings.map((string) => [promptId(string.id), maskString(string, "de", DEFAULT_SYNTAX)]),
  );
  // "$t(title)" is 9 characters, "⟦1⟧" 3: the prompt gives the model 40 - 6.
  assertEquals(masks.get("s4")?.maxLength, 34);
  assertEquals(masks.get("s5")?.maxLength, 24);
  const long = "⟦1⟧ noch einmal, bitte sehr, liebe Freunde"; // 42 characters
  const result = checkAnswer(
    {
      translations: [
        { id: "s4", text: long },
        {
          id: "s5",
          forms: { one: "⟦1⟧: {{count}} Leben", other: `⟦1⟧: {{count}} ${"x".repeat(20)}` },
        },
      ],
    },
    strings,
    masks,
    (string, value) =>
      checkTranslation({
        kind: string.kind,
        source: string.english,
        translation: value,
        language: "de",
        maxLength: string.maxLength,
      }),
  );
  assertEquals(result.failed.get(4)?.reasons, ["At most 34 characters; this has 42."]);
  assertEquals(result.failed.get(5)?.reasons, ["At most 24 characters; this has 35 (other form)."]);
});

test("results: an answer of the wrong shape fails every string", () => {
  for (const answer of [null, "text", { translations: "no" }, { other: [] }]) {
    const result = checkAnswer(answer, STRINGS, masked, check);
    assertEquals(result.failed.size, 3);
    assertEquals(result.failed.get(1)?.reasons, ["The answer isn't in the expected JSON shape."]);
  }
});
