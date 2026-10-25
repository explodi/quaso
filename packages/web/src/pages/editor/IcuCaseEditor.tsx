// SPDX-License-Identifier: MIT
/**
 * The case editor: an ICU translation written case by case, one field per text of the
 * English's structure, with the blocks' syntax locked (core's `icu_fields.ts` reads and
 * writes the fields). It is the default for strings whose English has blocks; "Edit as text"
 * shows the ICU itself in the panel's ordinary input instead.
 */
import {
  exampleNumbers,
  type IcuField,
  type IcuFieldForm,
  icuFieldForm,
  type IcuPart,
  icuSyntaxError,
  parseIcu,
  type PluralCategory,
  type PluralOverride,
  writeIcuFieldForm,
} from "@quaso/core";
import { InfoIcon, Label, Switch, TextArea } from "@quaso/design-system";
import { type ReactNode, useMemo, useState } from "react";
import { EdgeWhitespace } from "../../components/SourceText.tsx";

export interface IcuFields {
  /** The fields of the translation, or null when they can't show it. */
  form: IcuFieldForm | null;
  /** Whether the fields are shown, rather than the text input. */
  shown: boolean;
  /** Turns "Edit as text" on or off. */
  setAsText(asText: boolean): void;
  /** After typing in the text input: it stays, even once its text fits the fields. */
  keepText(): void;
  /** The translation with a field's new text. */
  write(field: IcuField, text: string): string;
}

/**
 * The case editor's state for a string: null unless the English has ICU blocks. The fields
 * show when the translation fits them, unless the translator chose to edit the text; a
 * translation that doesn't fit when the string opens is edited as text.
 */
export function useIcuFields(
  english: string | null,
  text: string,
  pristine: string,
  language: string,
  override?: PluralOverride,
): IcuFields | null {
  const withBlocks = useMemo(
    () =>
      english !== null && parseIcu(english).some((node) => node.type === "block") ? english : null,
    [english],
  );
  const form = useMemo(
    () => (withBlocks === null ? null : icuFieldForm(withBlocks, text, language, override)),
    [withBlocks, text, language, override],
  );
  // Written back unchanged, the saved translation may differ in quoting or spacing; when the
  // fields come back to it, the edit is no edit.
  const pristineWritten = useMemo(() => {
    const saved =
      withBlocks === null ? null : icuFieldForm(withBlocks, pristine, language, override);
    return saved === null ? null : writeIcuFieldForm(saved);
  }, [withBlocks, pristine, language, override]);
  const [mode, setMode] = useState<"fields" | "text">(() => (form === null ? "text" : "fields"));
  if (withBlocks === null) return null;
  return {
    form,
    shown: mode === "fields" && form !== null,
    setAsText: (asText) => setMode(asText ? "text" : "fields"),
    keepText: () => setMode("text"),
    write: (field, fieldText) => {
      const next = form === null ? text : writeIcuFieldForm(form, new Map([[field, fieldText]]));
      return next === pristineWritten ? pristine : next;
    },
  };
}

/**
 * The "Edit as text" switch, then the fields or the text input. A translation the fields
 * can't show gets a note saying why.
 */
