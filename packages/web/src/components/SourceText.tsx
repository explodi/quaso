// SPDX-License-Identifier: MIT
/**
 * Text with its placeholders highlighted and its nesting references shown masked (`⟦1⟧`),
 * with a hint of what they refer to. Everything is rendered as text, never as HTML (design
 * §8: whatever people and the LLM write is user content).
 */
import {
  glossaryMatches,
  type GlossaryTerm,
  type InterpolationSyntax,
  maskToken,
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
}: {
  text: string;
  glossary?: GlossaryTerm[];
  syntax: InterpolationSyntax;
  /** Show the references masked, numbered as in the editor's chips. */
  masking?: Pick<Masking, "enabled" | "references" | "chips">;
  lang?: string;
  dir?: "ltr" | "rtl";
}) {
  const tokens = tokenize(text, syntax);
  return (
    <span className="source-text" lang={lang} dir={dir}>
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
