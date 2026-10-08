// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The opt-in LLM evaluation (S0.6, S5.8; design open question 4), `deno task test:llm`:
 * translates the demo game's strings (`examples/demo-game/`) into German, Polish and
 * Japanese with each model, through the service's own batching, prompts, checks and
 * retries (an in-memory service with the Gemini provider), so the numbers are production's.
 * It prints, per model and language, the share of strings that passed the quality checks on
 * the first try and after the retries, the tokens and the time, and writes the translations
 * to a JSON file for a native speaker's review. It needs GEMINI_API_KEY, and spends tokens.
 *
 *   deno task test:llm [--models gemini-flash-latest,gemini-2.5-pro] [--languages de,pl,ja]
 *                      [--out .quaso/llm-eval.json] [--concurrency 4]
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { dirname } from "node:path";
import {
  createGeminiProvider,
  createService,
  SYSTEM,
  type TranslationProvider,
} from "../packages/service/mod.ts";
import { openNodeSqlite } from "../packages/service/src/adapters/node_sqlite.ts";
import { FALLBACK_MODEL } from "../packages/service/src/context.ts";
import { demoDir, readProjectFiles } from "../packages/server/src/dev_seed.ts";

/** The models compared by default: the default Flash-class model and a Pro-class one. */
export const DEFAULT_MODELS = [FALLBACK_MODEL, "gemini-2.5-pro"];
export const DEFAULT_LANGUAGES = ["de", "pl", "ja"];

export interface EvalOptions {
  models: string[];
  languages: string[];
  out: string;
  concurrency: number;
}

/** One model in one language. */
export interface EvalResult {
  model: string;
  language: string;
  strings: number;
  /** Strings whose first answer passed the checks. */
  firstTry: number;
  /** Strings translated in the end, after the retries. */
  translated: number;
  tokens: { input: number; output: number; thinking: number };
  requests: number;
  seconds: number;
  failures: { file: string; key: string; reason: string }[];
  translations: { file: string; key: string; english: unknown; translation: unknown }[];
}

