// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
import { PROMPT_PLACEHOLDERS } from "@quaso/core";
import { ServiceError } from "./errors.ts";
import {
  DEFAULT_PROMPT_TEMPLATE,
  defaultSettings,
  loadSettings,
  saveSettings,
} from "./settings.ts";
import { startTestService } from "./test_helpers.ts";

test("the default settings", () => {
  const settings = defaultSettings("gemini-flash-latest");
  assertEquals(settings.name, "Untitled project");
  assertEquals(settings.sourceLanguage, "en");
  assertEquals(settings.syntax, { prefix: "{{", suffix: "}}", extra: [] });
  assertEquals([settings.logoUrl, settings.links], [null, []]);
  assertEquals(settings.llm.model, "gemini-flash-latest");
  assertEquals(settings.llm.context, {
    otherLanguages: [],
    identicalStrings: true,
    fileContext: true,
    glossary: true,
  });
  assertEquals(
    [settings.llm.batchSize, settings.llm.neighbours, settings.llm.retries, settings.llm.safety],
    [25, 3, 2, "permissive"],
  );
});

test("the default prompt uses every placeholder", () => {
  for (const placeholder of PROMPT_PLACEHOLDERS) {
    assertEquals(DEFAULT_PROMPT_TEMPLATE.includes(placeholder), true, placeholder);
  }
});

test("settings are saved, and loaded with missing fields from the defaults", async () => {
  using instance = await startTestService({ defaultModel: "model-a" });
  const settings = loadSettings(instance.ctx);
  saveSettings(instance.ctx, { ...settings, name: "Wayfarer" });
  assertEquals(loadSettings(instance.ctx).name, "Wayfarer");
  instance.sql.run(
    "UPDATE settings SET data = ?",
    JSON.stringify({ name: "Old", llm: { batchSize: 10, obsolete: true }, removed: 1 }),
  );
  const loaded = loadSettings(instance.ctx);
  assertEquals(loaded.name, "Old");
  assertEquals(loaded.llm.batchSize, 10);
  assertEquals(loaded.llm.model, "model-a");
  assertEquals(loaded.sourceLanguage, "en");
  assertEquals("removed" in loaded, false);
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
  assertEquals(loadSettings(instance.ctx).llm.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  // A template someone changed stays theirs.
  const own = SPRINT_2_TEMPLATE.replace("professional", "careful");
  saveSettings(instance.ctx, { ...settings, llm: { ...settings.llm, promptTemplate: own } });
  assertEquals(loadSettings(instance.ctx).llm.promptTemplate, own);
});

test("invalid settings are refused, and invalid stored ones reported", async () => {
  using instance = await startTestService();
  const settings = loadSettings(instance.ctx);
  const error = assertThrows(
    () => saveSettings(instance.ctx, { ...settings, name: "" }),
    ServiceError,
  );
  assertEquals(error.code, "validation_failed");
  assertEquals(error.details?.[0].path, "name");
  instance.sql.run("UPDATE settings SET data = ?", JSON.stringify({ sourceLanguage: "not a tag" }));
  assertEquals(assertThrows(() => loadSettings(instance.ctx), ServiceError).code, "internal");
});
