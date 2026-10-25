// SPDX-License-Identifier: MIT
/**
 * Help with ICU messages beside a translation input: the cases each plural block needs in
 * the target language, with example numbers, and a preview of the translation in each case.
 */
import {
  blockCategories,
  exampleNumbers,
  type IcuNode,
  type IcuPreviewChoice,
  icuPreview,
  icuSyntaxError,
  parseIcu,
  type PluralCategory,
  type PluralOverride,
} from "@quaso/core";
import { Details, Summary, WarningIcon } from "@quaso/design-system";
import { useMemo } from "react";
import { useDebounced } from "../../lib/hooks.ts";

/** The cases the plural blocks of one kind need in a language. */
export interface PluralCaseHint {
  kind: "plural" | "ordinal";
  /** The blocks' arguments, each once, such as `guests`. */
  arguments: string[];
  categories: { category: PluralCategory; examples: string }[];
  /** The English's exact cases, such as `=0`, which every language keeps. */
  exact: string[];
}

/**
 * The cases the English's plural and selectordinal blocks need in a language, outermost
 * block first. Blocks that need the same categories share one hint.
 */
export function pluralCaseHints(
  english: string,
  language: string,
  override?: PluralOverride,
): PluralCaseHint[] {
  const hints: PluralCaseHint[] = [];
  const visit = (nodes: IcuNode[]) => {
    for (const node of nodes) {
      if (node.type !== "block") continue;
      const categories =
        node.blockType === "select" ? null : blockCategories(node, language, override);
      if (categories !== null) {
        const kind = node.blockType === "selectordinal" ? "ordinal" : "plural";
        const zero = kind === "plural" && node.cases.some((icuCase) => icuCase.key === "zero");
        const exact = node.cases.map((icuCase) => icuCase.key).filter((key) => key.startsWith("="));
        const listed = categories.map((category) => ({
          category,
          examples: categoryExamples(language, category, kind, zero),
        }));
        const same = hints.find(
          (hint) => hint.kind === kind && sameCategories(hint.categories, listed),
        );
        if (same) {
          addOnce(same.arguments, [node.name]);
          addOnce(same.exact, exact);
        } else {
          hints.push({ kind, arguments: [node.name], categories: listed, exact });
        }
      }
      for (const icuCase of node.cases) visit(icuCase.message);
    }
  };
  visit(parseIcu(english));
  return hints;
}

function categoryExamples(
  language: string,
  category: PluralCategory,
  kind: "plural" | "ordinal",
  zero: boolean,
): string {
  try {
    return exampleNumbers(language, category, { ordinal: kind === "ordinal", zero });
  } catch {
    return "";
  }
}

function sameCategories(a: { category: string }[], b: { category: string }[]): boolean {
  return a.map((entry) => entry.category).join() === b.map((entry) => entry.category).join();
}

function addOnce(list: string[], items: string[]) {
  for (const item of items) if (!list.includes(item)) list.push(item);
}

/** "Spanish plural cases for {guests}: one (1), many (1000000, …), other (0, 2–999, …)". */
export function PluralCaseHints({
  id,
  hints,
  languageName,
}: {
  id: string;
  hints: PluralCaseHint[];
  languageName: string;
}) {
  if (hints.length === 0) return null;
  return (
    <div id={id} className="icu-case-hints">
      {hints.map((hint, index) => (
        <p key={index} className="icu-case-hint">
          {languageName} {hint.kind} cases for{" "}
          {hint.arguments.map((name, at) => (
            <span key={name}>
              {at > 0 && ", "}
              <code>{`{${name}}`}</code>
            </span>
          ))}
          :{" "}
          {hint.categories.map(({ category, examples }, at) => (
            <span key={category} className="icu-case-hint-category">
              {at > 0 && ", "}
              <span className="form-name">{category}</span>
              {examples !== "" && <span className="form-examples"> ({examples})</span>}
            </span>
          ))}
          {hint.exact.length > 0 && (
            <>
              . Keep the English's exact {hint.exact.length === 1 ? "case" : "cases"}{" "}
              {hint.exact.map((key, at) => (
                <span key={key}>
                  {at > 0 && ", "}
                  <span className="form-name">{key}</span>
                </span>
              ))}
            </>
          )}
          .
        </p>
      ))}
    </div>
  );
}

/**
 * The translation as the app shows it in each case, or where it stops being valid ICU.
 * It follows the typing after a short pause, so it doesn't flicker on every key.
 */
export function IcuPreviewList({
  text,
  language,
  override,
  dir,
}: {
  text: string;
  language: string;
  override?: PluralOverride;
  dir: "ltr" | "rtl";
}) {
  const shown = useDebounced(text, 250);
  const error = useMemo(() => icuSyntaxError(shown), [shown]);
  const preview = useMemo(() => icuPreview(shown, language, override), [shown, language, override]);
  const hasBlocks = preview.rows.some((row) => row.choices.length > 0);
  if (shown.trim() === "" || (!hasBlocks && error === null)) return null;
  return (
    <Details className="icu-preview" open>
      <Summary>Preview in each case</Summary>
      {error !== null ? (
        <SyntaxProblem
          text={shown}
          message={error.message}
          at={error.at}
          language={language}
          dir={dir}
        />
      ) : (
        <ul className="icu-preview-rows">
          {preview.rows.map((row, index) => (
            <li key={index} className="icu-preview-row">
              <span className="icu-preview-cases">
                {row.choices.map((choice, at) => (
                  <span key={at}>
                    {at > 0 && " · "}
                    <ChoiceLabel choice={choice} />
                  </span>
                ))}
                <span className="sr-only">: </span>
              </span>
              <span className="icu-preview-text" lang={language} dir={dir}>
                {row.parts.length === 0 && <span className="muted">(empty)</span>}
                {row.parts.map((part, at) =>
                  part.type === "text" ? (
                    <span key={at}>{part.text}</span>
                  ) : (
                    <mark key={at} className="ph">
                      {part.text}
                    </mark>
                  ),
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error === null && preview.truncated && (
        <p className="muted small">The first {preview.rows.length} combinations of cases.</p>
      )}
    </Details>
  );
}

/** `female`, `=0`, or `many` with its example number. */
function ChoiceLabel({ choice }: { choice: IcuPreviewChoice }) {
  const showsNumber = choice.number !== undefined && !choice.key.startsWith("=");
  return (
    <>
      <span className="form-name">{choice.key}</span>
      {showsNumber && <span className="form-examples"> {choice.number}</span>}
    </>
  );
}

/** Where the text stops being valid ICU: the message, and the text around that place. */
function SyntaxProblem({
  text,
  message,
  at,
  language,
  dir,
}: {
  text: string;
  message: string;
  at: number;
  language: string;
  dir: "ltr" | "rtl";
}) {
  const from = Math.max(0, at - EXCERPT);
  const to = Math.min(text.length, at + 1 + EXCERPT);
  return (
    <div className="icu-preview-problem" role="status">
      <p className="check check-error">
        <WarningIcon />
        <span>
          The translation isn't valid ICU at character {at + 1}: {message}
        </span>
      </p>
      <p className="icu-preview-excerpt" lang={language} dir={dir}>
        {from > 0 && "…"}
        {text.slice(from, at)}
        <mark className="icu-preview-mark">{text[at]}</mark>
        {text.slice(at + 1, to)}
        {to < text.length && "…"}
      </p>
    </div>
  );
}

/** Characters of text shown on each side of a syntax problem. */
const EXCERPT = 24;
