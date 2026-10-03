// SPDX-License-Identifier: MIT
/**
 * The translation panel's inputs: placeholder and reference chips, masked references, and
 * one input per plural form (design §5.2, §5.9).
 *
 * Nesting references such as `$t(common:back)` are shown masked as `⟦1⟧`, `⟦2⟧`, … so that
 * translators can't mistype them, numbered by their order in the English, the same
 * reference always with the same number. Saving turns them back into the exact text with
 * core's `unmaskReferences`. Text that already contains `⟦` switches masking off for the
 * string, so nothing a person typed is ever turned into a reference.
 */
import {
  categoriesFor,
  exampleNumbers,
  type InterpolationSyntax,
  MASK_OPEN,
  maskToken,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type PluralForms,
  type PluralOverride,
  type ReferenceHint,
  type TextValue,
  tokenize,
  type TranslatableKind,
  unmaskReferences,
} from "@quaso/core";

export interface Chip {
  kind: "placeholder" | "reference";
  /** What a click inserts: the placeholder as written, or the reference's mask `⟦n⟧`. */
  insert: string;
  /** The text in the English: `{{count}}`, `$t(common:back)`. */
  raw: string;
  /** For references: the English text it refers to, when known. */
  english: string | null;
}

export interface Masking {
  /** Whether references are masked for this string. */
  enabled: boolean;
  /** The English's references, each once; `⟦n⟧` stands for `references[n - 1]`. */
  references: string[];
  /** Placeholders and references of the English, each once, in order of appearance. */
  chips: Chip[];
}

/** The English's texts: the text, or the forms in CLDR order. */
export function sourceTexts(source: TextValue): string[] {
  if (typeof source === "string") return [source];
  return PLURAL_CATEGORIES.map((category) => source[category]).filter(
    (text): text is string => typeof text === "string",
  );
}

function valueTexts(value: TextValue | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return typeof value === "string"
    ? [value]
    : Object.values(value).filter((text): text is string => typeof text === "string");
}

/**
 * The chips and references of a string. Masking is on unless the English or the current
 * translation already contains `⟦`.
 */
export function editorMasking(
  source: TextValue,
  hints: readonly ReferenceHint[],
  syntax: InterpolationSyntax,
  current?: TextValue | null,
): Masking {
  const enabled = ![...sourceTexts(source), ...valueTexts(current)].some((text) =>
    text.includes(MASK_OPEN),
  );
  const english = new Map(hints.map((hint) => [hint.raw, hint.english]));
  const references: string[] = [];
  const chips: Chip[] = [];
  const seen = new Set<string>();
  for (const text of sourceTexts(source)) {
    for (const token of tokenize(text, syntax)) {
      if (token.type === "text" || seen.has(`${token.type}:${token.raw}`)) continue;
      seen.add(`${token.type}:${token.raw}`);
      if (token.type === "placeholder") {
        chips.push({ kind: "placeholder", insert: token.raw, raw: token.raw, english: null });
      } else {
        references.push(token.raw);
        chips.push({
          kind: "reference",
          insert: enabled ? maskToken(references.length) : token.raw,
          raw: token.raw,
          english: english.get(token.raw) ?? null,
        });
      }
    }
  }
  return { enabled, references, chips };
}

/** Text with each of the references replaced by its mask; other references stay as they are. */
export function maskText(
  text: string,
  masking: Pick<Masking, "enabled" | "references">,
  syntax: InterpolationSyntax,
): string {
  if (!masking.enabled || masking.references.length === 0) return text;
  return tokenize(text, syntax)
    .map((token) => {
      if (token.type === "text") return token.text;
      if (token.type === "reference") {
        const index = masking.references.indexOf(token.raw);
        if (index >= 0) return maskToken(index + 1);
      }
      return token.raw;
    })
    .join("");
}

/** Masked text back to what is stored: every `⟦n⟧` becomes its reference. */
export function unmaskText(text: string, masking: Pick<Masking, "enabled" | "references">): string {
  return masking.enabled ? unmaskReferences(text, masking.references) : text;
}

/** An input of the panel: the text of a text string, or one plural form. */
export type FormKey = PluralCategory | "text";

/**
 * The inputs a string needs in a language: one for text, one per plural category for
 * plural and ordinal strings (with the categories the service reports as the override,
 * since the service is the last word on plural rules).
 */
export function formsFor(
  kind: TranslatableKind,
  language: string,
  source: TextValue,
  override?: PluralOverride,
): FormKey[] {
  if (kind === "text") return ["text"];
  const english = typeof source === "string" ? { other: source } : source;
  try {
    return categoriesFor(language, kind, english, override);
  } catch {
    return override?.[kind === "ordinal" ? "ordinal" : "cardinal"] ?? ["other"];
  }
}

/** The example numbers of a plural form, such as `2–4, 22–24, 32–34, …`; "" when unknown. */
export function formExamples(
  form: FormKey,
  kind: TranslatableKind,
  language: string,
  source: TextValue,
): string {
  if (form === "text") return "";
  try {
    return exampleNumbers(language, form, {
      ordinal: kind === "ordinal",
      zero: kind === "plural" && typeof source !== "string" && source.zero !== undefined,
    });
  } catch {
    return "";
  }
}

/** The English for an input: the text, the same plural form, or `other`. */
export function englishFor(source: TextValue, form: FormKey): string {
  if (typeof source === "string") return source;
  if (form !== "text" && source[form] !== undefined) return source[form]!;
  return source.other ?? "";
}

export type Draft = Partial<Record<FormKey, string>>;

/** The inputs' text for a value (masked), empty for forms it lacks. */
export function draftFrom(
  value: TextValue | null | undefined,
  forms: readonly FormKey[],
  mask: (text: string) => string,
): Draft {
  const draft: Draft = {};
  for (const form of forms) {
    let text = "";
    if (typeof value === "string") text = form === "text" ? value : "";
    else if (value && form !== "text") text = value[form] ?? "";
    draft[form] = mask(text);
  }
  return draft;
}

/** The value to save from the inputs (unmasked): text, or forms by category. */
export function valueFrom(
  draft: Draft,
  forms: readonly FormKey[],
  unmask: (text: string) => string,
): TextValue {
  if (forms.length === 1 && forms[0] === "text") return unmask(draft.text ?? "");
  const value: PluralForms = {};
  for (const form of forms) {
    if (form !== "text") value[form] = unmask(draft[form] ?? "");
  }
  return value;
}

/** Whether two drafts have the same text in every input. */
export function sameDraft(a: Draft, b: Draft, forms: readonly FormKey[]): boolean {
  return forms.every((form) => (a[form] ?? "") === (b[form] ?? ""));
}
