// SPDX-License-Identifier: MIT
/**
 * The fake translator (design §5.6, LLM-8), for development, tests and demos: it
 * "translates" by marking the English in a recognisable way, `[Ŵéļçöɱé {{name}}]`, keeping
 * every placeholder, `⟦n⟧` token and number exactly, and gives every plural form the request
 * asks for. With it, upload, automatic translation, review and download work offline, for
 * free and deterministically. `bun run dev` uses it when no Gemini key is set.
 *
 * It answers the same request the Gemini provider gets, reading the machine-readable copy of
 * the batch (`ProviderRequest.batch`) instead of the prompt.
 */
import {
  coversExactlyOne,
  graphemeLength,
  type InterpolationSyntax,
  placeholderKey,
  placeholdersOf,
  type PluralCategory,
  type PluralForms,
  type TextValue,
  tokenize,
} from "@quaso/core";
import {
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type ProviderString,
  type TextRequest,
  type TextResult,
  type TranslationProvider,
} from "./provider.ts";

/** The model name the fake translator reports. */
export const FAKE_MODEL = "fake-translator";

export interface FakeTranslatorOptions {
  /** An artificial delay per request, in milliseconds, so it feels real. Default: 0. */
  delayMs?: number;
}

/** ASCII letters and their accented look-alikes. */
const LOOK_ALIKES: Record<string, string> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "ď",
  e: "é",
  f: "ƒ",
  g: "ğ",
  h: "ĥ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ö",
  p: "þ",
  q: "ǫ",
  r: "ŕ",
  s: "ś",
  t: "ţ",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Á",
  B: "Ɓ",
  C: "Ç",
  D: "Ď",
  E: "É",
  F: "Ƒ",
  G: "Ğ",
  H: "Ĥ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ö",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Ś",
  T: "Ţ",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

/** A masked reference, `⟦n⟧`: kept exactly. */
const MASKED = /⟦[1-9][0-9]*⟧/g;

/** Creates the fake translator. */
export function createFakeTranslator(options: FakeTranslatorOptions = {}): TranslationProvider {
  const delayMs = Math.max(0, options.delayMs ?? 0);
  return {
    name: "fake",
    async translate(request: ProviderRequest): Promise<ProviderResult> {
      await delay(delayMs, request.signal);
      const batch = request.batch;
      if (!batch) {
        throw new ProviderError("invalid_request", "The fake translator needs the batch.");
      }
      const answer = {
        translations: batch.strings.map((string) =>
          fakeAnswer(string, batch.syntax, batch.targetLanguage),
        ),
      };
      return {
        answer,
        usage: {
          inputTokens: tokensOf(request.system.length + request.prompt.length),
          outputTokens: tokensOf(JSON.stringify(answer).length),
          thinkingTokens: 0,
        },
        durationMs: delayMs,
        model: FAKE_MODEL,
      };
    },
    async generateText(request: TextRequest): Promise<TextResult> {
      await delay(delayMs, request.signal);
      const text =
        "A file of texts from a game's user interface (a context written by the " +
        "fake translator, for development).";
      return {
        text,
        usage: {
          inputTokens: tokensOf(request.system.length + request.prompt.length),
          outputTokens: tokensOf(text.length),
          thinkingTokens: 0,
        },
        durationMs: delayMs,
        model: FAKE_MODEL,
      };
    },
    listModels: () => Promise.resolve([FAKE_MODEL]),
  };
}

/** One string's answer in a language: its text, or every form asked for. */
export function fakeAnswer(
  string: ProviderString,
  syntax: InterpolationSyntax,
  language: string,
): { id: string; text?: string; forms?: PluralForms } {
  const english = string.english;
  if (string.kind === "text" || typeof english === "string") {
    const text = typeof english === "string" ? english : (english.other ?? "");
    return { id: string.id, text: fakeText(text, syntax, string.maxLength) };
  }
  const forms: PluralForms = {};
  for (const category of string.forms ?? ["other"]) {
    const source = formSource(english, category, syntax, language);
    forms[category] = fakeText(source, syntax, string.maxLength);
  }
  return { id: string.id, forms };
}