/** Parses the command line. */
export function parseOptions(args: string[], env: { GEMINI_MODEL?: string } = {}): EvalOptions {
  const options: EvalOptions = {
    models: env.GEMINI_MODEL ? [env.GEMINI_MODEL, DEFAULT_MODELS[1]] : [...DEFAULT_MODELS],
    languages: [...DEFAULT_LANGUAGES],
    out: ".quaso/llm-eval.json",
    concurrency: 4,
  };
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split(/=(.*)/s, 2);
    const value = () => {
      const next = inline ?? args[++index];
      if (next === undefined || next === "") throw new Error(`${name} needs a value`);
      return next;
    };
    const list = () =>
      value()
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    if (name === "--models") options.models = list();
    else if (name === "--languages") options.languages = list();
    else if (name === "--out") options.out = value();
    else if (name === "--concurrency") options.concurrency = Number(value());
    else throw new Error(`Unknown argument ${args[index]}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a whole number from 1");
  }
  return options;
}

/** A provider that counts, per language, the strings it was asked for more than once. */
function counting(provider: TranslationProvider) {
  const seen = new Map<string, Set<string>>();
  const retried = new Map<string, Set<string>>();
  const wrapped: TranslationProvider = {
    name: provider.name,
    translate(request) {
      const language = request.batch?.targetLanguage ?? "";
      const known = seen.get(language) ?? new Set();
      const again = retried.get(language) ?? new Set();
      for (const string of request.batch?.strings ?? []) {
        if (known.has(string.id)) again.add(string.id);
        known.add(string.id);
      }
      seen.set(language, known);
      retried.set(language, again);
      return provider.translate(request);
    },
    generateText: (request) => provider.generateText(request),
    listModels: () => provider.listModels(),
  };
  return { provider: wrapped, retried: (language: string) => retried.get(language) ?? new Set() };
}

/**
 * Evaluates each model in each language. `providerFor` makes the provider for a model
 * (Gemini with the key; tests pass the fake translator).
 */
export async function evaluate(
  options: EvalOptions,
  providerFor: (model: string) => TranslationProvider,
  log: (line: string) => void = () => {},
): Promise<EvalResult[]> {
  const { config, sources } = await readProjectFiles(demoDir());
  const results: EvalResult[] = [];
  for (const model of options.models) {
    const database = openNodeSqlite(":memory:");
    try {
      const counted = counting(providerFor(model));
      const service = createService({
        sql: database.sql,
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "llm-eval-".repeat(8),
        provider: counted.provider,
        llmConcurrency: options.concurrency,
        defaultModel: model,
      });
      await service.start();
      // One job per language, so that each has its own tokens and time.
      database.sql.run(
        "UPDATE settings SET data = json_set(data, '$.llm.autoTranslate', json('false'))",
      );
      await service.upload(SYSTEM, {
        files: sources,
        sourceLanguage: config.sourceLanguage,
        languages: options.languages,
        limits: config.limits,
        pluralExclusions: config.pluralExclusions,
      });
      for (const language of options.languages) {
        log(`${model}, ${language}…`);
        const started = performance.now();
        const { job } = await service.createJob(SYSTEM, { languages: [language] });
        if (job === null) throw new Error("No job was created");
        for (let runs = 0; runs < 1000; runs++) {
          const current = await service.getJob(SYSTEM, { id: job.id });
          if (current.status !== "queued" && current.status !== "running") break;
          await service.alarm();
        }
        const seconds = (performance.now() - started) / 1000;
        const done = await service.getJob(SYSTEM, { id: job.id });
        if (done.status !== "done") {
          throw new Error(`The job for ${model} in ${language} ${done.status}: ${done.error}`);
        }
        const page = await service.listStrings(SYSTEM, { language, limit: 500 });
        const requests = database.sql.query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM llm_requests WHERE job_id = ? AND strings > 0",
          job.id,
        )[0].n;
        const strings = page.strings.length;
        // Strings asked for again, or that failed without a retry (a provider error).
        const missed = new Set(counted.retried(language));
        for (const failure of done.failures) missed.add(`s${failure.stringId}`);
        results.push({
          model,
          language,
          strings,
          firstTry: strings - missed.size,
          translated: page.strings.filter((string) => string.translation !== null).length,
          tokens: done.tokens,
          requests,
          seconds: Math.round(seconds * 10) / 10,
          failures: done.failures.map(({ file, key, reason }) => ({ file, key, reason })),
          translations: page.strings.map((string) => ({
            file: string.file,
            key: string.key,
            english: string.source,
            translation: string.translation?.value ?? null,
          })),
        });
      }
    } finally {
      database.close();
    }
  }
  return results;
}

/** The results as a table. */
export function report(results: EvalResult[]): string {
  const percent = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((n * 100) / of)}%`);
  const rows = [
    [
      "model",
      "lang",
      "strings",
      "first try",
      "after retries",
      "input",
      "output",
      "thinking",
      "requests",
      "time",
    ],
    ...results.map((result) => [
      result.model,
      result.language,
      String(result.strings),
      percent(result.firstTry, result.strings),
      percent(result.translated, result.strings),
      result.tokens.input.toLocaleString("en"),
      result.tokens.output.toLocaleString("en"),
      result.tokens.thinking.toLocaleString("en"),
      String(result.requests),
      `${result.seconds.toFixed(1)} s`,
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
        )
        .join("  "),
    )
    .join("\n");
}

if (import.meta.main) {
  const key = process.env["GEMINI_API_KEY"]?.trim();
  if (!key) {
    console.error(
      "The LLM evaluation needs a Gemini API key, and spends tokens: " +
        "GEMINI_API_KEY=… deno task test:llm [--models a,b] [--languages de,pl,ja] [--out file]",
    );
    process.exit(1);
  }
  let options: EvalOptions;
  try {
    options = parseOptions(process.argv.slice(2), { GEMINI_MODEL: process.env["GEMINI_MODEL"] });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  console.error(
    `Translating ${fromFileUrl(new URL("../examples/demo-game/", import.meta.url))} into ${options.languages.join(
      ", ",
    )} with ${options.models.join(", ")}…`,
  );
  const results = await evaluate(
    options,
    // The model is chosen per request, from the instance's settings.
    () => createGeminiProvider({ apiKey: key }),
    (line) => console.error(line),
  );
  console.log(report(results));
  for (const result of results) {
    for (const failure of result.failures) {
      console.log(
        `  ${result.model} ${result.language}: ${failure.file} › ${failure.key}: ${failure.reason}`,
      );
    }
  }
  await fs.mkdir(dirname(options.out), { recursive: true });
  await fs.writeFile(
    options.out,
    `${JSON.stringify({ at: new Date().toISOString(), options, results }, null, 2)}\n`,
  );
  console.error(`The translations are in ${options.out}, for a native speaker's review.`);
}
