// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { formatIcu, formatIcuParts, icuPreview } from "./icu_format.ts";

const APPLES = "{n, plural, =0 {No apples} one {# apple} other {# apples}}";

test("formatIcu: arguments are printed as given, or as written without a value", () => {
  expect(formatIcu("{name} has {pet}.", { name: "Ada" }, "en")).toBe("Ada has {pet}.");
  expect(formatIcu("Paid {price, number}", {}, "en")).toBe("Paid {price, number}");
});

test("formatIcu: a select block picks the case of the value, else other", () => {
  const text = "{style, select, formal {Good day} casual {Hi} other {Hello}}, {name}!";
  expect(formatIcu(text, { style: "casual", name: "Ada" }, "en")).toBe("Hi, Ada!");
  expect(formatIcu(text, { style: "pirate", name: "Ada" }, "en")).toBe("Hello, Ada!");
  expect(formatIcu(text, { name: "Ada" }, "en")).toBe("Hello, Ada!");
});

test("formatIcu: a plural block takes an exact case first, then the category", () => {
  expect(formatIcu(APPLES, { n: 0 }, "en")).toBe("No apples");
  expect(formatIcu(APPLES, { n: 1 }, "en")).toBe("1 apple");
  expect(formatIcu(APPLES, { n: 7 }, "en")).toBe("7 apples");
});

test("formatIcu: categories are the language's, and # is formatted for it", () => {
  const polish = "{n, plural, one {# jabłko} few {# jabłka} many {# jabłek} other {# jabłka}}";
  expect(formatIcu(polish, { n: 3 }, "pl")).toBe("3 jabłka");
  expect(formatIcu(polish, { n: 5 }, "pl")).toBe("5 jabłek");
  expect(formatIcu(polish, { n: 1.5 }, "pl")).toBe("1,5 jabłka");
  expect(formatIcu("{n, plural, other {# Äpfel}}", { n: 12000 }, "de")).toStrictEqual(
    "12.000 Äpfel",
  );
});

test("formatIcu: a missing category falls back to other", () => {
  const text = "{n, plural, one {# manzana} other {# manzanas}}";
  expect(formatIcu(text, { n: 1000000 }, "es")).toBe("1.000.000 manzanas");
});

test("formatIcu: selectordinal uses ordinal categories", () => {
  const text = "{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
  expect(formatIcu(text, { place: 2 }, "en")).toBe("2nd");
  expect(formatIcu(text, { place: 11 }, "en")).toBe("11th");
  expect(formatIcu(text, { place: 23 }, "en")).toBe("23rd");
});

test("formatIcu: # shows the number less the offset; exact cases match the value", () => {
  const text = "{n, plural, offset:1 =1 {Only you} one {You and # other} other {You and # others}}";
  expect(formatIcu(text, { n: 1 }, "en")).toBe("Only you");
  expect(formatIcu(text, { n: 2 }, "en")).toBe("You and 1 other");
  expect(formatIcu(text, { n: 4 }, "en")).toBe("You and 3 others");
});

test("formatIcu: nested blocks", () => {
  const text =
    "{host, select, female {{n, plural, one {She invites # guest} other {She invites # guests}}} other {{n, plural, one {They invite # guest} other {They invite # guests}}}}";
  expect(formatIcu(text, { host: "female", n: 1 }, "en")).toBe("She invites 1 guest");
  expect(formatIcu(text, { host: "male", n: 3 }, "en")).toBe("They invite 3 guests");
});

test("formatIcu: quoted text shows unquoted", () => {
  expect(formatIcu("Type '{'name'}' here, it''s fine", {}, "en")).toStrictEqual(
    "Type {name} here, it's fine",
  );
  expect(formatIcu("l'{name}", { name: "x" }, "fr")).toBe("l{name}");
  expect(formatIcu("{n, plural, other {'#' # times}}", { n: 2 }, "en")).toBe("# 2 times");
});

