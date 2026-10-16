// SPDX-License-Identifier: MIT
/**
 * How a text changed, as a word diff: removed words struck out, new ones marked. A document
 * shows only its changed paragraphs, each under its number.
 */
import { changedParagraphs, type DiffPart, wordDiff } from "../lib/diff.ts";

export function ParagraphChanges({
  before,
  after,
  document,
  lang,
  className,
}: {
  before: string;
  after: string;
  /** A whole file: only its changed paragraphs are shown. */
  document: boolean;
  lang: string;
  /** The class of each text paragraph. */
  className: string;
}) {
  const paragraphs = document ? changedParagraphs(before, after) : null;
  if (paragraphs === null) {
    return (
      <p className={className} lang={lang} dir="auto">
        <Diff parts={wordDiff(before, after)} />
      </p>
    );
  }
  if (paragraphs.length === 0) {
    return <p className="muted">No paragraph changed.</p>;
  }
  return (
    <ol className="paragraph-changes">
      {paragraphs.map((paragraph) => (
        <li key={paragraph.number}>
          <span className="paragraph-number muted">Paragraph {paragraph.number}</span>
          <p className={className} lang={lang} dir="auto">
            <Diff parts={paragraph.diff} />
          </p>
        </li>
      ))}
    </ol>
  );
}

function Diff({ parts }: { parts: DiffPart[] }) {
  return parts.map((part, index) =>
    part.kind === "added" ? (
      <ins key={index}>{part.text}</ins>
    ) : part.kind === "removed" ? (
      <del key={index}>{part.text}</del>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
