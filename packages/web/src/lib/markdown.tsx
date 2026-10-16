// SPDX-License-Identifier: MIT
/**
 * A preview of a Markdown document, for translators: headings, paragraphs, lists, quotes,
 * tables, code and inline emphasis, code and links. It builds React elements, never HTML from
 * the text, so a translation can't inject markup; raw HTML shows as text. Images show their
 * alt text instead of loading. Headings are styled paragraphs, so the page's own heading
 * outline stays the editor's.
 */
import { A, Table } from "@quaso/design-system";
import type { ReactNode } from "react";

export function MarkdownPreview({
  text,
  lang,
  dir,
}: {
  text: string;
  lang: string;
  dir: "ltr" | "rtl";
}) {
  return (
    <div className="markdown-preview" lang={lang} dir={dir}>
      {blocks(text.replace(/\r\n?/g, "\n").split("\n"))}
    </div>
  );
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** The blocks of a list of lines. */
function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      out.push(
        <pre key="front-matter" className="markdown-front-matter">
          {lines.slice(0, end + 1).join("\n")}
        </pre>,
      );
      index = end + 1;
    }
  }
  while (index < lines.length) {
    const line = lines[index];
    const key = out.length;
    if (line.trim() === "") {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      let end = index + 1;
      while (end < lines.length && !closing.test(lines[end])) end++;
      out.push(
        <pre key={key} className="markdown-code">
          <code>{lines.slice(index + 1, end).join("\n")}</code>
        </pre>,
      );
      index = end + 1;
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      out.push(headingBlock(key, heading[1].length, heading[2] ?? ""));
      index++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key} />);
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(QUOTE.exec(lines[index])![1]);
        index++;
      }
      out.push(<blockquote key={key}>{blocks(quoted)}</blockquote>);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /\d/.test(LIST_ITEM.exec(line)![1]);
      const items: string[] = [];
      while (index < lines.length && lines[index].trim() !== "") {
        const item = LIST_ITEM.exec(lines[index]);
        if (item) items.push(item[2]);
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index++;
      }
      const children = items.map((item, n) => <li key={n}>{inline(item)}</li>);
      out.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }
    const next = lines[index + 1] ?? "";
    const isTable = line.includes("|") && next.includes("|") && TABLE_DELIMITER.test(next);
    if (isTable) {
      const rows: string[][] = [cells(line)];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(cells(lines[index]));
        index++;
      }
      out.push(tableBlock(key, rows));
      continue;
    }
    // A paragraph runs to a blank line or the start of another block.
    // A paragraph runs to a blank line or the start of another block; an underline of `=` or
    // `-` makes it a heading.
    const paragraph: string[] = [line];
    let headingLevel = 0;
    index++;
    while (index < lines.length && !startsBlock(lines[index])) {
      const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index]);
      index++;
      if (underline) {
        headingLevel = underline[1][0] === "=" ? 1 : 2;
        break;
      }
      paragraph.push(lines[index - 1]);
    }
    if (headingLevel > 0) out.push(headingBlock(key, headingLevel, paragraph.join(" ")));
    else out.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return out;
}

function startsBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    FENCE.test(line) ||
    ATX_HEADING.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

function headingBlock(key: number, level: number, text: string): ReactNode {
  const withoutAnchor = text.replace(/[ \t]*\{#[^}\s]+\}$/, "");
  return (
    <p key={key} className={`markdown-heading markdown-heading-${level}`}>
      {inline(withoutAnchor)}
    </p>
  );
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function tableBlock(key: number, rows: string[][]): ReactNode {
  const [head, ...body] = rows;
  return (
    <div key={key} className="markdown-table">
      <Table>
        <thead>
          <tr>
            {head.map((cell, n) => (
              <th key={n}>{inline(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, n) => (
                <td key={n}>{inline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * Inline Markdown: code spans first (nothing inside them is Markdown), then images, links,
 * strong, emphasis and strikethrough, each parsed again inside.
 */
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(\s*<?([^\s<>()]+)>?[^)]*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*?)_(?![\p{L}\p{N}])|~~([\s\S]+?)~~/u;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const key = out.length;
    const [whole, , code, alt, linkText, href, strong, strongUnderscores, em, emUnderscores, del] =
      match;
    if (code !== undefined) out.push(<code key={key}>{code.trim()}</code>);
    else if (alt !== undefined)
      out.push(
        <span key={key} className="markdown-image">
          {alt || "image"}
        </span>,
      );
    else if (linkText !== undefined) out.push(link(key, linkText, href));
    else if (strong !== undefined || strongUnderscores !== undefined)
      out.push(<strong key={key}>{inline(strong ?? strongUnderscores)}</strong>);
    else if (em !== undefined || emUnderscores !== undefined)
      out.push(<em key={key}>{inline(em ?? emUnderscores)}</em>);
    else out.push(<del key={key}>{inline(del)}</del>);
    rest = rest.slice(match.index + whole.length);
  }
  return out;
}

/** A link opens in a new tab when it leaves the file; other destinations aren't followed. */
function link(key: number, text: string, href: string): ReactNode {
  const external = /^(?:https?:|mailto:)/i.test(href);
  if (!external) {
    return (
      <span key={key} className="markdown-link">
        {inline(text)}
      </span>
    );
  }
  return (
    <A key={key} href={href} target="_blank" rel="noopener noreferrer">
      {inline(text)}
    </A>
  );
}
