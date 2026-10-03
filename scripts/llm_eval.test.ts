// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@quaso/runtime/assert";
import { createFakeTranslator } from "../packages/service/mod.ts";
import { DEFAULT_MODELS, evaluate, parseOptions, report } from "./llm_eval.ts";

test("llm_eval: options, with the default models and languages", () => {
  assertEquals(parseOptions([]), {
    models: DEFAULT_MODELS,
    languages: ["de", "pl", "ja"],
    out: ".quaso/llm-eval.json",
    concurrency: 4,
  });
  assertEquals(parseOptions([], { GEMINI_MODEL: "gemini-x" }).models, [
    "gemini-x",
    DEFAULT_MODELS[1],
  ]);
  const options = parseOptions(["--models", "a, b", "--languages=de", "--out", "x.json"]);
  assertEquals([options.models, options.languages, options.out], [["a", "b"], ["de"], "x.json"]);
  assertThrows(() => parseOptions(["--nope"]), Error, "Unknown argument");
  assertThrows(() => parseOptions(["--concurrency", "0"]), Error);
});

test("llm_eval: the demo through the service, per model and language (fake translator)", async () => {
  const results = await evaluate(
    { models: ["model-a"], languages: ["de", "ja"], out: "unused.json", concurrency: 2 },
    () => createFakeTranslator(),
  );
  assertEquals(
    results.map((result) => [result.model, result.language]),
    [
      ["model-a", "de"],
      ["model-a", "ja"],
    ],
  );
  for (const result of results) {
    assert(result.strings > 20, String(result.strings));
    assertEquals(result.firstTry, result.strings);
    assertEquals(result.translated, result.strings);
    assert(result.tokens.input > 0 && result.requests > 0);
    assertEquals(result.translations.length, result.strings);
  }
  const table = report(results);
  assertStringIncludes(table, "first try");
  assertStringIncludes(table, "model-a  de");
  assertStringIncludes(table, "100%");
});
