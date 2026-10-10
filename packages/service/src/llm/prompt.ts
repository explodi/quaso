// SPDX-License-Identifier: MIT
/**
 * Prompts (design §5.6, LLM-5): the template with `%placeholders%`, rendered for a batch of
 * strings in one language and one file, with its context; the answer's JSON schema; and
 * token estimates for dry runs.
 *
 * Rendering the template:
 * - lines that start with `%%` are notes for whoever edits it, never sent;
 * - the line `---STRINGS---` splits it: above is the system instruction, the stable part a
 *   provider can cache, below is the request. Without it, the whole template is the request
 *   and the system instruction is `DEFAULT_SYSTEM`;
 * - each known placeholder is replaced once (a value that contains `%name%` stays as it is);
 * - a paragraph (lines between blank lines) with a placeholder whose value is empty is left
 *   out whole, so no heading stays without its content.
 */
import {
  exampleNumbers,
  type GlossaryTerm,
  graphemeLength,
  type InterpolationSyntax,
  languageName,
  maskReferences,
  optionalPlaceholders,
  placeholderKey,
  placeholdersOf,
  PLURAL_CATEGORIES,
  pluralCategories,
  type PluralCategory,
  type PluralForms,
  type PluralOverride,
  type TextValue,
  type TranslatableKind,
} from "@quaso/core";
import type { JsonSchemaObject, ProviderBatch, ProviderString } from "./provider.ts";

/** The line that ends the system instruction in a template. */
export const STRINGS_MARKER = "---STRINGS---";

/** The system instruction of a template without `STRINGS_MARKER`. */
export const DEFAULT_SYSTEM =
  "You are a professional translator of games and apps. Follow the instructions in the " +
  "request exactly, and answer only with JSON in the given schema.";

/** The answer's JSON schema (design §5.6). */
export const RESPONSE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The string's id, as given" },
          ambiguous: {
            type: "string",
            description:
              "Optional: one sentence explaining an ambiguous source and the interpretation chosen",
          },
          text: { type: "string", description: "The translation of a text string" },
          forms: {
            type: "object",
            description: "The forms of a plural string: exactly those asked for",
            properties: Object.fromEntries(
              PLURAL_CATEGORIES.map((category) => [category, { type: "string" }]),
            ),
          },
        },
        required: ["id"],
        propertyOrdering: ["id", "text", "forms", "ambiguous"],
      },
    },
  },
  required: ["translations"],
};

/**
 * The answer's JSON schema for a batch: `RESPONSE_SCHEMA`, with `forms` requiring the
 * categories every plural string of the batch needs. Models skip forms the prompt asks for
 * when the schema lets them (French `many`, for 1000000, especially); structured output
 * enforces a required one. The forms only some strings need stay optional.
 */
export function responseSchemaFor(strings: readonly ProviderString[]): JsonSchemaObject {
  const formSets = strings.flatMap((string) => (string.forms ? [string.forms] : []));
  if (formSets.length === 0) return RESPONSE_SCHEMA;
  const required = formSets[0].filter((category) =>
    formSets.every((set) => set.includes(category)),
  );
  const translations = RESPONSE_SCHEMA.properties as Record<string, JsonSchemaObject>;
  const item = translations.translations.items as JsonSchemaObject;
  const properties = item.properties as Record<string, JsonSchemaObject>;
  return {
    ...RESPONSE_SCHEMA,
    properties: {
      translations: {
        ...translations.translations,
        items: { ...item, properties: { ...properties, forms: { ...properties.forms, required } } },
      },
    },
  };
}

/** A string of a batch, as the prompt shows it. */
export interface PromptString {
  id: number;
  /** The key, displayed with dots. */
  key: string;
  kind: TranslatableKind;
  /** The English, unmasked. */
  english: TextValue;
  description: string;
  maxLength: number | null;
  /** The current translation, when it is outdated: the answer updates it. */
  outdated?: TextValue | null;
  /** The previous answer and why it was refused, on a retry. */
  refused?: { answer: TextValue | null; reasons: string[] };
}

/** What a reference stands for: the English it points to, and its translation. */
export interface ReferenceHint {
  english: string | null;
  translation: string | null;
}

