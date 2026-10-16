// SPDX-License-Identifier: MIT
/**
 * Documents: source files that are translated whole, such as Markdown articles. A document
 * is one string whose key path is empty, so the file is its identity: the same tables,
 * colours, history and checks as a JSON string, with the file as the unit of work.
 *
 * A document's value is its text with line endings normalized to `\n` and no whitespace at
 * the end, so that an editor's final newline never counts as a change. Downloads write the
 * value with one final newline. Paragraphs, blocks separated by blank lines, are the
 * structure a translation must keep.
 */
import type { JsonFormat } from "./json.ts";
import { entryKey } from "./types.ts";

/**
 * The most words a document may have to be translated by the LLM: one answer holds the whole
 * translation, and a longer one risks the provider's time limit or being cut off.
 */
export const MAX_DOCUMENT_WORDS = 6000;

/** The `entryKey()` of a document's string: an empty key path. */
export const DOCUMENT_KEY: string = entryKey("text", []);

/** Whether a string's key (its `entryKey()`) is a document's. */
export function isDocumentKey(key: string): boolean {
  return key === DOCUMENT_KEY;
}

/** The format of a Markdown document, as the `files` table stores it. */
export interface MarkdownFormat {
  type: "markdown";
}

export const MARKDOWN_FORMAT: MarkdownFormat = { type: "markdown" };

/** The format of a source file: how an i18next JSON file is laid out, or a Markdown document. */
export type FileFormat = JsonFormat | MarkdownFormat;

export function isMarkdownFormat(format: FileFormat): format is MarkdownFormat {
  return "type" in format && format.type === "markdown";
}

/** The formats of source files, by name. */
export type FormatName = "json" | "markdown";

/**
 * The format a source file's path implies: `.json` is an i18next file, `.md` or `.markdown`
 * a Markdown document, anything else is unsupported (`undefined`).
 */
export function formatForPath(path: string): FormatName | undefined {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  return undefined;
}

/**
 * A document's text as it is stored and compared: without a byte order mark, with `\n`
 * line endings, and without whitespace at the end.
 */
export function normalizeDocument(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+$/, "");
}

/** The paragraphs of a document: its blocks of lines, separated by blank lines. */
export function paragraphsOf(text: string): string[] {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") return [];
  return trimmed.split(/\n(?:[ \t]*\n)+/);
}

export function paragraphCount(text: string): number {
  return paragraphsOf(text).length;
}

/**
 * A document split into paragraphs and the blank lines between them, so that paragraphs can
 * be replaced one by one and joined back as written: paragraph `i` is `parts[2 * i]`.
 */
function paragraphParts(text: string): { start: string; parts: string[] } {
  const normalized = normalizeDocument(text);
  const start = /^\s*/.exec(normalized)![0];
  return { start, parts: normalized.slice(start.length).split(/(\n(?:[ \t]*\n)+)/) };
}

/**
 * A document's updated translation, with the paragraphs whose English didn't change put back
 * as they were translated: an update for a changed sentence then can't reword proofread
 * paragraphs around it. The update is returned as is (normalized) when the four texts don't
 * have the same number of paragraphs, since paragraphs then don't pair up.
 */
export function keepUntouchedParagraphs(input: {
  /** The English the current translation was made for. */
  oldEnglish: string;
  newEnglish: string;
  /** The current translation. */
  oldTranslation: string;
  /** The update of the translation for `newEnglish`. */
  newTranslation: string;
}): string {
  const oldEnglish = paragraphsOf(input.oldEnglish);
  const newEnglish = paragraphsOf(input.newEnglish);
  const oldTranslation = paragraphsOf(input.oldTranslation);
  const updated = paragraphParts(input.newTranslation);
  const count = newEnglish.length;
  const lined = [oldEnglish.length, oldTranslation.length, (updated.parts.length + 1) / 2];
  if (lined.some((length) => length !== count)) return normalizeDocument(input.newTranslation);
  for (let index = 0; index < count; index++) {
    if (oldEnglish[index] === newEnglish[index]) updated.parts[2 * index] = oldTranslation[index];
  }
  return updated.start + updated.parts.join("");
}

/**
 * What a paragraph of a Markdown document is, from its first lines, in words: "a level-2
 * heading", "a list", "a numbered list", "a quote", "a table", "a code block", "front
 * matter", "a horizontal rule", "HTML", "an indented block" or "a paragraph". `first` says
 * whether it is the document's first paragraph, where front matter can be.
 */
export function blockKind(paragraph: string, first: boolean): string {
  const [line, next = ""] = paragraph.split("\n");
  if (first && line === "---") return "front matter";
  if (/^ {4,}|^\t/.test(line)) return "an indented block";
  const atx = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
  if (atx) return `a level-${atx[1].length} heading`;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return "a code block";
  if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
    return "a horizontal rule";
  }
  if (/^ {0,3}>/.test(line)) return "a quote";
  if (/^ {0,3}[-*+](?:[ \t]|$)/.test(line)) return "a list";
  if (/^ {0,3}\d{1,9}[.)](?:[ \t]|$)/.test(line)) return "a numbered list";
  // A delimiter row needs a pipe: `-----` alone underlines a heading.
  const delimiterRow = TABLE_DELIMITER_ROW.test(next) && next.includes("|");
  if (/^ {0,3}\|/.test(line) || delimiterRow) return "a table";
  if (/^ {0,3}</.test(line)) return "HTML";
  if (/^ {0,3}=+[ \t]*$/.test(next)) return "a level-1 heading";
  if (/^ {0,3}-+[ \t]*$/.test(next)) return "a level-2 heading";
  return "a paragraph";
}

