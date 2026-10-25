// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceText } from "./SourceText.tsx";

const ICU = { prefix: "{{", suffix: "}}", icu: true };

function render(text: string, tree: boolean): string {
  return renderToStaticMarkup(createElement(SourceText, { text, syntax: ICU, tree }));
}

test("tree: a block's cases one per item, keyed, with arguments marked", () => {
  assertEquals(
    render("{g, select, female {She met {name}} other {They met {name}}}", true),
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
  assertEquals(
    html.startsWith('<span class="source-text source-tree"><span class="icu-line">Sold</span>'),
    true,
  );
  assertEquals(html.endsWith('<span class="icu-line">today.</span></span>'), true);
});

test("tree: a block inside a case sits in that case", () => {
  const html = render("{g, select, other {{n, plural, other {#}}}}", true);
  assertEquals(
    html.includes(
      '<span class="icu-case-message"><span class="icu-block"><span class="icu-syntax icu-block-head">{n, plural}</span>',
    ),
    true,
  );
});

test("tree: an empty case says so", () => {
  const html = render("{g, select, female {} other {They}}", true);
  assertEquals(html.includes('<span class="muted">(empty)</span>'), true);
});

test("tree: text without blocks, and text without tree, stay in one line", () => {
  assertEquals(
    render("Hello, {name}!", true),
    '<span class="source-text">Hello, <mark class="ph">{name}</mark>!</span>',
  );
  assertEquals(
    render("{n, plural, other {#}}", false),
    '<span class="source-text"><span class="icu-syntax">{n, plural, other {</span><mark class="ph">#</mark><span class="icu-syntax">}}</span></span>',
  );
});