/** A batch's context (design §5.6): everything the template's placeholders need. */
export interface PromptContext {
  sourceLanguage: string;
  targetLanguage: string;
  syntax: InterpolationSyntax;
  pluralOverride?: PluralOverride;
  projectName: string;
  projectDescription: string;
  projectInstructions: string;
  languageInstructions: string;
  fileName: string;
  fileContext: string;
  /** The same strings in other languages. */
  otherLanguages: { id: number; language: string; value: TextValue; proofread: boolean }[];
  /** Proofread translations of identical English elsewhere in the project. */
  identicalStrings: { english: TextValue; translation: TextValue; proofread?: boolean }[];
  /** Strings before and after the batch in the file, with their current translation. */
  neighbours: { key: string; english: TextValue; translation: TextValue | null }[];
  /** What each reference in the batch stands for, by its raw text (`$t(common:play)`). */
  references: Map<string, ReferenceHint>;
  glossary: string;
  customInstruction: string;
}

/** A string, masked for the prompt. */
export interface MaskedString {
  /** The English with references as `⟦n⟧`, numbered alike in every form. */
  english: TextValue;
  /** `references[n - 1]` is the raw text of `⟦n⟧`. */
  references: string[];
  /** For plural and ordinal strings: the forms the answer must give. */
  forms?: PluralCategory[];
  /** The limit for the masked text: the string's limit, less what the references add. */
  maxLength?: number;
}

export interface RenderedPrompt {
  system: string;
  prompt: string;
  /** The machine-readable copy of the batch, for the fake translator. */
  batch: ProviderBatch;
  /** Each string's masking, by the ID the answer gives back (`s812`). */
  masked: Map<string, MaskedString>;
}

/** The ID a string has in prompts and answers. */
export function promptId(stringId: number): string {
  return `s${stringId}`;
}

/**
 * Masks a string's references as `⟦n⟧`. Plural forms share one numbering, starting with
 * `other`, so that any form of the answer unmasks with the same list.
 */
export function maskString(
  string: Pick<PromptString, "kind" | "english" | "maxLength">,
  language: string,
  syntax: InterpolationSyntax,
  override?: PluralOverride,
): MaskedString {
  const references: string[] = [];
  const mask = (text: string): string => {
    const own = maskReferences(text, syntax);
    const taken = new Set<number>();
    const mapping = own.references.map((raw) => {
      let index = references.findIndex((known, i) => known === raw && !taken.has(i));
      if (index === -1) {
        references.push(raw);
        index = references.length - 1;
      }
      taken.add(index);
      return index + 1;
    });
    return own.text.replace(/⟦([1-9][0-9]*)⟧/g, (token, n: string) => {
      const mapped = mapping[Number(n) - 1];
      return mapped === undefined ? token : `⟦${mapped}⟧`;
    });
  };
  let english: TextValue;
  let forms: PluralCategory[] | undefined;
  let extra = 0;
  if (typeof string.english === "string") {
    english = mask(string.english);
    extra = graphemeLength(string.english) - graphemeLength(english);
  } else {
    const source = string.english;
    const masked: PluralForms = {};
    const order = ["other", ...PLURAL_CATEGORIES.filter((c) => c !== "other")] as PluralCategory[];
    for (const category of order) {
      const text = source[category];
      if (text === undefined) continue;
      masked[category] = mask(text);
      extra = Math.max(extra, graphemeLength(text) - graphemeLength(masked[category]!));
    }
    english = Object.fromEntries(
      PLURAL_CATEGORIES.filter((c) => masked[c] !== undefined).map((c) => [c, masked[c]]),
    );
    forms = pluralCategories(language, {
      ordinal: string.kind === "ordinal",
      zero: string.kind === "plural" && source.zero !== undefined,
      override,
    });
  }
  const result: MaskedString = { english, references };
  if (forms) result.forms = forms;
  if (string.maxLength !== null) result.maxLength = Math.max(1, string.maxLength - extra);
  return result;
}

/**
 * The example numbers of each form a plural string needs, such as
 * `{ one: "1", few: "2–4, 22–24, 32–34, …" }`.
 */
export function formExamples(
  language: string,
  kind: "plural" | "ordinal",
  forms: PluralCategory[],
  zero: boolean,
): Record<string, string> {
  return Object.fromEntries(
    forms.map((form) => [
      form,
      exampleNumbers(language, form, { ordinal: kind === "ordinal", zero }) || "(any)",
    ]),
  );
}

/** `%pluralForms%`: the language's categories, with example numbers. */
export function pluralFormsText(language: string, override?: PluralOverride): string {
  const line = (ordinal: boolean) =>
    pluralCategories(language, { ordinal, override })
      .map((category) => {
        const examples = exampleNumbers(language, category, { ordinal });
        return examples ? `${category} (${examples})` : category;
      })
      .join("; ");
  const ordinals = pluralCategories(language, { ordinal: true, override });
  const cardinal = `Plural forms: ${line(false)}.`;
  return ordinals.length > 1 ? `${cardinal}\nOrdinal forms: ${line(true)}.` : cardinal;
}

