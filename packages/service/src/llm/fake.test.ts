// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "@quaso/runtime/assert";
import {
  checkTranslation,
  DEFAULT_SYNTAX,
  errorsOf,
  graphemeLength,
  type PluralForms,
} from "@quaso/core";
import { createFakeTranslator, FAKE_MODEL, fakeText, pseudoLocalize } from "./fake.ts";
import { RESPONSE_SCHEMA } from "./prompt.ts";
import { ProviderError, type ProviderRequest } from "./provider.ts";

const syntax = DEFAULT_SYNTAX;

test("fake: letters become look-alikes, in brackets, as the design shows", () => {
  assertEquals(fakeText("Welcome {{name}}", syntax), "[Ŵéļçöɱé {{name}}]");
  assertEquals(pseudoLocalize("Quaso Quest"), "Ǫúáśö Ǫúéśţ");
});

test("fake: placeholders, masked references and numbers stay exactly", () => {
  assertEquals(
    fakeText("Level {{current}} of {{ total, number }}: ⟦1⟧ 20 times", syntax),
    "[Ļéṽéļ {{current}} öƒ {{ total, number }}: ⟦1⟧ 20 ţíɱéś]",
  );
  assertEquals(
    fakeText("{{- html}} and $t(common:back)", syntax),
    "[{{- html}} áñď $t(common:back)]",
  );
  assertEquals(fakeText("", syntax), "");
  assertEquals(fakeText("  ", syntax), "  ");
});

test("fake: within a maximum length, the brackets go, then text from the end", () => {
  assertEquals(fakeText("Play", syntax, 6), "[Þļáý]");
  assertEquals(fakeText("Play", syntax, 5), "Þļáý");
  const short = fakeText("Welcome back, {{name}}!", syntax, 12);
  assertEquals(short, "Ŵéļç{{name}}");
  assertEquals(graphemeLength(short), 12);
  // Placeholders alone don't fit: the result is too long, and the checks will say so.
  assert(graphemeLength(fakeText("{{name}} {{place}}", syntax, 5)) > 5);
});

function request(batch: ProviderRequest["batch"]): ProviderRequest {
  return {
    model: "gemini-flash-latest",
    system: "System",
    prompt: "Prompt with some text",
    responseSchema: RESPONSE_SCHEMA,
    safety: "permissive",
    batch,
  };
}

test("fake: answers every string of the batch, with every form asked for", async () => {
  const fake = createFakeTranslator();
  const result = await fake.translate(
    request({
      sourceLanguage: "en",
      targetLanguage: "pl",
      syntax,
      strings: [
        { id: "s1", kind: "text", english: "Back to ⟦1⟧" },
        {
          id: "s2",
          kind: "plural",
          english: { one: "{{count}} coin", other: "{{count}} coins" },
          forms: ["one", "few", "many", "other"],
        },
        {
          id: "s3",
          kind: "plural",
          english: { zero: "Empty", one: "One item", other: "{{count}} items" },
          forms: ["zero", "one", "few", "many", "other"],
        },
      ],
    }),
  );
  assertEquals(result.answer, {
    translations: [
      { id: "s1", text: "[Ɓáçķ ţö ⟦1⟧]" },
      {
        id: "s2",
        forms: {
          one: "[{{count}} çöíñ]",
          few: "[{{count}} çöíñś]",
          many: "[{{count}} çöíñś]",
          other: "[{{count}} çöíñś]",
        },
      },
      {
        id: "s3",
        forms: {
          zero: "[Éɱþţý]",
          // "One item" lacks {{count}}, which Polish one needs to keep safe: other it is.
          one: "[{{count}} íţéɱś]",
          few: "[{{count}} íţéɱś]",
          many: "[{{count}} íţéɱś]",
          other: "[{{count}} íţéɱś]",
        },
      },
    ],
  });
  assertEquals(result.model, FAKE_MODEL);
  assertEquals(result.usage.inputTokens, Math.ceil(("System".length + 21) / 4));
  assert(result.usage.outputTokens > 0);
  assertEquals(result.usage.thinkingTokens, 0);
});

test("fake: English's zero form only where zero is 0 alone, so the answer passes the checks", async () => {
  const english = { zero: "No coins", one: "One coin", other: "{{count}} coins" };
  const fake = createFakeTranslator();
  const answers: Record<string, unknown> = {};
  // Latvian zero is a native category: 0, 10–20, 30, … need {{count}}. German zero is 0.
  for (const language of ["lv", "de"]) {
    const result = await fake.translate(
      request({
        sourceLanguage: "en",
        targetLanguage: language,
        syntax,
        strings: [{ id: "s1", kind: "plural", english, forms: ["zero", "one", "other"] }],
      }),
    );
    const answer = (result.answer as { translations: { forms: PluralForms }[] }).translations[0]
      .forms;
    answers[language] = answer;
    const checks = checkTranslation({
      kind: "plural",
      source: english,
      translation: answer,
      language,
      syntax,
    });
    assertEquals(errorsOf(checks), [], language);
  }
  assertEquals(answers.lv, {
    zero: "[{{count}} çöíñś]",
    one: "[{{count}} çöíñś]",
    other: "[{{count}} çöíñś]",
  });
  assertEquals(answers.de, {
    zero: "[Ñö çöíñś]",
    one: "[{{count}} çöíñś]",
    other: "[{{count}} çöíñś]",
  });
});

test("fake: it needs the batch, and waits its delay unless cancelled", async () => {
  const fake = createFakeTranslator({ delayMs: 20 });
  const error = await assertRejects(() => fake.translate(request(undefined)), ProviderError);
  assertEquals(error.kind, "invalid_request");
  const started = performance.now();
  await fake.translate(
    request({ sourceLanguage: "en", targetLanguage: "de", syntax, strings: [] }),
  );
  assert(performance.now() - started >= 15);
  const controller = new AbortController();
  const pending = fake.translate({
    ...request({ sourceLanguage: "en", targetLanguage: "de", syntax, strings: [] }),
    signal: controller.signal,
  });
  controller.abort();
  await assertRejects(() => pending, ProviderError);
});

test("fake: text and models", async () => {
  const fake = createFakeTranslator();
  const text = await fake.generateText({ model: "m", system: "S", prompt: "P" });
  assert(text.text.length > 0);
  assertEquals(await fake.listModels(), [FAKE_MODEL]);
  assertEquals(fake.name, "fake");
});
