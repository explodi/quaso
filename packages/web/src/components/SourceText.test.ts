// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceText } from "./SourceText.tsx";

const ICU = { prefix: "{{", suffix: "}}", icu: true };

function render(text: string, tree: boolean): string {
  return renderToStaticMarkup(createElement(SourceText, { text, syntax: ICU, tree }));
}

test("tree: a block's cases one per item, keyed, with arguments marked", () => {
  expect(
    render("{g, select, female {She met {name}} other {They met {name}}}", true),
  ).toStrictEqual(
    '<span class="source-text source-tree">' +
      '<span class="icu-block"><span class="icu-syntax icu-block-head">{g, select}</span>' +
      '<span class="icu-cases" role="list">' +
      '<span class="icu-case" role="listitem"><span class="icu-case-key">female<span class="sr-only">: </span></span>' +
      '<span class="icu-case-message"><span class="icu-line">She met <mark class="ph">{name}</mark></span></span></span>' +
      '<span class="icu-case" role="listitem"><span class="icu-case-key">other<span class="sr-only">: </span></span>' +
      '<span class="icu-case-message"><span class="icu-line">They met <mark class="ph">{name}</mark></span></span></span>' +
      "</span></span></span>",
  );
});

test("tree: text around a block on lines of its own, without the spaces that part them", () => {
  const html = render("Sold {n, plural, one {# cake} other {# cakes}} today.", true);
  expect(
    html.startsWith('<span class="source-text source-tree"><span class="icu-line">Sold</span>'),
  ).toBe(true);
  expect(html.endsWith('<span class="icu-line">today.</span></span>')).toBe(true);
});

test("tree: a block inside a case sits in that case", () => {
  const html = render("{g, select, other {{n, plural, other {#}}}}", true);
  expect(
    html.includes(
      '<span class="icu-case-message"><span class="icu-block"><span class="icu-syntax icu-block-head">{n, plural}</span>',
    ),
  ).toBe(true);
});

test("tree: an empty case says so", () => {
  const html = render("{g, select, female {} other {They}}", true);
  expect(html.includes('<span class="muted">(empty)</span>')).toBe(true);
});

test("tree: text without blocks, and text without tree, stay in one line", () => {
  expect(render("Hello, {name}!", true)).toStrictEqual(
    '<span class="source-text">Hello, <mark class="ph">{name}</mark>!</span>',
  );
  expect(render("{n, plural, other {#}}", false)).toStrictEqual(
    '<span class="source-text"><span class="icu-syntax">{n, plural, other {</span><mark class="ph">#</mark><span class="icu-syntax">}}</span></span>',
  );
});
