// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "./markdown.tsx";

function render(text: string): string {
  const html = renderToStaticMarkup(
    createElement(MarkdownPreview, { text, lang: "de", dir: "ltr" }),
  );
  return html.replace(/^<div class="markdown-preview" lang="de" dir="ltr">|<\/div>$/g, "");
}

test("headings are styled paragraphs, without their explicit anchor", () => {
  assertEquals(
    render("## Erste Schritte {#start}"),
    '<p class="markdown-heading markdown-heading-2">Erste Schritte</p>',
  );
  assertEquals(render("Titel\n====="), '<p class="markdown-heading markdown-heading-1">Titel</p>');
});

test("paragraphs keep their line breaks; blank lines separate them", () => {
  assertEquals(render("Eins\nzwei\n\nDrei"), "<p>Eins\nzwei</p><p>Drei</p>");
});

test("inline code, strong, emphasis and strikethrough", () => {
  assertEquals(
    render("Tippe `quaso **init**`, **fett**, *schräg*, _auch_ und ~~weg~~."),
    "<p>Tippe <code>quaso **init**</code>, <strong>fett</strong>, <em>schräg</em>, <em>auch</em> und <del>weg</del>.</p>",
  );
});

test("an underscore inside a word isn't emphasis", () => {
  assertEquals(render("snake_case_name"), "<p>snake_case_name</p>");
});

test("web links open in a new tab; other destinations aren't followed", () => {
  assertEquals(
    render("[Die Anleitung](https://example.com/guide) und [unten](#install)"),
    '<p><a href="https://example.com/guide" target="_blank" rel="noopener noreferrer">Die Anleitung</a> und <span class="markdown-link">unten</span></p>',
  );
  assertEquals(
    render("[Klick](javascript:alert(1))"),
    '<p><span class="markdown-link">Klick</span>)</p>',
    "a script is never a link",
  );
});

test("images show their alt text instead of loading", () => {
  assertEquals(
    render("![Die Karte](https://example.com/map.png)"),
    '<p><span class="markdown-image">Die Karte</span></p>',
  );
});

test("raw HTML is text", () => {
  assertEquals(render("<b>fett</b>"), "<p>&lt;b&gt;fett&lt;/b&gt;</p>");
});

test("lists, numbered lists and quotes", () => {
  assertEquals(render("- Eins\n- Zwei\n  weiter"), "<ul><li>Eins</li><li>Zwei weiter</li></ul>");
  assertEquals(render("1. Eins\n2. Zwei"), "<ol><li>Eins</li><li>Zwei</li></ol>");
  assertEquals(render("> Zitat\n> weiter"), "<blockquote><p>Zitat\nweiter</p></blockquote>");
});

test("code blocks keep blank lines and aren't Markdown", () => {
  assertEquals(
    render("```sh\nquaso init\n\n# **not** a heading\n```"),
    '<pre class="markdown-code"><code>quaso init\n\n# **not** a heading</code></pre>',
  );
});

test("tables", () => {
  assertEquals(
    render("| Taste | Aktion |\n|---|---|\n| E | *Benutzen* |"),
    '<div class="markdown-table"><table class="table"><thead><tr><th>Taste</th><th>Aktion</th></tr></thead><tbody><tr><td>E</td><td><em>Benutzen</em></td></tr></tbody></table></div>',
  );
});

test("front matter shows as written; a horizontal rule is a rule", () => {
  assertEquals(
    render("---\ntitle: Neu\n---\n\nText\n\n---"),
    '<pre class="markdown-front-matter">---\ntitle: Neu\n---</pre><p>Text</p><hr/>',
  );
});