/** Renders the prompt for a batch. */
export function renderPrompt(
  template: string,
  strings: PromptString[],
  context: PromptContext,
): RenderedPrompt {
  const masked = new Map<string, MaskedString>();
  const lines: string[] = [];
  const providerStrings: ProviderString[] = [];
  for (const string of strings) {
    const id = promptId(string.id);
    const mask = maskString(string, context.targetLanguage, context.syntax, context.pluralOverride);
    masked.set(id, mask);
    lines.push(JSON.stringify(stringLine(id, string, mask, context)));
    const provider: ProviderString = { id, kind: string.kind, english: mask.english };
    if (mask.forms) provider.forms = mask.forms;
    if (mask.maxLength !== undefined) provider.maxLength = mask.maxLength;
    providerStrings.push(provider);
  }
  const language = (tag: string) => `${languageName(tag)} (${tag})`;
  const values: Record<string, string> = {
    sourceLanguage: language(context.sourceLanguage),
    targetLanguage: language(context.targetLanguage),
    projectName: context.projectName,
    projectDescription: context.projectDescription,
    projectInstructions: context.projectInstructions,
    languageInstructions: context.languageInstructions,
    fileName: context.fileName,
    fileContext: context.fileContext,
    pluralForms: pluralFormsText(context.targetLanguage, context.pluralOverride),
    otherLanguages: context.otherLanguages
      .map((item) =>
        JSON.stringify({
          id: promptId(item.id),
          language: item.language,
          translation: item.value,
          ...(item.proofread ? { proofread: true } : {}),
        }),
      )
      .join("\n"),
    identicalStrings: context.identicalStrings
      .map((item) =>
        JSON.stringify({
          english: item.english,
          translation: item.translation,
          ...(item.proofread === undefined ? {} : { proofread: item.proofread }),
        }),
      )
      .join("\n"),
    glossary: context.glossary,
    neighbours: context.neighbours
      .map((item) =>
        JSON.stringify({ key: item.key, english: item.english, translation: item.translation }),
      )
      .join("\n"),
    strings: lines.join("\n"),
    customInstruction: context.customInstruction,
  };
  const { system, prompt } = renderTemplate(template, values);
  return {
    system,
    prompt,
    masked,
    batch: {
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      syntax: context.syntax,
      strings: providerStrings,
    },
  };
}

/** One line of `%strings%`. */
function stringLine(
  id: string,
  string: PromptString,
  mask: MaskedString,
  context: PromptContext,
): Record<string, unknown> {
  const line: Record<string, unknown> = { id, key: string.key, english: mask.english };
  if (mask.forms && string.kind !== "text" && typeof string.english !== "string") {
    line.forms = formExamples(
      context.targetLanguage,
      string.kind,
      mask.forms,
      string.kind === "plural" && string.english.zero !== undefined,
    );
  }
  if (string.description.trim() !== "") line.description = string.description.trim();
  if (mask.maxLength !== undefined) line.maxLength = mask.maxLength;
  const placeholders = placeholdersIn(string.english, context.syntax);
  if (placeholders.length > 0) line.placeholders = placeholders;
  const optional = optionalIn(string.english, context.syntax, context.targetLanguage);
  if (optional.length > 0) line.optionalPlaceholders = optional;
  if (mask.references.length > 0) {
    line.references = Object.fromEntries(
      mask.references.map((raw, index) => [`⟦${index + 1}⟧`, referenceText(raw, context)]),
    );
  }
  if (string.outdated !== undefined && string.outdated !== null) {
    line.outdatedTranslation = maskLike(string.outdated, mask, context.syntax);
  }
  if (string.refused) {
    line.refused = {
      answer:
        string.refused.answer === null
          ? null
          : maskLike(string.refused.answer, mask, context.syntax),
      reasons: string.refused.reasons,
    };
  }
  return line;
}

/**
 * The placeholders of the English as written, each once, in order: the model sees the app's
 * own `{name}` beside i18next's `{{count}}` and keeps both.
 */
function placeholdersIn(english: TextValue, syntax: InterpolationSyntax): string[] {
  const texts = typeof english === "string" ? [english] : Object.values(english);
  const raws = texts.flatMap((text) =>
    text === undefined ? [] : placeholdersOf(text, syntax).map((token) => token.raw),
  );
  return [...new Set(raws)];
}

