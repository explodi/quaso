// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(html).toContain('id="t" lang="es" dir="ltr" data-translation-input=""');
  expect(html).toContain(">Ella</textarea>");
  expect(html).toContain(">Elles</textarea>");
  expect(html).toContain("> se fue.</textarea>");
  expect(html).toContain('aria-describedby="t-checks"');
});

test("field labels: the cases, with each block's argument for screen readers", () => {
  const text = textOf(render(LEFT, ""));
  expect(text).toContain("g female");
  expect(text).toContain("g other");
  expect(text).toContain("After {g}");
});

test("field labels: plural categories with their numbers, text between blocks", () => {
  const english =
    "{n, plural, one {# cat} other {# cats}} and {m, plural, one {# dog} other {# dogs}}";
  const text = textOf(render(english, ""));
  expect(text).toContain("n many, for 1000000");
  expect(text).toContain("Between {n} and {m}");
});

test("the English above a field marks its edge spaces", () => {
  expect(render(LEFT, "")).toContain('title="Starts with a space"');
});

test("a translation that doesn't fit: the text input, and why", () => {
  const html = render(LEFT, "{g, select, female {Ella} male {Él} other {Elles}} se fue.");
  expect(html).toContain("the text input");
  expect(textOf(html)).toContain(
    "Its blocks or cases differ from the English's, so this translation is edited as text.",
  );
});

test("a translation that isn't valid ICU: the text input, and why", () => {
  const html = render(LEFT, "{g, select, female {Ella} other {Elles} se fue.");
  expect(textOf(html)).toContain("It isn't valid ICU, so this translation is edited as text.");
});

test("an English without blocks has no case editor", () => {
  expect(textOf(render("Hello, {name}!", ""))).toBe("no case editor");
});
