// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(DOCUMENT_KEY).toBe(entryKey("text", []));
  expect(isDocumentKey("[]")).toBe(true);
  expect(isDocumentKey('[""]'), "a JSON key that is an empty string is a key").toBe(false);
  expect(isDocumentKey('["title"]')).toBe(false);
});

test("the format follows the extension: .json, .md and .markdown; nothing else", () => {
  expect(formatForPath("common.json")).toBe("json");
  expect(formatForPath("news/city_founded.md")).toBe("markdown");
  expect(formatForPath("README.markdown")).toBe("markdown");
  expect(formatForPath("notes.txt")).toBe(undefined);
  expect(formatForPath("story.MD"), "extensions are case-sensitive, like paths").toStrictEqual(
    undefined,
  );
  expect(isMarkdownFormat(MARKDOWN_FORMAT)).toBe(true);
  expect(isMarkdownFormat({ indent: "  ", newline: "\n", finalNewline: true })).toStrictEqual(
    false,
  );
});

test("file paths may end in .md or .markdown", () => {
  expect(validate(FilePath, "news/city_founded.md").ok).toBe(true);
  expect(validate(FilePath, "intro.markdown").ok).toBe(true);
  expect(validate(FilePath, "common.json").ok).toBe(true);
  expect(validate(FilePath, "notes.txt").ok).toBe(false);
});

test("normalizeDocument: \\n line endings, no byte order mark, nothing at the end", () => {
  expect(normalizeDocument("\uFEFFTitle\r\n\r\nBody.  \r\n\n")).toBe("Title\n\nBody.");
  expect(normalizeDocument("  Indented\n"), "the start is kept").toBe("  Indented");
  expect(normalizeDocument("\n \n")).toBe("");
});

test("paragraphs are blocks separated by blank lines, whatever the number of blank lines", () => {
  expect(paragraphsOf(ARTICLE).length).toBe(3);
  expect(paragraphsOf("a\n\n\n\nb\n \nc")).toStrictEqual(["a", "b", "c"]);
  expect(paragraphsOf("one line")).toStrictEqual(["one line"]);
  expect(paragraphsOf("a\nb"), "a single line break stays inside a paragraph").toStrictEqual([
    "a\nb",
  ]);
  expect(paragraphCount("")).toBe(0);
  expect(paragraphCount("\n\n")).toBe(0);
});

test("readSource reads a Markdown file as one text entry with an empty key path", () => {
  const source = readSource(`${ARTICLE}\n`, { file: "news/city_founded.md" });
  expect(source.format).toStrictEqual({ type: "markdown" });
  expect(source.entries).toStrictEqual([{ kind: "text", keyPath: [], value: ARTICLE, line: 1 }]);
  const byOption = readSource(ARTICLE, { format: "markdown" });
  expect(byOption.entries, "the format option wins over the extension").toStrictEqual(
    source.entries,
  );
});

test("readSource: a blank Markdown file is a literal, copied rather than translated", () => {
  expect(readSource("\n\n", { file: "empty.md" }).entries).toStrictEqual([
    { kind: "literal", keyPath: [], raw: '""', line: 1 },
  ]);
});

test("readSource: a .json file is still JSON, and a document never is", () => {
  expect(readSource('{"a": "b"}', { file: "x.json" }).entries).toStrictEqual([
    { kind: "text", keyPath: ["a"], value: "b", line: 1 },
  ]);
  expect(readSource('{"a": "b"}', { file: "x.md" }).entries).toStrictEqual([
    { kind: "text", keyPath: [], value: '{"a": "b"}', line: 1 },
  ]);
});

test("readTranslation reads a Markdown translation as the document's value", () => {
  const english = readSource(ARTICLE, { format: "markdown" }).entries;
  const read = readTranslation("Der Moment\r\n\r\nText.\r\n", english, {
    language: "de",
    file: "news/city_founded.md",
  });
  expect(read).toStrictEqual({
    values: new Map([[DOCUMENT_KEY, "Der Moment\n\nText."]]),
    unknownKeys: [],
  });
  const blank = readTranslation("\n", english, { language: "de", format: "markdown" });
  expect(blank.values, "a blank file is a blank value").toStrictEqual(
    new Map([[DOCUMENT_KEY, ""]]),
  );
  const literal = readSource("", { format: "markdown" }).entries;
  expect(
    readTranslation("Text", literal, { language: "de", format: "markdown" }).values,
    "a blank English document has nothing to translate",
  ).toStrictEqual(new Map());
});

test("renderFile writes a document's translation with one final newline, byte-stable", () => {
  const { entries, format } = readSource(ARTICLE, { format: "markdown" });
  const translation = "Der Moment\r\n\r\nText.\r\n\r\n";
  const options = { language: "de", format };
  const rendered = renderFile(entries, new Map([[DOCUMENT_KEY, translation]]), options);
  expect(rendered).toBe("Der Moment\n\nText.\n");
  expect(renderFile(entries, new Map([[DOCUMENT_KEY, translation]]), options)).toBe(rendered);
  const again = readSource(rendered, { format: "markdown" });
  expect(again.entries[0]).toStrictEqual({
    kind: "text",
    keyPath: [],
    value: "Der Moment\n\nText.",
    line: 1,
  });
});

