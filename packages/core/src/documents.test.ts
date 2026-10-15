// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertStrictEquals } from "@std/assert";
import { FilePath } from "./api.ts";
import {
  DOCUMENT_KEY,
  formatForPath,
  isDocumentKey,
  isMarkdownFormat,
  MARKDOWN_FORMAT,
  normalizeDocument,
  paragraphCount,
  paragraphsOf,
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