const TABLE_DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A document's lines, told apart: in a fenced code block, in front matter, or prose. */
interface DocumentLines {
  /** Each fenced code block, fences included. */
  codeBlocks: string[];
  /** The keys of the front matter, such as `title:`. */
  frontMatterKeys: string[];
  /** The other lines. */
  prose: string[];
}

function documentLines(text: string): DocumentLines {
  const lines = normalizeDocument(text).split("\n");
  const result: DocumentLines = { codeBlocks: [], frontMatterKeys: [], prose: [] };
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const key = /^([\w-]+):/.exec(line);
        if (key) result.frontMatterKeys.push(`${key[1]}:`);
      }
      index = end + 1;
    }
  }
  while (index < lines.length) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (!fence) {
      result.prose.push(lines[index]);
      index++;
      continue;
    }
    // A fence closes with a line of the same character, at least as long; or at the end.
    const marker = fence[1];
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) end++;
    result.codeBlocks.push(lines.slice(index, end + 1).join("\n"));
    index = end + 1;
  }
  return result;
}

/**
 * The parts of a Markdown document that a translation keeps exactly as written, in order:
 * fenced code blocks, inline code, the destinations of links and images (except links to a
 * heading of the same file, `#…`, which follow the translated heading), autolinks and the
 * keys of the front matter.
 */
export function verbatimParts(text: string): string[] {
  const lines = documentLines(text);
  const parts = [...lines.frontMatterKeys, ...lines.codeBlocks];
  const prose = lines.prose.join("\n");
  const codeSpans = Array.from(prose.matchAll(CODE_SPAN), ([span]) => span);
  parts.push(...codeSpans);
  // Destinations inside code spans are code, not links.
  const outsideCode = prose.replace(CODE_SPAN, " ");
  const destinations = [
    ...Array.from(outsideCode.matchAll(INLINE_DESTINATION), (match) => match[1]),
    ...Array.from(outsideCode.matchAll(REFERENCE_DESTINATION), (match) => match[1]),
    ...Array.from(outsideCode.matchAll(AUTOLINK), (match) => match[1]),
  ];
  parts.push(...destinations.filter((destination) => !destination.startsWith("#")));
  return parts;
}

const CODE_SPAN = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const INLINE_DESTINATION = /\]\(\s*<?([^\s<>()]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DESTINATION = /^ {0,3}\[[^\]]+\]:[ \t]*<?([^\s<>]+)>?/gm;
const AUTOLINK = /<((?:https?|mailto|ftp):[^\s<>]+)>/g;

/**
 * The anchors a Markdown document's headings get, as GitHub writes them (`## Getting
 * started` is `#getting-started`, a second one `#getting-started-1`), with the explicit
 * ones: `{#id}` after a heading, and `<a id="…">` or `<a name="…">`.
 */
export function headingAnchors(text: string): Set<string> {
  const prose = documentLines(text).prose;
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (let index = 0; index < prose.length; index++) {
    const line = prose[index];
    const next = prose[index + 1] ?? "";
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const setext = line.trim() !== "" && /^ {0,3}(?:=+|-+)[ \t]*$/.test(next);
    const heading = atx ? atx[1] : setext ? line.trim() : null;
    for (const [, id] of line.matchAll(EXPLICIT_ANCHOR)) anchors.add(id);
    if (heading === null) continue;
    const explicit = /[ \t]*\{#([^}\s]+)\}$/.exec(heading);
    if (explicit) {
      anchors.add(explicit[1]);
      continue;
    }
    const slug = headingSlug(heading);
    const repeats = seen.get(slug) ?? 0;
    seen.set(slug, repeats + 1);
    anchors.add(repeats === 0 ? slug : `${slug}-${repeats}`);
  }
  return anchors;
}

const EXPLICIT_ANCHOR = /<a\s[^>]*?(?:id|name)=["']([^"']+)["']/g;

/** A heading's anchor as GitHub makes it: its text in lower case, without punctuation. */
function headingSlug(heading: string): string {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** The anchors that a Markdown document's links to itself name, `#…`, without the `#`. */
export function anchorLinks(text: string): string[] {
  const outsideCode = documentLines(text).prose.join("\n").replace(CODE_SPAN, " ");
  const destinations = [
    ...Array.from(outsideCode.matchAll(INLINE_DESTINATION), (match) => match[1]),
    ...Array.from(outsideCode.matchAll(REFERENCE_DESTINATION), (match) => match[1]),
  ];
  return destinations
    .filter((destination) => destination.startsWith("#") && destination.length > 1)
    .map((destination) => decodeAnchor(destination.slice(1)));
}

/** An anchor as written in a link: `#instalaci%C3%B3n` is `instalación`. */
function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}
