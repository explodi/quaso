// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(render("## Erste Schritte {#start}")).toStrictEqual(
    '<p class="markdown-heading markdown-heading-2">Erste Schritte</p>',
  );
  expect(render("Titel\n=====")).toStrictEqual(
    '<p class="markdown-heading markdown-heading-1">Titel</p>',
  );
});

test("paragraphs keep their line breaks; blank lines separate them", () => {
  expect(render("Eins\nzwei\n\nDrei")).toBe("<p>Eins\nzwei</p><p>Drei</p>");
});

test("inline code, strong, emphasis and strikethrough", () => {
  expect(render("Tippe `quaso **init**`, **fett**, *schräg*, _auch_ und ~~weg~~.")).toStrictEqual(
    "<p>Tippe <code>quaso **init**</code>, <strong>fett</strong>, <em>schräg</em>, <em>auch</em> und <del>weg</del>.</p>",
  );
});

test("an underscore inside a word isn't emphasis", () => {
  expect(render("snake_case_name")).toBe("<p>snake_case_name</p>");
});

test("web links open in a new tab; other destinations aren't followed", () => {
  expect(render("[Die Anleitung](https://example.com/guide) und [unten](#install)")).toStrictEqual(
    '<p><a href="https://example.com/guide" target="_blank" rel="noopener noreferrer">Die Anleitung</a> und <span class="markdown-link">unten</span></p>',
  );
  expect(render("[Klick](javascript:alert(1))"), "a script is never a link").toStrictEqual(
    '<p><span class="markdown-link">Klick</span>)</p>',
  );
});

test("images show their alt text instead of loading", () => {
  expect(render("![Die Karte](https://example.com/map.png)")).toStrictEqual(
    '<p><span class="markdown-image">Die Karte</span></p>',
  );
});

test("raw HTML is text", () => {
  expect(render("<b>fett</b>")).toBe("<p>&lt;b&gt;fett&lt;/b&gt;</p>");
});

test("lists, numbered lists and quotes", () => {
  expect(render("- Eins\n- Zwei\n  weiter")).toStrictEqual(
    "<ul><li>Eins</li><li>Zwei weiter</li></ul>",
  );
  expect(render("1. Eins\n2. Zwei")).toBe("<ol><li>Eins</li><li>Zwei</li></ol>");
  expect(render("> Zitat\n> weiter")).toStrictEqual(
    "<blockquote><p>Zitat\nweiter</p></blockquote>",
  );
});

test("code blocks keep blank lines and aren't Markdown", () => {
  expect(render("```sh\nquaso init\n\n# **not** a heading\n```")).toStrictEqual(
    '<pre class="markdown-code"><code>quaso init\n\n# **not** a heading</code></pre>',
  );
});

test("tables", () => {
  expect(render("| Taste | Aktion |\n|---|---|\n| E | *Benutzen* |")).toStrictEqual(
    '<div class="markdown-table"><table class="table"><thead><tr><th>Taste</th><th>Aktion</th></tr></thead><tbody><tr><td>E</td><td><em>Benutzen</em></td></tr></tbody></table></div>',
  );
});

test("front matter shows as written; a horizontal rule is a rule", () => {
  expect(render("---\ntitle: Neu\n---\n\nText\n\n---")).toStrictEqual(
    '<pre class="markdown-front-matter">---\ntitle: Neu\n---</pre><p>Text</p><hr/>',
  );
});
