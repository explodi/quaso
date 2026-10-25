// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IcuCaseInput, useIcuFields } from "./IcuCaseEditor.tsx";

const LEFT = "{g, select, female {She} other {They}} left.";

/** The case editor of a string whose saved translation is `text`. */
function CaseInput({ english, text }: { english: string; text: string }) {
  const fields = useIcuFields(english, text, text, "es");
  if (fields === null) return createElement("span", null, "no case editor");
  return createElement(IcuCaseInput, {
    fields,
    text,
    textInput: createElement("span", null, "the text input"),
    inputId: "t",
    language: "es",
    direction: "ltr",
    sourceLanguage: "en",
    sourceDirection: "ltr",
    invalid: false,
    describedBy: "t-checks",
    singleLine: true,
    firstFieldRef: () => {},
    onFieldFocus: () => {},
    onChange: () => {},
  });
}

function render(english: string, text: string): string {
  return renderToStaticMarkup(createElement(CaseInput, { english, text }));
}

/** The text a reader sees: markup without its tags. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");
}

test("a translation that fits: one field per case, the first with the input's id", () => {
  const html = render(LEFT, "{g, select, female {Ella} other {Elles}} se fue.");
  assertStringIncludes(html, 'id="t" lang="es" dir="ltr" data-translation-input=""');
  assertStringIncludes(html, ">Ella</textarea>");
  assertStringIncludes(html, ">Elles</textarea>");
  assertStringIncludes(html, "> se fue.</textarea>");
  assertStringIncludes(html, 'aria-describedby="t-checks"');
});

test("field labels: the cases, with each block's argument for screen readers", () => {
  const text = textOf(render(LEFT, ""));
  assertStringIncludes(text, "g female");
  assertStringIncludes(text, "g other");
  assertStringIncludes(text, "After {g}");
});

test("field labels: plural categories with their numbers, text between blocks", () => {
  const english =
    "{n, plural, one {# cat} other {# cats}} and {m, plural, one {# dog} other {# dogs}}";
  const text = textOf(render(english, ""));
  assertStringIncludes(text, "n many, for 1000000");
  assertStringIncludes(text, "Between {n} and {m}");
});

test("the English above a field marks its edge spaces", () => {
  assertStringIncludes(render(LEFT, ""), 'title="Starts with a space"');
});

test("a translation that doesn't fit: the text input, and why", () => {
  const html = render(LEFT, "{g, select, female {Ella} male {Él} other {Elles}} se fue.");
  assertStringIncludes(html, "the text input");
  assertStringIncludes(
    textOf(html),
    "Its blocks or cases differ from the English's, so this translation is edited as text.",
  );
});

test("a translation that isn't valid ICU: the text input, and why", () => {
  const html = render(LEFT, "{g, select, female {Ella} other {Elles} se fue.");
  assertStringIncludes(textOf(html), "It isn't valid ICU, so this translation is edited as text.");
});

test("an English without blocks has no case editor", () => {
  assertEquals(textOf(render("Hello, {name}!", "")), "no case editor");
});