test("renderFile: an untranslated document is the English, or nothing with omit", () => {
  const { entries, format } = readSource(ARTICLE, { format: "markdown" });
  expect(renderFile(entries, new Map(), { language: "de", format })).toBe(`${ARTICLE}\n`);
  expect(renderFile(entries, new Map(), { language: "de", format, untranslated: "omit" })).toBe("");
  const omitted = new Set([DOCUMENT_KEY]);
  expect(
    renderFile(entries, new Map([[DOCUMENT_KEY, "Text"]]), { language: "de", format, omitted }),
    "an omitted (outdated) translation leaves no file",
  ).toBe("");
  const blank = readSource("", { format: "markdown" });
  expect(renderFile(blank.entries, new Map(), { language: "de", format })).toBe("");
});

test("keepUntouchedParagraphs puts back the paragraphs whose English didn't change", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "Title\n\nOld second.\n\nThird.",
    newEnglish: "Title\n\nNew second.\n\nThird.",
    oldTranslation: "Titel\n\nAlter zweiter.\n\nDritter.",
    newTranslation: "Überschrift\n\nNeuer zweiter.\n\nDer dritte.\n",
  });
  expect(kept).toBe("Titel\n\nNeuer zweiter.\n\nDritter.");
});

test("keepUntouchedParagraphs keeps the update's blank lines between paragraphs", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "A\n\nB",
    newEnglish: "A\n\nB2",
    oldTranslation: "Ä\n\nBe",
    newTranslation: "Ah\n\n\nBe zwei",
  });
  expect(kept).toBe("Ä\n\n\nBe zwei");
});

test("keepUntouchedParagraphs returns the update when the paragraphs don't pair up", () => {
  const kept = keepUntouchedParagraphs({
    oldEnglish: "A\n\nB",
    newEnglish: "A\n\nB\n\nC",
    oldTranslation: "Ä\n\nBe",
    newTranslation: "Ah\n\nBe\n\nZe\r\n",
  });
  expect(kept).toBe("Ah\n\nBe\n\nZe");
});

test("blockKind names a paragraph by its first lines", () => {
  expect(blockKind("## Getting started", false)).toBe("a level-2 heading");
  expect(blockKind("Title\n=====", false)).toBe("a level-1 heading");
  expect(blockKind("Title\n-----", false)).toBe("a level-2 heading");
  expect(blockKind("- one\n- two", false)).toBe("a list");
  expect(blockKind("* one", false)).toBe("a list");
  expect(blockKind("1. one\n2. two", false)).toBe("a numbered list");
  expect(blockKind("> Quoted", false)).toBe("a quote");
  expect(blockKind("| a | b |\n|---|---|", false)).toBe("a table");
  expect(blockKind("a | b\n--- | ---", false)).toBe("a table");
  expect(blockKind("```js\ncode\n```", false)).toBe("a code block");
  expect(blockKind("---\ntitle: News\n---", true)).toBe("front matter");
  expect(blockKind("---", false)).toBe("a horizontal rule");
  expect(blockKind("<details>", false)).toBe("HTML");
  expect(blockKind("    indented", false)).toBe("an indented block");
  expect(blockKind("Just text.\nOn two lines.", false)).toBe("a paragraph");
  expect(blockKind("#hashtag", false), "a heading needs a space").toBe("a paragraph");
});

test("verbatimParts: fenced code blocks, whole", () => {
  expect(verbatimParts("Run it:\n\n```sh\nquaso init\n\nquaso upload\n```\n\nDone.")).toStrictEqual(
    ["```sh\nquaso init\n\nquaso upload\n```"],
  );
});

test("verbatimParts: inline code", () => {
  expect(verbatimParts("Type `quaso init`, then ``a ` b``.")).toStrictEqual([
    "`quaso init`",
    "``a ` b``",
  ]);
});

test("verbatimParts: link and image destinations, but not their text or title", () => {
  expect(
    verbatimParts('[Download](https://example.com/dl "The file") ![Map](map.png)'),
  ).toStrictEqual(["https://example.com/dl", "map.png"]);
});

test("verbatimParts: reference definitions and autolinks", () => {
  expect(
    verbatimParts("See [the wiki][w] or <https://example.com>.\n\n[w]: https://wiki"),
  ).toStrictEqual(["https://wiki", "https://example.com"]);
});

test("verbatimParts: front matter keys, not their values", () => {
  expect(verbatimParts("---\ntitle: City founded\ndate: 2026-10-15\n---\n\nText.")).toStrictEqual([
    "title:",
    "date:",
  ]);
});

test("verbatimParts: links to the file's own headings follow the translation", () => {
  expect(verbatimParts("[See below](#installation)")).toStrictEqual([]);
});

test("verbatimParts: a link inside inline code is code", () => {
  expect(verbatimParts("Write `[a](b)` for a link.")).toStrictEqual(["`[a](b)`"]);
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
  expect(headingAnchors(text)).toStrictEqual(
    new Set([
      "getting-started",
      "install-quaso-on-windows",
      "getting-started-1",
      "install",
      "setext",
      "custom",
    ]),
  );
  expect(headingAnchors("## Über die Stadt")).toStrictEqual(new Set(["über-die-stadt"]));
});

test("anchorLinks: the anchors of links to the file itself, decoded", () => {
  expect(
    anchorLinks("[a](#one) [b](https://x#two) [c](#instalaci%C3%B3n) `[d](#code)`"),
  ).toStrictEqual(["one", "instalación"]);
});
