// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStrictEquals } from "@std/assert";
import { FilePath } from "./api.ts";
import {
  anchorLinks,
  blockKind,
  DOCUMENT_KEY,
  formatForPath,
  headingAnchors,
  isDocumentKey,
  isMarkdownFormat,
  keepUntouchedParagraphs,
  MARKDOWN_FORMAT,
  normalizeDocument,
  paragraphCount,
  paragraphsOf,
  verbatimParts,
} from "./documents.ts";
import { readSource, readTranslation } from "./entries.ts";
import { renderFile } from "./render.ts";
import { validate } from "./schema.ts";
import { entryKey } from "./types.ts";

const ARTICLE = [
  "The moment has arrived: {{cityName}} is founded",
  "",
  "What was once a patch of dirt is now a patch of dirt with a name: {{cityName}}.",
  "",
  "Some managed to hold it. Others will have a story to tell.",
].join("\n");

test("the document key is the empty key path", () => {
  assertStrictEquals(DOCUMENT_KEY, entryKey("text", []));
  assertEquals(isDocumentKey("[]"), true);
  assertEquals(isDocumentKey('[""]'), false, "a JSON key that is an empty string is a key");
  assertEquals(isDocumentKey('["title"]'), false);
});

test("the format follows the extension: .json, .md and .markdown; nothing else", () => {
  assertEquals(formatForPath("common.json"), "json");
  assertEquals(formatForPath("news/city_founded.md"), "markdown");
  assertEquals(formatForPath("README.markdown"), "markdown");
  assertEquals(formatForPath("notes.txt"), undefined);
  assertEquals(formatForPath("story.MD"), undefined, "extensions are case-sensitive, like paths");
  assertEquals(isMarkdownFormat(MARKDOWN_FORMAT), true);
  assertEquals(isMarkdownFormat({ indent: "  ", newline: "\n", finalNewline: true }), false);
});

test("file paths may end in .md or .markdown", () => {
  assertEquals(validate(FilePath, "news/city_founded.md").ok, true);
  assertEquals(validate(FilePath, "intro.markdown").ok, true);
  assertEquals(validate(FilePath, "common.json").ok, true);
  assertEquals(validate(FilePath, "notes.txt").ok, false);
});

test("normalizeDocument: \\n line endings, no byte order mark, nothing at the end", () => {
  assertStrictEquals(normalizeDocument("\uFEFFTitle\r\n\r\nBody.  \r\n\n"), "Title\n\nBody.");
  assertStrictEquals(normalizeDocument("  Indented\n"), "  Indented", "the start is kept");
  assertStrictEquals(normalizeDocument("\n \n"), "");
});

test("paragraphs are blocks separated by blank lines, whatever the number of blank lines", () => {
  assertEquals(paragraphsOf(ARTICLE).length, 3);
  assertEquals(paragraphsOf("a\n\n\n\nb\n \nc"), ["a", "b", "c"]);
  assertEquals(paragraphsOf("one line"), ["one line"]);
  assertEquals(paragraphsOf("a\nb"), ["a\nb"], "a single line break stays inside a paragraph");
  assertEquals(paragraphCount(""), 0);
  assertEquals(paragraphCount("\n\n"), 0);
});

test("readSource reads a Markdown file as one text entry with an empty key path", () => {
  const source = readSource(`${ARTICLE}\n`, { file: "news/city_founded.md" });
  assertEquals(source.format, { type: "markdown" });
  assertEquals(source.entries, [{ kind: "text", keyPath: [], value: ARTICLE, line: 1 }]);
  const byOption = readSource(ARTICLE, { format: "markdown" });
  assertEquals(byOption.entries, source.entries, "the format option wins over the extension");
});

test("readSource: a blank Markdown file is a literal, copied rather than translated", () => {
  assertEquals(readSource("\n\n", { file: "empty.md" }).entries, [
    { kind: "literal", keyPath: [], raw: '""', line: 1 },
  ]);
});

