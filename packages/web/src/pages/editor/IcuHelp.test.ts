// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IcuPreviewList, PluralCaseHints, pluralCaseHints } from "./IcuHelp.tsx";

/** The text a reader sees: markup without its tags. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");
}

test("pluralCaseHints: the language's categories with example numbers", () => {
  assertEquals(pluralCaseHints("{n, plural, one {# apple} other {# apples}}", "es"), [
    {
      kind: "plural",
      arguments: ["n"],
      categories: [
        { category: "one", examples: "1" },
        { category: "many", examples: "1000000" },
        { category: "other", examples: "0, 2–1000, …, 1.5" },
      ],
      exact: [],
    },
  ]);
});

test("pluralCaseHints: blocks needing the same categories share a hint", () => {
  const english =
    "{host, select, female {{n, plural, =0 {Alone} one {# guest} other {# guests}}} other {{n, plural, =0 {Alone} =1 {One} other {# guests}}}}";
  const hints = pluralCaseHints(english, "ja");
  assertEquals(
    hints.map((hint) => [hint.kind, hint.arguments, hint.exact]),
    [["plural", ["n"], ["=0", "=1"]]],
  );
});

test("pluralCaseHints: ordinal and cardinal blocks apart, outermost first", () => {
  const english =
    "{p, selectordinal, one {#st} other {#th}} of {n, plural, one {# runner} other {# runners}}";
  const hints = pluralCaseHints(english, "de");
  assertEquals(
    hints.map((hint) => [hint.kind, hint.arguments, hint.categories.map((c) => c.category)]),
    [
      ["ordinal", ["p"], ["other"]],
      ["plural", ["n"], ["one", "other"]],
    ],
  );
});

test("pluralCaseHints: select blocks need no hint", () => {
  assertEquals(pluralCaseHints("{g, select, female {She} other {They}}", "es"), []);
});

test("PluralCaseHints: one sentence per hint", () => {
  const english = "{n, plural, =0 {None} one {# apple} other {# apples}}";
  const html = renderToStaticMarkup(
    createElement(PluralCaseHints, {
      id: "hints",
      hints: pluralCaseHints(english, "pl"),
      languageName: "Polish",
    }),
  );
  assertEquals(
    textOf(html),
    "Polish plural cases for {n}: one (1), few (2–4, 22–24, 32–34, …), many (0, 5–21, 25–31, …), other (1.5). Keep the English's exact case =0.",
  );
});

function preview(text: string, language = "es"): string {
  const html = renderToStaticMarkup(createElement(IcuPreviewList, { text, language, dir: "ltr" }));
  return textOf(html);
}

test("IcuPreviewList: the translation in each case", () => {
  assertEquals(
    preview("{g, select, female {Ella invita a {host}} other {Invitan a {host}}}"),
    "Preview in each casefemale: Ella invita a {host}other: Invitan a {host}",
  );
});

test("IcuPreviewList: one example number per category, # formatted", () => {
  assertEquals(
    preview("{n, plural, one {# manzana} other {# manzanas}}"),
    "Preview in each caseone 1: 1 manzanamany 1000000: 1.000.000 manzanasother 0: 0 manzanas",
  );
});

test("IcuPreviewList: where the translation stops being valid ICU", () => {
  assertEquals(
    preview("{n, plural, one {# manzana} other {# manzanas}"),
    "Preview in each caseThe translation isn't valid ICU at character 1: This { is never closed.{n, plural, one {# manzan…",
  );
});

test("IcuPreviewList: nothing for empty text or text without blocks", () => {
  assertEquals(preview(""), "");
  assertEquals(preview("Hola, {name}"), "");
});
