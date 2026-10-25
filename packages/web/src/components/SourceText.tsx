// SPDX-License-Identifier: MIT
/**
 * Text with its placeholders highlighted and its nesting references shown masked (`⟦1⟧`),
 * with a hint of what they refer to. Spaces and line breaks at either end, which the page
 * would otherwise hide, show as signs (`·`, `↵`): a translation should usually have them too. Everything is rendered as text, never as HTML (design
 * §8: whatever people and the LLM write is user content).
 *
 * With `tree`, an ICU message with blocks shows as a tree: each block's cases one per line,
 * labelled with their keys, and blocks inside a case indented under it.
 */
import {
  blockLabel,
  describeWhitespace,
  glossaryMatches,
  type GlossaryTerm,
  type IcuNode,
  type InterpolationSyntax,
  maskToken,
  parseIcu,
  tokenize,
} from "@quaso/core";
import { Fragment, type ReactNode, useId } from "react";
import type { Masking } from "../lib/masking.ts";

export function SourceText({
  text,
  syntax,
  masking,
  lang,
  dir,
  glossary = [],
  tree = false,
}: {
  text: string;
  glossary?: GlossaryTerm[];
  syntax: InterpolationSyntax;
  /** Show the references masked, numbered as in the editor's chips. */
  masking?: Pick<Masking, "enabled" | "references" | "chips">;
  lang?: string;
  dir?: "ltr" | "rtl";
  /** Show ICU blocks as a tree of cases rather than in one line. */
  tree?: boolean;
}) {
  const hasVisibleText = text.trim() !== "";
  const leading = hasVisibleText ? (LEADING_WHITESPACE.exec(text)?.[0] ?? "") : "";
  const trailing = hasVisibleText ? (TRAILING_WHITESPACE.exec(text)?.[0] ?? "") : "";
  const inner = text.slice(leading.length, text.length - trailing.length);
  const nodes = tree && syntax.icu ? parseIcu(inner) : [];
  if (nodes.some((node) => node.type === "block")) {
    return (
      <span className="source-text source-tree" lang={lang} dir={dir}>
        <EdgeWhitespace whitespace={leading} edge="start" />
        <IcuMessage text={inner} nodes={nodes} glossary={glossary} />
        <EdgeWhitespace whitespace={trailing} edge="end" />
      </span>
    );
  }
  const tokens = tokenize(inner, syntax);
  return (
    <span className="source-text" lang={lang} dir={dir}>
      <EdgeWhitespace whitespace={leading} edge="start" />
      {tokens.map((token, index) => {
        if (token.type === "text") {
          return <GlossaryText key={index} text={token.text} terms={glossary} />;
        }
        if (token.type === "placeholder") {
          return (
            <mark key={index} className="ph">
              {token.raw}
            </mark>
          );
        }
        if (token.type === "syntax") {
          return (
            <span key={index} className="icu-syntax">
              {token.raw}
            </span>
          );
        }
        const n = masking?.references.indexOf(token.raw) ?? -1;
        if (!masking?.enabled || n < 0) {
          return (
            <mark key={index} className="ref">
              {token.raw}
            </mark>
          );
        }
        const english = masking.chips.find((chip) => chip.raw === token.raw)?.english;
        const hint = english ? `${token.raw}: “${english}”` : token.raw;
        return (
          <mark key={index} className="ref" title={hint}>
            {maskToken(n + 1)}
            <span className="sr-only">(reference {hint})</span>
          </mark>
        );
      })}
      <EdgeWhitespace whitespace={trailing} edge="end" />
    </span>
  );
}