test("readSource: a .json file is still JSON, and a document never is", () => {
  assertEquals(readSource('{"a": "b"}', { file: "x.json" }).entries, [
    { kind: "text", keyPath: ["a"], value: "b", line: 1 },
  ]);
  assertEquals(readSource('{"a": "b"}', { file: "x.md" }).entries, [
    { kind: "text", keyPath: [], value: '{"a": "b"}', line: 1 },
  ]);
});

test("readTranslation reads a Markdown translation as the document's value", () => {
  const english = readSource(ARTICLE, { format: "markdown" }).entries;
  const read = readTranslation("Der Moment\r\n\r\nText.\r\n", english, {
    language: "de",
    file: "news/city_founded.md",
  });
  assertEquals(read, {
    values: new Map([[DOCUMENT_KEY, "Der Moment\n\nText."]]),
    unknownKeys: [],
  });
  const blank = readTranslation("\n", english, { language: "de", format: "markdown" });
  assertEquals(blank.values, new Map([[DOCUMENT_KEY, ""]]), "a blank file is a blank value");
  const literal = readSource("", { format: "markdown" }).entries;
  assertEquals(
    readTranslation("Text", literal, { language: "de", format: "markdown" }).values,
    new Map(),
    "a blank English document has nothing to translate",
  );
});

test("renderFile writes a document's translation with one final newline, byte-stable", () => {
  const { entries, format } = readSource(ARTICLE, { format: "markdown" });
  const translation = "Der Moment\r\n\r\nText.\r\n\r\n";
  const options = { language: "de", format };
  const rendered = renderFile(entries, new Map([[DOCUMENT_KEY, translation]]), options);
  assertStrictEquals(rendered, "Der Moment\n\nText.\n");
  assertStrictEquals(
    renderFile(entries, new Map([[DOCUMENT_KEY, translation]]), options),
    rendered,
  );
  const again = readSource(rendered, { format: "markdown" });
  assertEquals(again.entries[0], {
    kind: "text",
    keyPath: [],
    value: "Der Moment\n\nText.",
    line: 1,
  });
});

test("renderFile: an untranslated document is the English, or nothing with omit", () => {
  const { entries, format } = readSource(ARTICLE, { format: "markdown" });
  assertStrictEquals(renderFile(entries, new Map(), { language: "de", format }), `${ARTICLE}\n`);
  assertStrictEquals(
    renderFile(entries, new Map(), { language: "de", format, untranslated: "omit" }),
    "",
  );
  const omitted = new Set([DOCUMENT_KEY]);
  assertStrictEquals(
    renderFile(entries, new Map([[DOCUMENT_KEY, "Text"]]), { language: "de", format, omitted }),
    "",
    "an omitted (outdated) translation leaves no file",
  );
  const blank = readSource("", { format: "markdown" });
  assertStrictEquals(renderFile(blank.entries, new Map(), { language: "de", format }), "");
});

test("keepUntouchedParagraphs puts back the paragraphs whose English didn't change", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "Title\n\nOld second.\n\nThird.",
    newEnglish: "Title\n\nNew second.\n\nThird.",
    oldTranslation: "Titel\n\nAlter zweiter.\n\nDritter.",
    newTranslation: "Überschrift\n\nNeuer zweiter.\n\nDer dritte.\n",
  });
  assertStrictEquals(kept, "Titel\n\nNeuer zweiter.\n\nDritter.");
});

test("keepUntouchedParagraphs keeps the update's blank lines between paragraphs", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "A\n\nB",
    newEnglish: "A\n\nB2",
    oldTranslation: "Ä\n\nBe",
    newTranslation: "Ah\n\n\nBe zwei",
  });
  assertStrictEquals(kept, "Ä\n\n\nBe zwei");
});

test("keepUntouchedParagraphs returns the update when the paragraphs don't pair up", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "A\n\nB",
    newEnglish: "A\n\nB\n\nC",
    oldTranslation: "Ä\n\nBe",
    newTranslation: "Ah\n\nBe\n\nZe\r\n",
  });
  assertStrictEquals(kept, "Ah\n\nBe\n\nZe");
});