/**
 * The English a form is made from: the same category when English has it with the same
 * placeholders as `other`, otherwise `other`. English `zero` may leave out the count
 * where the language's zero form is for 0 alone, as the checks allow; not where it is a
 * category of its own that covers many numbers (Latvian: 0, 10–20, 30, …).
 */
function formSource(
  english: PluralForms,
  category: PluralCategory,
  syntax: InterpolationSyntax,
  language: string,
): string {
  const other = english.other ?? Object.values(english)[0] ?? "";
  const same = english[category];
  if (same === undefined || category === "other") return same ?? other;
  const keys = (text: string, count: boolean) =>
    placeholdersOf(text, syntax)
      .filter((token) => count || token.name !== "count")
      .map(placeholderKey)
      .sort()
      .join("\n");
  if (keys(same, true) === keys(other, true)) return same;
  const countOptional = category === "zero" && coversExactlyOne(language, "zero", { zero: true });
  return countOptional && keys(same, false) === keys(other, false) ? same : other;
}

/**
 * The marked English: letters as look-alikes, placeholders, `⟦n⟧` tokens and numbers as
 * they are, in brackets. Over `maxLength`, the brackets go, then text from the end.
 */
export function fakeText(english: string, syntax: InterpolationSyntax, maxLength?: number): string {
  if (english.trim() === "") return english;
  const segments = segmentsOf(english, syntax).map((segment) =>
    segment.locked ? segment : { locked: false, text: pseudoLocalize(segment.text) },
  );
  const join = () => segments.map((segment) => segment.text).join("");
  const marked = `[${join()}]`;
  if (maxLength === undefined || graphemeLength(marked) <= maxLength) return marked;
  // Shorten the free text from the end, keeping what is locked.
  while (graphemeLength(join()) > maxLength) {
    const last = segments.findLastIndex((segment) => !segment.locked && segment.text !== "");
    if (last === -1) break;
    const graphemes = [...new Intl.Segmenter().segment(segments[last].text)];
    segments[last] = {
      locked: false,
      text: graphemes
        .slice(0, -1)
        .map((part) => part.segment)
        .join(""),
    };
  }
  const shortened = join();
  return shortened.trim() === "" ? `[${pseudoLocalize(english)}]` : shortened;
}

/** Letters as their look-alikes. */
export function pseudoLocalize(text: string): string {
  return text.replace(/[A-Za-z]/g, (letter) => LOOK_ALIKES[letter] ?? letter);
}

/** The text in segments: placeholders and `⟦n⟧` tokens locked, the rest free. */
function segmentsOf(
  text: string,
  syntax: InterpolationSyntax,
): { locked: boolean; text: string }[] {
  const out: { locked: boolean; text: string }[] = [];
  for (const token of tokenize(text, syntax)) {
    if (token.type !== "text") {
      out.push({ locked: true, text: token.raw });
      continue;
    }
    let last = 0;
    for (const match of token.text.matchAll(MASKED)) {
      if (match.index > last) {
        out.push({ locked: false, text: token.text.slice(last, match.index) });
      }
      out.push({ locked: true, text: match[0] });
      last = match.index + match[0].length;
    }
    if (last < token.text.length) out.push({ locked: false, text: token.text.slice(last) });
  }
  return out;
}

/** Tokens, as characters / 4. */
function tokensOf(characters: number): number {
  return Math.ceil(characters / 4);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ProviderError("network", "The request was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** The value a fake answer would give, for tests: the text, or the forms. */
export function fakeValue(
  english: TextValue,
  kind: ProviderString["kind"],
  forms: PluralCategory[] | undefined,
  syntax: InterpolationSyntax,
  maxLength?: number,
  language = "en",
): TextValue {
  const answer = fakeAnswer({ id: "x", kind, english, forms, maxLength }, syntax, language);
  return answer.text ?? answer.forms ?? "";
}