test("formatIcuParts: text, arguments and numbers apart", () => {
  expect(
    formatIcuParts("{n, plural, one {{host} invites # guest} other {}}", { n: 1 }, "en"),
  ).toStrictEqual([
    { type: "argument", text: "{host}" },
    { type: "text", text: " invites " },
    { type: "number", text: "1" },
    { type: "text", text: " guest" },
  ]);
});

test("icuPreview: every select case, with other", () => {
  const preview = icuPreview("{style, select, formal {Good day} other {Hello}}!", "en");
  expect(preview.rows.map((row) => [row.choices, row.parts])).toStrictEqual([
    [[{ argument: "style", key: "formal" }], [{ type: "text", text: "Good day!" }]],
    [[{ argument: "style", key: "other" }], [{ type: "text", text: "Hello!" }]],
  ]);
  expect(preview.truncated).toBe(false);
});

test("icuPreview: exact cases, then one number per category of the language", () => {
  const spanish =
    "{n, plural, =0 {Ninguna} one {# manzana} many {# de manzanas} other {# manzanas}}";
  const rows = icuPreview(spanish, "es").rows;
  expect(rows.map((row) => row.choices)).toStrictEqual([
    [{ argument: "n", key: "=0", number: 0 }],
    [{ argument: "n", key: "one", number: 1 }],
    [{ argument: "n", key: "many", number: 1000000 }],
    [{ argument: "n", key: "other", number: 2 }],
  ]);
  expect(rows.map((row) => row.parts.map((part) => part.text).join(""))).toStrictEqual([
    "Ninguna",
    "1 manzana",
    "1.000.000 de manzanas",
    "2 manzanas",
  ]);
});

test("icuPreview: a category the translation lacks shows what the app shows, other", () => {
  const rows = icuPreview("{n, plural, one {# manzana} other {# manzanas}}", "es").rows;
  expect(rows[1].choices).toStrictEqual([{ argument: "n", key: "many", number: 1000000 }]);
  expect(rows[1].parts.map((part) => part.text).join("")).toBe("1.000.000 manzanas");
});

test("icuPreview: ordinal categories", () => {
  const rows = icuPreview("{p, selectordinal, other {#.}}", "de").rows;
  expect(rows.map((row) => row.choices)).toStrictEqual([
    [{ argument: "p", key: "other", number: 1 }],
  ]);
});

test("icuPreview: a nested block adds its cases to the rows of its case", () => {
  const text = "{host, select, female {{n, plural, one {Ella, #} other {Ellas, #}}} other {Todos}}";
  const rows = icuPreview(text, "en").rows;
  expect(rows.map((row) => row.choices.map((choice) => choice.key))).toStrictEqual([
    ["female", "one"],
    ["female", "other"],
    ["other"],
  ]);
  expect(rows[1].parts.map((part) => part.text).join("")).toBe("Ellas, 0");
});

test("icuPreview: a block on an argument already chosen follows that choice", () => {
  const text = "{a, select, x {X} other {O}}-{a, select, x {x} other {o}}";
  const rows = icuPreview(text, "en").rows;
  expect(rows.map((row) => row.parts.map((part) => part.text).join(""))).toStrictEqual([
    "X-x",
    "O-o",
  ]);
});

test("icuPreview: without blocks, one row", () => {
  expect(icuPreview("Hello, {name}!", "en").rows).toStrictEqual([
    {
      choices: [],
      parts: [
        { type: "text", text: "Hello, " },
        { type: "argument", text: "{name}" },
        { type: "text", text: "!" },
      ],
    },
  ]);
});

test("icuPreview: at most `limit` rows", () => {
  const text = "{a, select, x {1} y {2} other {3}} {b, select, x {1} y {2} other {3}}";
  const preview = icuPreview(text, "en", undefined, 4);
  expect(preview.rows.length).toBe(4);
  expect(preview.truncated).toBe(true);
});