/** The placeholders of the English, as written, that the target language may leave out. */
function optionalIn(english: TextValue, syntax: InterpolationSyntax, language: string): string[] {
  const optional = optionalPlaceholders(syntax, language);
  if (optional.size === 0) return [];
  const texts = typeof english === "string" ? [english] : Object.values(english);
  const raws = texts.flatMap((text) =>
    text === undefined
      ? []
      : placeholdersOf(text, syntax)
          .filter((token) => optional.has(placeholderKey(token)))
          .map((token) => token.raw),
  );
  return [...new Set(raws)];
}

/** What a reference stands for, for the prompt. */
function referenceText(raw: string, context: PromptContext): string {
  const hint = context.references.get(raw);
  if (!hint || hint.english === null) return `the text of ${raw}`;
  return hint.translation === null
    ? `"${hint.english}" (in English; its translation is inserted)`
    : `"${hint.translation}" (English: "${hint.english}")`;
}

/** A translation, with the string's references masked the same way as its English. */
function maskLike(value: TextValue, mask: MaskedString, syntax: InterpolationSyntax): TextValue {
  const replace = (text: string) => {
    const own = maskReferences(text, syntax);
    return own.text.replace(/⟦([1-9][0-9]*)⟧/g, (token, n: string) => {
      const raw = own.references[Number(n) - 1];
      const index = raw === undefined ? -1 : mask.references.indexOf(raw);
      return index === -1 ? (raw ?? token) : `⟦${index + 1}⟧`;
    });
  };
  if (typeof value === "string") return replace(value);
  return Object.fromEntries(Object.entries(value).map(([form, text]) => [form, replace(text)]));
}

/**
 * Renders a template with values by placeholder name (without the `%`): drops `%%` notes,
 * splits at `STRINGS_MARKER`, leaves out paragraphs with an empty placeholder and replaces
 * the rest.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
): { system: string; prompt: string } {
  const lines = withoutNotes(template).split("\n");
  const marker = lines.findIndex((line) => line.trim() === STRINGS_MARKER);
  const render = (part: string[]) =>
    part
      .join("\n")
      .split(/\n[ \t]*\n/)
      .map((paragraph) => renderParagraph(paragraph, values))
      .filter((paragraph): paragraph is string => paragraph !== null && paragraph.trim() !== "")
      .join("\n\n")
      .trim();
  if (marker === -1) return { system: DEFAULT_SYSTEM, prompt: render(lines) };
  return { system: render(lines.slice(0, marker)), prompt: render(lines.slice(marker + 1)) };
}

/**
 * A template as it is sent: without its `%%` notes, with `\n` line ends. The settings
 * check the placeholders of this text (`checkPromptTemplate`).
 */
export function withoutNotes(template: string): string {
  return template
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("%%"))
    .join("\n");
}

const PLACEHOLDER = /%([A-Za-z][A-Za-z0-9]*)%/g;

function renderParagraph(paragraph: string, values: Record<string, string>): string | null {
  // The paragraph with the strings always goes, whatever else in it is empty.
  const keep = paragraph.includes("%strings%");
  for (const match of paragraph.matchAll(PLACEHOLDER)) {
    const value = values[match[1]];
    if (!keep && value !== undefined && value.trim() === "") return null;
  }
  return paragraph.replace(PLACEHOLDER, (text, name: string) => values[name]?.trim() ?? text);
}

/** Tokens, estimated as characters / 4. */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

/**
 * The output a batch is expected to need, in tokens: each string's English once per form it
 * needs, a third longer (translations often are), plus the JSON around it.
 */
export function expectedOutputTokens(rendered: RenderedPrompt): number {
  let characters = 20;
  for (const string of rendered.batch.strings) {
    const english = string.english;
    const forms = string.forms ?? ["other"];
    const size = (text: string) => Math.ceil((text.length * 4) / 3) + 16;
    if (typeof english === "string") characters += size(english) + 20;
    else {
      const other = english.other ?? "";
      for (const form of forms) characters += size(english[form] ?? other);
      characters += 30;
    }
  }
  return estimateTokens(characters);
}

/** Applicable glossary entries, quoted as data, including never-translate instructions. */
export function glossaryText(terms: GlossaryTerm[]): string {
  return terms
    .map((term) =>
      JSON.stringify({
        term: term.term,
        ...(term.kind === "keep"
          ? { instruction: "Never translate; keep unchanged" }
          : { translation: term.translation }),
        ...(term.note ? { note: term.note } : {}),
      }),
    )
    .join("\n");
}
