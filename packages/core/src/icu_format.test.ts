// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { formatIcu, formatIcuParts, icuPreview } from "./icu_format.ts";

const APPLES = "{n, plural, =0 {No apples} one {# apple} other {# apples}}";

test("formatIcu: arguments are printed as given, or as written without a value", () => {
  assertEquals(formatIcu("{name} has {pet}.", { name: "Ada" }, "en"), "Ada has {pet}.");
  assertEquals(formatIcu("Paid {price, number}", {}, "en"), "Paid {price, number}");
});

test("formatIcu: a select block picks the case of the value, else other", () => {
  const text = "{style, select, formal {Good day} casual {Hi} other {Hello}}, {name}!";
  assertEquals(formatIcu(text, { style: "casual", name: "Ada" }, "en"), "Hi, Ada!");
  assertEquals(formatIcu(text, { style: "pirate", name: "Ada" }, "en"), "Hello, Ada!");
  assertEquals(formatIcu(text, { name: "Ada" }, "en"), "Hello, Ada!");
});

test("formatIcu: a plural block takes an exact case first, then the category", () => {
  assertEquals(formatIcu(APPLES, { n: 0 }, "en"), "No apples");
  assertEquals(formatIcu(APPLES, { n: 1 }, "en"), "1 apple");
  assertEquals(formatIcu(APPLES, { n: 7 }, "en"), "7 apples");
});

test("formatIcu: categories are the language's, and # is formatted for it", () => {
  const polish = "{n, plural, one {# jabłko} few {# jabłka} many {# jabłek} other {# jabłka}}";
  assertEquals(formatIcu(polish, { n: 3 }, "pl"), "3 jabłka");
  assertEquals(formatIcu(polish, { n: 5 }, "pl"), "5 jabłek");
  assertEquals(formatIcu(polish, { n: 1.5 }, "pl"), "1,5 jabłka");
  assertEquals(formatIcu("{n, plural, other {# Äpfel}}", { n: 12000 }, "de"), "12.000 Äpfel");
});

test("formatIcu: a missing category falls back to other", () => {
  const text = "{n, plural, one {# manzana} other {# manzanas}}";
  assertEquals(formatIcu(text, { n: 1000000 }, "es"), "1.000.000 manzanas");
});

test("formatIcu: selectordinal uses ordinal categories", () => {
  const text = "{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
  assertEquals(formatIcu(text, { place: 2 }, "en"), "2nd");
  assertEquals(formatIcu(text, { place: 11 }, "en"), "11th");
  assertEquals(formatIcu(text, { place: 23 }, "en"), "23rd");
});

test("formatIcu: # shows the number less the offset; exact cases match the value", () => {
  const text = "{n, plural, offset:1 =1 {Only you} one {You and # other} other {You and # others}}";
  assertEquals(formatIcu(text, { n: 1 }, "en"), "Only you");
  assertEquals(formatIcu(text, { n: 2 }, "en"), "You and 1 other");
  assertEquals(formatIcu(text, { n: 4 }, "en"), "You and 3 others");
});

test("formatIcu: nested blocks", () => {
  const text =
    "{host, select, female {{n, plural, one {She invites # guest} other {She invites # guests}}} other {{n, plural, one {They invite # guest} other {They invite # guests}}}}";
  assertEquals(formatIcu(text, { host: "female", n: 1 }, "en"), "She invites 1 guest");
  assertEquals(formatIcu(text, { host: "male", n: 3 }, "en"), "They invite 3 guests");
});

test("formatIcu: quoted text shows unquoted", () => {
  assertEquals(
    formatIcu("Type '{'name'}' here, it''s fine", {}, "en"),
    "Type {name} here, it's fine",
  );
  assertEquals(formatIcu("l'{name}", { name: "x" }, "fr"), "l{name}");
  assertEquals(formatIcu("{n, plural, other {'#' # times}}", { n: 2 }, "en"), "# 2 times");
});

test("formatIcuParts: text, arguments and numbers apart", () => {
  assertEquals(
    formatIcuParts("{n, plural, one {{host} invites # guest} other {}}", { n: 1 }, "en"),
    [
      { type: "argument", text: "{host}" },
      { type: "text", text: " invites " },
      { type: "number", text: "1" },
      { type: "text", text: " guest" },
    ],
  );
});

test("icuPreview: every select case, with other", () => {
  const preview = icuPreview("{style, select, formal {Good day} other {Hello}}!", "en");
  assertEquals(
    preview.rows.map((row) => [row.choices, row.parts]),
    [
      [[{ argument: "style", key: "formal" }], [{ type: "text", text: "Good day!" }]],
      [[{ argument: "style", key: "other" }], [{ type: "text", text: "Hello!" }]],
    ],
  );
  assertEquals(preview.truncated, false);
});

test("icuPreview: exact cases, then one number per category of the language", () => {
  const spanish =
    "{n, plural, =0 {Ninguna} one {# manzana} many {# de manzanas} other {# manzanas}}";
  const rows = icuPreview(spanish, "es").rows;
  assertEquals(
    rows.map((row) => row.choices),
    [
      [{ argument: "n", key: "=0", number: 0 }],
      [{ argument: "n", key: "one", number: 1 }],
      [{ argument: "n", key: "many", number: 1000000 }],
      [{ argument: "n", key: "other", number: 2 }],
    ],
  );
  assertEquals(
    rows.map((row) => row.parts.map((part) => part.text).join("")),
    ["Ninguna", "1 manzana", "1.000.000 de manzanas", "2 manzanas"],
  );
});

test("icuPreview: a category the translation lacks shows what the app shows, other", () => {
  const rows = icuPreview("{n, plural, one {# manzana} other {# manzanas}}", "es").rows;
  assertEquals(rows[1].choices, [{ argument: "n", key: "many", number: 1000000 }]);
  assertEquals(rows[1].parts.map((part) => part.text).join(""), "1.000.000 manzanas");
});

test("icuPreview: ordinal categories", () => {
  const rows = icuPreview("{p, selectordinal, other {#.}}", "de").rows;
  assertEquals(
    rows.map((row) => row.choices),
    [[{ argument: "p", key: "other", number: 1 }]],
  );
});

test("icuPreview: a nested block adds its cases to the rows of its case", () => {
  const text = "{host, select, female {{n, plural, one {Ella, #} other {Ellas, #}}} other {Todos}}";
  const rows = icuPreview(text, "en").rows;
  assertEquals(
    rows.map((row) => row.choices.map((choice) => choice.key)),
    [["female", "one"], ["female", "other"], ["other"]],
  );
  assertEquals(rows[1].parts.map((part) => part.text).join(""), "Ellas, 0");
});

test("icuPreview: a block on an argument already chosen follows that choice", () => {
  const text = "{a, select, x {X} other {O}}-{a, select, x {x} other {o}}";
  const rows = icuPreview(text, "en").rows;
  assertEquals(
    rows.map((row) => row.parts.map((part) => part.text).join("")),
    ["X-x", "O-o"],
  );
});

test("icuPreview: without blocks, one row", () => {
  assertEquals(icuPreview("Hello, {name}!", "en").rows, [
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
  assertEquals(preview.rows.length, 4);
  assertEquals(preview.truncated, true);
});
