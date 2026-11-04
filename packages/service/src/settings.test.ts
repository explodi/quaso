// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { PROMPT_PLACEHOLDERS } from "@quaso/core";
import { ServiceError } from "./errors.ts";
import {
  DEFAULT_PROMPT_TEMPLATE,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsFromData,
} from "./settings.ts";
import { startTestService } from "./test_helpers.ts";

test("the default settings", () => {
  const settings = defaultSettings("gemini-flash-latest");
  expect(settings.name).toBe("Untitled project");
  expect(settings.sourceLanguage).toBe("en");
  expect(settings.syntax).toStrictEqual({
    prefix: "{{",
    suffix: "}}",
    extra: [],
    optional: [],
    icu: false,
  });
  expect([settings.logoUrl, settings.links]).toStrictEqual([null, []]);
  expect(settings.llm.model).toBe("gemini-flash-latest");
  expect(settings.llm.context).toStrictEqual({
    otherLanguages: [],
    identicalStrings: true,
    fileContext: true,
    glossary: true,
  });
  expect([
    settings.llm.batchSize,
    settings.llm.neighbours,
    settings.llm.retries,
    settings.llm.safety,
  ]).toStrictEqual([25, 3, 2, "permissive"]);
});

test("the default prompt uses every placeholder", () => {
  for (const placeholder of PROMPT_PLACEHOLDERS) {
    expect(DEFAULT_PROMPT_TEMPLATE.includes(placeholder), placeholder).toBe(true);
  }
});

test("settings are saved, and loaded with missing fields from the defaults", async () => {
  using instance = await startTestService({ defaultModel: "model-a" });
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, name: "Wayfarer" });
  expect(loadSettings(instance.ctx).name).toBe("Wayfarer");
  instance.sql.run(
    "UPDATE settings SET data = ?",
    JSON.stringify({ name: "Old", llm: { batchSize: 10, obsolete: true }, removed: 1 }),
  );
  const loaded = loadSettings(instance.ctx);
  expect(loaded.name).toBe("Old");
  expect(loaded.llm.batchSize).toBe(10);
  expect(loaded.llm.model).toBe("model-a");
  expect(loaded.sourceLanguage).toBe("en");
  expect("removed" in loaded).toBe(false);
});

test("ICU MessageFormat stays on after saving", async () => {
  using instance = await startTestService();
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, syntax: { ...settings.syntax, icu: true } });
  expect(loadSettings(instance.ctx).syntax.icu).toBe(true);
});

/** Sprint 2's default template, as instances made then store it. */
const SPRINT_2_TEMPLATE = `You are a professional game and app translator. Translate the strings below from %sourceLanguage% into %targetLanguage%.

About the project, %projectName%:
%projectDescription%

%projectInstructions%

Instructions for %targetLanguage%:
%languageInstructions%

The strings come from the file %fileName%.
%fileContext%

Rules:
- Keep every placeholder, such as {{count}}, exactly as written. You may move it within the sentence.
- Keep every locked token, such as ⟦1⟧, exactly once. It stands for text you must not change.
- Keep the meaning, tone and length of the original; respect each string's maximum length.
- Plural strings need these forms in %targetLanguage%: %pluralForms%
- Use the terms of the glossary consistently.

%glossary%

Translations of the same strings in other languages, for reference:
%otherLanguages%

Proofread translations of identical strings elsewhere in the project:
%identicalStrings%

The strings around them, for context:
%neighbours%

%customInstruction%

The strings to translate, as JSON:
%strings%

Answer with JSON only, giving the translation of every string by its ID.`;

test("a template still on an earlier release's default gets the current one", async () => {
  using instance = await startTestService();
  const settings = loadSettings(instance.ctx);
  instance.sql.run(
    "UPDATE settings SET data = ?",
    JSON.stringify({ ...settings, llm: { ...settings.llm, promptTemplate: SPRINT_2_TEMPLATE } }),
  );
  expect(loadSettings(instance.ctx).llm.promptTemplate).toStrictEqual(DEFAULT_PROMPT_TEMPLATE);
  // A template someone changed stays theirs.
  const own = SPRINT_2_TEMPLATE.replace("professional", "careful");
  saveSettings(instance.ctx, { ...settings, llm: { ...settings.llm, promptTemplate: own } });
  expect(loadSettings(instance.ctx).llm.promptTemplate).toStrictEqual(own);
});

