// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { demoDir } from "../packages/server/src/dev_seed.ts";
import { createFakeTranslator } from "../packages/service/mod.ts";
import { DEFAULT_MODELS, evaluate, parseOptions, report } from "./llm_eval.ts";

test("llm_eval: options, with the default models and languages", () => {
  expect(parseOptions([])).toStrictEqual({
    models: DEFAULT_MODELS,
    languages: ["de", "pl", "ja"],
    out: ".quaso/llm-eval.json",
    concurrency: 4,
    project: demoDir(),
    icu: false,
  });
  expect(parseOptions([], { GEMINI_MODEL: "gemini-x" }).models).toStrictEqual([
    "gemini-x",
    DEFAULT_MODELS[1],
  ]);
  const options = parseOptions(["--models", "a, b", "--languages=de", "--out", "x.json"]);
  expect([options.models, options.languages, options.out]).toStrictEqual([
    ["a", "b"],
    ["de"],
    "x.json",
  ]);
  const icu = parseOptions(["--project", "examples/feed", "--icu"]);
  expect([icu.project, icu.icu]).toStrictEqual(["examples/feed", true]);
  expect(() => parseOptions(["--nope"])).toThrow("Unknown argument");
  expect(() => parseOptions(["--concurrency", "0"])).toThrow(Error);
});

test("llm_eval: the demo through the service, per model and language (fake translator)", async () => {
  const results = await evaluate(
    {
      models: ["model-a"],
      languages: ["de", "ja"],
      out: "unused.json",
      concurrency: 2,
      project: demoDir(),
      icu: false,
    },
    () => createFakeTranslator(),
  );
  expect(results.map((result) => [result.model, result.language])).toStrictEqual([
    ["model-a", "de"],
    ["model-a", "ja"],
  ]);
  for (const result of results) {
    assert(result.strings > 20, String(result.strings));
    expect(result.firstTry).toStrictEqual(result.strings);
    expect(result.translated).toStrictEqual(result.strings);
    assert(result.tokens.input > 0 && result.requests > 0);
    expect(result.translations.length).toStrictEqual(result.strings);
  }
  const table = report(results);
  expect(table).toContain("first try");
  expect(table).toContain("model-a  de");
  expect(table).toContain("100%");
});
