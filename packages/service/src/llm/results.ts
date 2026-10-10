// SPDX-License-Identifier: MIT
/**
 * Checking an answer (design §5.6, §5.7, LLM-6): every result goes through the quality
 * checks, exactly like a person's translation. Unknown IDs are ignored; a string without an
 * answer, with an answer of the wrong shape, or whose answer fails a check is a failure,
 * with the reasons as sentences that a retry's prompt can quote.
 */
import {
  type CheckResult,
  type MeaningNote,
  LanguageTag,
  validate,
  s,
  errorsOf,
  graphemeLength,
  type PluralForms,
  type TextValue,
  unmaskReferences,
} from "@quaso/core";
import { MeaningNoteSchema } from "./meaning.ts";
import type { MaskedString, PromptString } from "./prompt.ts";
import { promptId } from "./prompt.ts";

/** A string whose answer passed, unmasked and ready to write. */
export interface Passed {
  value: TextValue;
  checks: CheckResult[];
  ambiguous?: string;
  referenceNotes?: { language: string; notes: MeaningNote[] }[];
}

/** A string whose answer failed. */
export interface Failed {
  /** The answer as given (masked), when there was one of the right shape. */
  answer: TextValue | null;
  /** Why, as sentences. */
  reasons: string[];
}

export interface CheckedAnswer {
  passed: Map<number, Passed>;
  failed: Map<number, Failed>;
}

export const NO_TRANSLATION = "No translation was returned.";

/**
 * Checks an answer against the strings asked for. `check` runs the quality checks on an
 * unmasked value; `masked` gives each string's masking, by prompt ID.
 */
export function checkAnswer(
  answer: unknown,
  strings: readonly PromptString[],
  masked: ReadonlyMap<string, MaskedString>,
  check: (string: PromptString, value: TextValue) => CheckResult[],
): CheckedAnswer {
  const result: CheckedAnswer = { passed: new Map(), failed: new Map() };
  const items = answerItems(answer);
  if (items === null) {
    for (const string of strings) {
      result.failed.set(string.id, {
        answer: null,
        reasons: ["The answer isn't in the expected JSON shape."],
      });
    }
    return result;
  }
  for (const string of strings) {
    const id = promptId(string.id);
    const mask = masked.get(id);
    const item = items.get(id);
    if (mask === undefined || item === undefined) {
      result.failed.set(string.id, { answer: null, reasons: [NO_TRANSLATION] });
      continue;
    }
    const shaped = shapeOf(string, item, mask);
    if ("reason" in shaped) {
      result.failed.set(string.id, { answer: null, reasons: [shaped.reason] });
      continue;
    }
    const value = unmask(shaped.value, mask.references);
    const checks = check(string, value);
    const errors = errorsOf(checks);
    if (errors.length > 0) {
      result.failed.set(string.id, {
        answer: shaped.value,
        reasons: errors.map((error) => reasonOf(error, shaped.value, mask.references)),
      });
    } else {
      const ambiguous =
        typeof item.ambiguous === "string" && item.ambiguous.trim() !== ""
          ? item.ambiguous.trim().slice(0, 2000)
          : undefined;
      const referenceNotes = validate(
        s.array(
          s.object({ language: LanguageTag, notes: s.array(MeaningNoteSchema, { maxItems: 20 }) }),
          { maxItems: 20 },
        ),
        item.referenceNotes,
      );
      result.passed.set(string.id, {
        value,
        checks,
        ...(ambiguous ? { ambiguous } : {}),
        ...(referenceNotes.ok ? { referenceNotes: referenceNotes.value } : {}),
      });
    }
  }
  return result;
}

/** The answer's items by ID (the first of each), or null when it isn't the schema's shape. */
function answerItems(answer: unknown): Map<string, Record<string, unknown>> | null {
  if (typeof answer !== "object" || answer === null) return null;
  const list = (answer as { translations?: unknown }).translations;
  if (!Array.isArray(list)) return null;
  const items = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || items.has(id.trim())) continue;
    items.set(id.trim(), item as Record<string, unknown>);
  }
  return items;
}

/**
 * The answer's value in the string's shape: a text for text strings, forms for plural ones
 * (forms the language doesn't need are dropped; the checks report missing ones).
 */
function shapeOf(
  string: PromptString,
  item: Record<string, unknown>,
  mask: MaskedString,
): { value: TextValue } | { reason: string } {
  const { text, forms } = item;
  if (string.kind === "text") {
    if (typeof text === "string") return { value: text };
    if (typeof forms === "object" && forms !== null) {
      return { reason: "A text was expected, but plural forms were given." };
    }
    return { reason: NO_TRANSLATION };
  }
  if (typeof forms !== "object" || forms === null || Array.isArray(forms)) {
    if (typeof text === "string") {
      return {
        reason: `Plural forms (${(mask.forms ?? []).join(
          ", ",
        )}) were expected, but a text was given.`,
      };
    }
    return { reason: NO_TRANSLATION };
  }
  const needed = new Set<string>(mask.forms ?? []);
  const value: PluralForms = {};
  for (const [form, formText] of Object.entries(forms as Record<string, unknown>)) {
    if (!needed.has(form) || typeof formText !== "string") continue;
    value[form as keyof PluralForms] = formText;
  }
  return { value };
}

/** Puts the references back: `⟦n⟧` becomes the exact `$t(…)` of the English. */
export function unmask(value: TextValue, references: readonly string[]): TextValue {
  if (typeof value === "string") return unmaskReferences(value, references);
  return Object.fromEntries(
    Object.entries(value).map(([form, text]) => [form, unmaskReferences(text ?? "", references)]),
  );
}

/**
 * A check's message as the model sees the text. A length is counted on the masked answer,
 * as the model counts it and as the prompt's `maxLength` is given: the limit less what the
 * references add once unmasked (the same numbers when the answer keeps the English's
 * references). Other messages show references as their `⟦n⟧` tokens.
 */
function reasonOf(error: CheckResult, answer: TextValue, references: readonly string[]): string {
  if (error.check !== "max_length" || error.limit === undefined || error.length === undefined) {
    return maskMessage(error.message, references);
  }
  const text = typeof answer === "string" ? answer : (answer[error.form ?? "other"] ?? "");
  const length = graphemeLength(text);
  const extra = error.length - length;
  if (extra <= 0) return error.message;
  const limit = Math.max(0, error.limit - extra);
  const characters = limit === 1 ? "character" : "characters";
  const form = error.form ? ` (${error.form} form)` : "";
  return `At most ${limit} ${characters}; this has ${length}${form}.`;
}

/** A check's message as the model sees the text: references as their `⟦n⟧` tokens. */
function maskMessage(message: string, references: readonly string[]): string {
  let out = message;
  references.forEach((raw, index) => {
    if (raw.startsWith("⟦")) return;
    out = out.replaceAll(raw, `⟦${index + 1}⟧`);
  });
  return out;
}