/** A message of the tree: text and arguments inline, each block on lines of its own. */
function IcuMessage({
  text,
  nodes,
  glossary,
}: {
  text: string;
  nodes: IcuNode[];
  glossary: GlossaryTerm[];
}) {
  const pieces: ReactNode[] = [];
  let line: ReactNode[] = [];
  let lineHasText = false;
  const endLine = () => {
    // Space between blocks is layout, not text to read.
    if (lineHasText) {
      pieces.push(
        <span key={pieces.length} className="icu-line">
          {line}
        </span>,
      );
    }
    line = [];
    lineHasText = false;
  };
  nodes.forEach((node, index) => {
    if (node.type === "block") {
      endLine();
      pieces.push(
        <span key={pieces.length} className="icu-block">
          <span className="icu-syntax icu-block-head">{blockLabel(node)}</span>
          <span className="icu-cases" role="list">
            {node.cases.map((icuCase, caseIndex) => (
              <span key={caseIndex} className="icu-case" role="listitem">
                <span className="icu-case-key">
                  {icuCase.key}
                  <span className="sr-only">: </span>
                </span>
                <span className="icu-case-message">
                  {isBlank(text, icuCase.message) ? (
                    <span className="muted">(empty)</span>
                  ) : (
                    <IcuMessage text={text} nodes={icuCase.message} glossary={glossary} />
                  )}
                </span>
              </span>
            ))}
          </span>
        </span>,
      );
      return;
    }
    let raw = text.slice(node.start, node.end);
    if (node.type === "text") {
      // Each block has lines of its own, so the spaces that part it from the text go.
      if (nodes[index - 1]?.type === "block") raw = raw.trimStart();
      if (nodes[index + 1]?.type === "block") raw = raw.trimEnd();
      lineHasText ||= raw !== "";
      line.push(<GlossaryText key={node.start} text={raw} terms={glossary} />);
    } else {
      lineHasText = true;
      line.push(
        <mark key={node.start} className="ph">
          {raw}
        </mark>,
      );
    }
  });
  endLine();
  return <Fragment>{pieces}</Fragment>;
}

function isBlank(text: string, nodes: IcuNode[]): boolean {
  return nodes.every(
    (node) => node.type === "text" && text.slice(node.start, node.end).trim() === "",
  );
}

const LEADING_WHITESPACE = /^\s+/;
const TRAILING_WHITESPACE = /\s+$/;

function EdgeWhitespace({ whitespace, edge }: { whitespace: string; edge: "start" | "end" }) {
  if (whitespace === "") return null;
  const signs = Array.from(whitespace.replaceAll("\r\n", "\n"), (character) => {
    if (character === "\n" || character === "\r") return "↵";
    if (character === "\t") return "→";
    return "·";
  }).join("");
  const description = `${edge === "start" ? "Starts" : "Ends"} with ${describeWhitespace(whitespace)}`;
  return (
    <span className="edge-whitespace" title={description}>
      <span aria-hidden="true">{signs}</span>
      <span className="sr-only">({description})</span>
    </span>
  );
}

/** Longest term wins where glossary entries overlap; the source text stays selectable. */
function GlossaryText({ text, terms }: { text: string; terms: GlossaryTerm[] }) {
  const matches = terms
    .flatMap((term) =>
      glossaryMatches(text, term.term, term.caseSensitive).map((match) => ({ ...match, term })),
    )
    .sort((a, b) => a.start - b.start || b.end - a.end || a.term.id - b.term.id);
  const content: ReactNode[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start < offset) continue;
    content.push(text.slice(offset, match.start));
    content.push(
      <GlossaryHint key={`${match.start}:${match.term.id}`} term={match.term}>
        {text.slice(match.start, match.end)}
      </GlossaryHint>,
    );
    offset = match.end;
  }
  content.push(text.slice(offset));
  return <Fragment>{content}</Fragment>;
}

function GlossaryHint({ term, children }: { term: GlossaryTerm; children: ReactNode }) {
  const id = useId();
  return (
    <span
      className="glossary-highlight"
      tabIndex={0}
      aria-describedby={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.blur();
      }}
    >
      {children}
      <span id={id} role="tooltip" className="glossary-tooltip">
        {term.kind === "keep" ? "Never translate; keep unchanged." : term.translation}
        {term.note && ` — ${term.note}`}
      </span>
    </span>
  );
}