export function IcuCaseInput({
  fields,
  text,
  textInput,
  inputId,
  language,
  direction,
  sourceLanguage,
  sourceDirection,
  invalid,
  describedBy,
  singleLine,
  firstFieldRef,
  onFieldFocus,
  onChange,
}: {
  fields: IcuFields;
  /** The translation, for saying why the fields can't show it. */
  text: string;
  textInput: ReactNode;
  /** The text input's id, which the first field takes, so that its label leads there. */
  inputId: string;
  language: string;
  direction: "ltr" | "rtl";
  sourceLanguage: string;
  sourceDirection: "ltr" | "rtl";
  invalid: boolean;
  describedBy: string;
  /** Enter doesn't add a line break where the English has none. */
  singleLine: boolean;
  firstFieldRef(element: HTMLTextAreaElement | null): void;
  /** A field got focus: chips, Copy the English and Vary by go there. */
  onFieldFocus(element: HTMLTextAreaElement, english: string, field: IcuField): void;
  onChange(text: string): void;
}) {
  const form = fields.form;
  return (
    <>
      <div className="icu-mode">
        <Label className="icu-mode-switch">
          <Switch
            checked={!fields.shown}
            disabled={form === null}
            aria-describedby={form === null ? `${inputId}-mode` : undefined}
            onChange={(event) => fields.setAsText(event.target.checked)}
          />{" "}
          Edit as text
        </Label>
        {form === null && (
          <p id={`${inputId}-mode`} className="icu-mode-note">
            <InfoIcon />{" "}
            {icuSyntaxError(text) === null
              ? "Its blocks or cases differ from the English's, so this translation is edited as text."
              : "It isn't valid ICU, so this translation is edited as text."}
          </p>
        )}
      </div>
      {fields.shown && form !== null ? (
        <div className="icu-fields" role="group" aria-label="Cases">
          {form.fields.map((field, index) => {
            const id = index === 0 ? inputId : `${inputId}-${index}`;
            // Where an outer case's fields begin, a rule helps the eye find it.
            const outer = field.path.length > 1 ? field.path[0].key : null;
            const previousOuter = form.fields[index - 1]?.path[0]?.key;
            const startsOuterCase = index > 0 && outer !== null && outer !== previousOuter;
            return (
              <div
                key={index}
                className={startsOuterCase ? "icu-field icu-field-outer" : "icu-field"}
              >
                <Label htmlFor={id} className="icu-field-label">
                  <FieldLabel field={field} language={language} />
                </Label>
                <p className="icu-field-english" lang={sourceLanguage} dir={sourceDirection}>
                  <Parts parts={field.english} />
                </p>
                <TextArea
                  id={id}
                  ref={index === 0 ? firstFieldRef : undefined}
                  lang={language}
                  dir={direction}
                  data-translation-input=""
                  value={field.text}
                  minRows={1}
                  spellCheck
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  onFocus={(event) =>
                    onFieldFocus(event.currentTarget, plainText(field.english), field)
                  }
                  onChange={(event) => onChange(fields.write(field, event.target.value))}
                  onKeyDown={(event) => {
                    const composing = event.nativeEvent.isComposing;
                    const saveShortcut = event.ctrlKey || event.metaKey;
                    if (event.key === "Enter" && singleLine && !composing && !saveShortcut) {
                      event.preventDefault();
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : (
        textInput
      )}
    </>
  );
}

/**
 * "female › one 1", or "Before {g}": the cases leading to a field, with example numbers for
 * a plural category. Screen readers also hear each block's argument.
 */
function FieldLabel({ field, language }: { field: IcuField; language: string }) {
  const last = field.path[field.path.length - 1];
  const around = aroundBlocks(field);
  const isCategory = last !== undefined && last.blockType !== "select" && !last.key.startsWith("=");
  const examples =
    isCategory && around === "" ? categoryExamples(language, last.key, last.blockType) : "";
  return (
    <>
      {field.path.map((step, index) => (
        <span key={index}>
          {index > 0 && <Separator />}
          <span className="sr-only">{step.argument} </span>
          <span className="form-name">{step.key}</span>
        </span>
      ))}
      {around !== "" && (
        <span>
          {field.path.length > 0 && <Separator />}
          {around}
        </span>
      )}
      {examples !== "" && (
        <span className="form-examples">
          <span className="sr-only">, for</span> {examples}
        </span>
      )}
    </>
  );
}

function Separator() {
  return (
    <>
      <span aria-hidden="true"> › </span>
      <span className="sr-only">, </span>
    </>
  );
}

/** Where text around blocks sits: "Before {g}", "Between {a} and {b}", "After {g}". */
function aroundBlocks(field: IcuField): string {
  const { afterBlock, beforeBlock } = field;
  if (afterBlock !== undefined && beforeBlock !== undefined) {
    return `Between {${afterBlock}} and {${beforeBlock}}`;
  }
  if (beforeBlock !== undefined) return `Before {${beforeBlock}}`;
  if (afterBlock !== undefined) return `After {${afterBlock}}`;
  return "";
}

function categoryExamples(language: string, key: string, blockType: string): string {
  try {
    const ordinal = blockType === "selectordinal";
    return exampleNumbers(language, key as PluralCategory, { ordinal });
  } catch {
    return "";
  }
}

/** The English of a field: text, with arguments and `#` marked. */
function Parts({ parts }: { parts: IcuPart[] }) {
  const text = plainText(parts);
  if (text.trim() === "") return <span className="muted">(empty)</span>;
  // Spaces beside a block's syntax are easy to lose: the English shows them as signs.
  const leading = /^\s*/.exec(text)![0];
  const trailing = /\s*$/.exec(text)![0];
  const last = parts.length - 1;
  return (
    <>
      <EdgeWhitespace whitespace={leading} edge="start" />
      {parts.map((part, index) => {
        if (part.type !== "text") {
          return (
            <mark key={index} className="ph">
              {part.text}
            </mark>
          );
        }
        const start = index === 0 ? leading.length : 0;
        const end = index === last ? part.text.length - trailing.length : part.text.length;
        return <span key={index}>{part.text.slice(start, end)}</span>;
      })}
      <EdgeWhitespace whitespace={trailing} edge="end" />
    </>
  );
}

function plainText(parts: IcuPart[]): string {
  return parts.map((part) => part.text).join("");
}

/** What Copy the English puts in a field: its English, written as the field is. */
export function fieldEnglish(field: IcuField): string {
  return plainText(field.english);
}
