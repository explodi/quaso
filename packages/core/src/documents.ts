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