test("blockKind names a paragraph by its first lines", () => {
  assertStrictEquals(blockKind("## Getting started", false), "a level-2 heading");
  assertStrictEquals(blockKind("Title\n=====", false), "a level-1 heading");
  assertStrictEquals(blockKind("Title\n-----", false), "a level-2 heading");
  assertStrictEquals(blockKind("- one\n- two", false), "a list");
  assertStrictEquals(blockKind("* one", false), "a list");
  assertStrictEquals(blockKind("1. one\n2. two", false), "a numbered list");
  assertStrictEquals(blockKind("> Quoted", false), "a quote");
  assertStrictEquals(blockKind("| a | b |\n|---|---|", false), "a table");
  assertStrictEquals(blockKind("a | b\n--- | ---", false), "a table");
  assertStrictEquals(blockKind("```js\ncode\n```", false), "a code block");
  assertStrictEquals(blockKind("---\ntitle: News\n---", true), "front matter");
  assertStrictEquals(blockKind("---", false), "a horizontal rule");
  assertStrictEquals(blockKind("<details>", false), "HTML");
  assertStrictEquals(blockKind("    indented", false), "an indented block");
  assertStrictEquals(blockKind("Just text.\nOn two lines.", false), "a paragraph");
  assertStrictEquals(blockKind("#hashtag", false), "a paragraph", "a heading needs a space");
});

test("verbatimParts: fenced code blocks, whole", () => {
  assertEquals(verbatimParts("Run it:\n\n```sh\nquaso init\n\nquaso upload\n```\n\nDone."), [
    "```sh\nquaso init\n\nquaso upload\n```",
  ]);
});

test("verbatimParts: inline code", () => {
  assertEquals(verbatimParts("Type `quaso init`, then ``a ` b``."), ["`quaso init`", "``a ` b``"]);
});

test("verbatimParts: link and image destinations, but not their text or title", () => {
  assertEquals(verbatimParts('[Download](https://example.com/dl "The file") ![Map](map.png)'), [
    "https://example.com/dl",
    "map.png",
  ]);
});

test("verbatimParts: reference definitions and autolinks", () => {
  assertEquals(verbatimParts("See [the wiki][w] or <https://example.com>.\n\n[w]: https://wiki"), [
    "https://wiki",
    "https://example.com",
  ]);
});

test("verbatimParts: front matter keys, not their values", () => {
  assertEquals(verbatimParts("---\ntitle: City founded\ndate: 2026-10-15\n---\n\nText."), [
    "title:",
    "date:",
  ]);
});

test("verbatimParts: links to the file's own headings follow the translation", () => {
  assertEquals(verbatimParts("[See below](#installation)"), []);
});

test("verbatimParts: a link inside inline code is code", () => {
  assertEquals(verbatimParts("Write `[a](b)` for a link."), ["`[a](b)`"]);
});

test("headingAnchors: GitHub's anchors, numbered when repeated, and explicit ones", () => {
  const text = [
    "# Getting started",
    "",
    "## Install **Quaso** on Windows!",
    "",
    "## Getting started",
    "",
    "## Instalación {#install}",
    "",
    "Setext",
    "------",
    "",
    '<a id="custom"></a>',
    "",
    "```",
    "# not a heading",
    "```",
  ].join("\n");
  assertEquals(
    headingAnchors(text),
    new Set([
      "getting-started",
      "install-quaso-on-windows",
      "getting-started-1",
      "install",
      "setext",
      "custom",
    ]),
  );
  assertEquals(headingAnchors("## Über die Stadt"), new Set(["über-die-stadt"]));
});

test("anchorLinks: the anchors of links to the file itself, decoded", () => {
  assertEquals(anchorLinks("[a](#one) [b](https://x#two) [c](#instalaci%C3%B3n) `[d](#code)`"), [
    "one",
    "instalación",
  ]);
});
