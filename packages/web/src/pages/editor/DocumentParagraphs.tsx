// SPDX-License-Identifier: MIT
/**
 * A document edited paragraph by paragraph: each English paragraph beside the input for its
 * translation. The translation is the paragraphs joined by blank lines, so it keeps the
 * English's number of paragraphs by construction.
 */
import { paragraphsOf } from "@quaso/core";
import { Notice, TextArea } from "@quaso/design-system";
import { useState } from "react";

export function DocumentParagraphs({
  english,
  text,
  onChange,
  onFocusInput,
  language,
  languageName,
  direction,
  sourceLanguage,
  sourceDirection,
}: {
  english: string;
  /** The translation, as typed so far. */
  text: string;
  onChange(text: string): void;
  /** A paragraph's input got the focus: placeholders and shortcuts insert there. */
  onFocusInput(element: HTMLTextAreaElement): void;
  language: string;
  languageName: string;
  direction: "ltr" | "rtl";
  sourceLanguage: string;
  sourceDirection: "ltr" | "rtl";
}) {
  const englishParagraphs = paragraphsOf(english);
  // Typed paragraphs stay as typed, empty ones included, which joining and splitting the
  // text again would lose; any other change of the text (a suggestion taken) starts over.
  const [typed, setTyped] = useState<string[] | null>(null);
  const typedIsCurrent = typed !== null && typed.join("\n\n") === text;
  const fromText = text.trim() === "" ? englishParagraphs.map(() => "") : paragraphsOf(text);
  const paragraphs = typedIsCurrent ? typed : fromText;

  if (paragraphs.length !== englishParagraphs.length) {
    return (
      <Notice kind="warning" title="The paragraphs don't line up">
        <p>
          The translation has {paragraphs.length} paragraphs and the English{" "}
          {englishParagraphs.length}. Fix them in the whole file to edit them side by side.
        </p>
      </Notice>
    );
  }

  const change = (index: number, value: string) => {
    const next = paragraphs.map((paragraph, n) => (n === index ? value : paragraph));
    setTyped(next);
    onChange(next.join("\n\n"));
  };

  return (
    <ol className="document-paragraphs">
      {englishParagraphs.map((paragraph, index) => (
        <li key={index} className="document-paragraph">
          <p className="document-paragraph-english" lang={sourceLanguage} dir={sourceDirection}>
            {paragraph}
          </p>
          <TextArea
            aria-label={`Paragraph ${index + 1} in ${languageName}`}
            lang={language}
            dir={direction}
            data-translation-input=""
            value={paragraphs[index]}
            minRows={2}
            spellCheck
            onFocus={(event) => onFocusInput(event.currentTarget)}
            onChange={(event) => change(index, event.target.value)}
          />
        </li>
      ))}
    </ol>
  );
}