/** The stored default before source-language and number-agreement guidance. */
const PREVIOUS_DEFAULT_TEMPLATE = `%% Notes like this one (lines that start with %%) are never sent. Everything above the
%% line ---STRINGS--- is the system instruction: the stable part, which the provider can
%% cache. A paragraph (lines between blank lines) with an empty placeholder is left out.
You are a professional translator of games and apps. You translate the texts of %projectName% from %sourceLanguage% into %targetLanguage%.

Rules:
- Translate each string's English into natural %targetLanguage%, as a native speaker would write it for this game or app, keeping its meaning and tone.
- Keep every placeholder listed in a string's "placeholders", such as {{count}} or {name}, exactly as written: the same name, spelling, spaces and delimiters, as many times as in the English. You may move it within the sentence. Never translate what is inside the delimiters. Leave out a placeholder listed in "optionalPlaceholders" when %targetLanguage% has no use for it, such as an article in a language without articles.
- Keep every locked token, such as ⟦1⟧, exactly as often as in the English. It stands for a text inserted later: "references" says which.
- Never translate keys or IDs.
- For a plural string, give exactly the forms listed in its "forms", no more and no fewer, each one grammatical in %targetLanguage% for the example numbers given.
- Respect "maxLength": the translation, placeholders and tokens included, must have at most that many characters. Shorten or rephrase if needed.
- A string marked "document": true is a whole file, such as a Markdown article, not a short string. Translate it as one text: keep its paragraphs (the same number, in the same order, separated by blank lines), its headings and any Markdown syntax as written, and give the whole translated file as "text". Each paragraph stays the same kind of block: a heading of the same level, a list, a quote, a table. Never translate code (between backticks or in code blocks), the URLs of links and images, or the keys of the front matter. When you translate a heading that a link in the file points to (#anchor), change the link to the translated heading's anchor: lower case, without punctuation, spaces as hyphens.
- Follow the instructions below, and keep terms consistent with the other translations shown.
- When source wording has several plausible meanings, include an optional "ambiguous" sentence naming the interpretations and your choice, especially when no description resolves it.
- Answer only with JSON in the given schema: for each string, its "id" and its "text", or its "forms" for a plural string.

%pluralForms%

About %projectName%:
%projectDescription%

Instructions for the project:
%projectInstructions%

Instructions for %targetLanguage%:
%languageInstructions%

---STRINGS---
The strings come from the file %fileName%.

About this file:
%fileContext%

Glossary:
%glossary%

The same strings in other languages, for reference ("proofread" ones are checked by people):
%otherLanguages%

Current %targetLanguage% translations of the same English elsewhere in the project ("proofread": false means not checked by a person): use them, unless the context calls for something else.
%identicalStrings%

The strings around them in the file, with their current %targetLanguage% translations, for context:
%neighbours%

The strings to translate, one JSON object per line: "id", "key", "english", "document" (a whole file: keep its paragraphs), the plural "forms" to give with their example numbers, "description", "maxLength", "placeholders" (to keep exactly as written), "optionalPlaceholders" (placeholders you may leave out), "arguments" (values the app passes that the English may not show, with their cases: see the rules for select blocks), "references" (what each locked token stands for), "outdatedTranslation" (the current translation, made for an older English: update it), "outdatedEnglish" (that older English: change only what the difference from "english" requires, and keep the rest of the translation as it is) and "refused" (why your previous answer was refused: correct it).
%strings%

An instruction for this run, which comes before the others:
%customInstruction%`;

test("the previous default prompt upgrades without changing other LLM settings", () => {
  const stored = defaultSettings("claude-opus-5-5");
  stored.llm.promptTemplate = PREVIOUS_DEFAULT_TEMPLATE;
  stored.llm.projectInstructions = "Keep the tone warm.";
  stored.llm.batchSize = 10;
  const loaded = settingsFromData(JSON.stringify(stored), "gemini-flash-latest");
  expect(loaded.llm).toStrictEqual({ ...stored.llm, promptTemplate: DEFAULT_PROMPT_TEMPLATE });
});

test("a customized copy of the previous default prompt stays unchanged", () => {
  const custom = `${PREVIOUS_DEFAULT_TEMPLATE}\nUse informal forms of address.`;
  const stored = defaultSettings("claude-opus-5-5");
  stored.llm.promptTemplate = custom;
  expect(settingsFromData(JSON.stringify(stored), "gemini-flash-latest").llm.promptTemplate).toBe(
    custom,
  );
});

test("invalid settings are refused, and invalid stored ones reported", async () => {
  using instance = await startTestService();
  const settings = loadSettings(instance.ctx);
  const error = await Promise.try(() =>
    saveSettings(instance.ctx, { ...settings, name: "" }),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("validation_failed");
  expect(error.details?.[0].path).toBe("name");
  instance.sql.run("UPDATE settings SET data = ?", JSON.stringify({ sourceLanguage: "not a tag" }));
  expect(() => loadSettings(instance.ctx)).toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "internal" }),
  );
});
