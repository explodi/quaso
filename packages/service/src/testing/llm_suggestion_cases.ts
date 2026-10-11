// SPDX-License-Identifier: MIT
import { SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { suggestWithLlm, type LlmSuggestionOptions } from "../jobs/llm_suggestion.ts";
import { recordRequestAsync } from "../jobs/usage.ts";
import { createFakeTranslator, FAKE_MODEL } from "../llm/fake.ts";
import type { ProviderRequest, TranslationProvider } from "../llm/provider.ts";
import { NO_TRANSLATION } from "../llm/results.ts";
import { silentLogger, type Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobWork } from "./job_work_cases.ts";

const MANAGER_OF_DE: Actor = { type: "user", userId: 2 };
const CONTRIBUTOR: Actor = { type: "user", userId: 3 };

async function seed(sql: Sql) {
  await seedJobWork(sql);
  await sql.commit(1, [
    {
      sql: "INSERT INTO users (id, display_name, role, languages, created_at) VALUES (2, 'Manager', 'manager', '[\"de\"]', 100), (3, 'Contributor', 'contributor', NULL, 100)",
    },
  ]);
}

function options(sql: Sql, change: Partial<LlmSuggestionOptions> = {}): LlmSuggestionOptions {
  return {
    provider: createFakeTranslator(),
    model: "test",
    monthlyTokenBudget: null,
    clock: () => 200,
    logger: silentLogger,
    record: (entry) => recordRequestAsync(sql, SYSTEM, entry, 200),
    ...change,
  };
}

/** A provider that keeps the requests it gets. */
function recording(inner: TranslationProvider) {
  const requests: ProviderRequest[] = [];
  const provider: TranslationProvider = {
    ...inner,
    translate(request) {
      requests.push(request);
      return inner.translate(request);
    },
  };
  return { provider, requests };
}

/** A provider whose answers never have a translation, as if the model ignored the strings. */
const SILENT_PROVIDER: TranslationProvider = {
  ...createFakeTranslator(),
  translate: () =>
    Promise.resolve({
      answer: { translations: [] },
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
      durationMs: 0,
    }),
};

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    check(error instanceof ServiceError);
    return error.code;
  }
  return "no error";
}

export const LLM_SUGGESTION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "a manager gets the LLM's translation of a string",
    async run(sql) {
      await seed(sql);
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [1] },
        options(sql),
      );
      checkEqual(result, {
        suggestions: [{ id: 1, value: "[Ĥéļļö]", model: FAKE_MODEL }],
        failed: [],
      });
    },
  },
  {
    name: "several strings of a file are one request, answered in the order asked",
    async run(sql) {
      await seed(sql);
      const { provider, requests } = recording(createFakeTranslator());
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [3, 1, 2] },
        options(sql, { provider }),
      );
      checkEqual(
        result.suggestions.map((suggestion) => suggestion.id),
        [3, 1, 2],
      );
      checkEqual(requests.length, 1);
    },
  },
  {
    name: "strings of different files are one request per file",
    async run(sql) {
      await seed(sql);
      await suggestWithLlm(sql, MANAGER_OF_DE, { language: "de", ids: [1, 7] }, options(sql));
      const [rows] = await sql.read([
        { sql: "SELECT file_id, strings FROM llm_requests ORDER BY file_id" },
      ]);
      checkEqual(rows, [
        { file_id: 1, strings: 1 },
        { file_id: 2, strings: 1 },
      ]);
    },
  },
  {
    name: "a string without a suggestion doesn't hold up the others",
    async run(sql) {
      await seed(sql);
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [1, 8, 2] },
        options(sql),
      );
      checkEqual(
        result.suggestions.map((suggestion) => suggestion.id),
        [1, 2],
      );
      checkEqual(result.failed, [
        { id: 8, message: "String 8 wasn't found, or isn't translated." },
      ]);
    },
  },
  {
    name: "the suggestions aren't saved as translations",
    async run(sql) {
      await seed(sql);
      await suggestWithLlm(sql, MANAGER_OF_DE, { language: "de", ids: [1] }, options(sql));
      const [rows] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM translations WHERE string_id = 1" },
      ]);
      checkEqual(rows[0].n, 0);
    },
  },
  {
    name: "the request counts in the usage, outside any job",
    async run(sql) {
      await seed(sql);
      await suggestWithLlm(sql, MANAGER_OF_DE, { language: "de", ids: [1, 2] }, options(sql));
      const [rows] = await sql.read([
        { sql: "SELECT job_id, language, strings, outcome FROM llm_requests" },
      ]);
      checkEqual(rows, [{ job_id: null, language: "de", strings: 2, outcome: "ok" }]);
    },
  },
  {
    name: "a proofread string gets a fresh suggestion too",
    async run(sql) {
      await seed(sql);
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [4] },
        options(sql),
      );
      checkEqual(result.suggestions[0].value, "[Ĥéļļö]");
    },
  },
  {
    name: "a suggestion asks for as little thinking as the model allows",
    async run(sql) {
      await seed(sql);
      const { provider, requests } = recording(createFakeTranslator());
      await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [1] },
        options(sql, { provider }),
      );
      checkEqual(requests[0].thinking, "low");
    },
  },
  {
    name: "an answer that fails the checks isn't asked for again",
    async run(sql) {
      await seed(sql);
      const { provider, requests } = recording(SILENT_PROVIDER);
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [1] },
        options(sql, { provider }),
      );
      checkEqual(result.failed, [{ id: 1, message: NO_TRANSLATION }]);
      checkEqual(requests.length, 1);
    },
  },
  {
    name: "a request that outlasts the deadline is reported as too slow",
    async run(sql) {
      await seed(sql);
      const slow = createFakeTranslator({ delayMs: 5_000 });
      const result = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { language: "de", ids: [1] },
        options(sql, { provider: slow, deadlineMs: 10 }),
      );
      checkEqual(result.failed, [{ id: 1, message: "The LLM took too long to answer." }]);
    },
  },
  {
    name: "contributors can't ask for suggestions",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, CONTRIBUTOR, { language: "de", ids: [1] }, options(sql)),
      );
      checkEqual(code, "forbidden");
    },
  },
  {
    name: "a manager can't ask in a language that isn't theirs",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, MANAGER_OF_DE, { language: "fr", ids: [1] }, options(sql)),
      );
      checkEqual(code, "forbidden");
    },
  },
  {
    name: "without a provider, the LLM is unavailable",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, SYSTEM, { language: "de", ids: [1] }, options(sql, { provider: null })),
      );
      checkEqual(code, "llm_unavailable");
    },
  },
  {
    name: "a used-up monthly budget stops suggestions",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(
          sql,
          SYSTEM,
          { language: "de", ids: [1] },
          options(sql, { monthlyTokenBudget: 0 }),
        ),
      );
      checkEqual(code, "budget_exceeded");
    },
  },
  {
    name: "a string copied from the English has no suggestion",
    async run(sql) {
      await seed(sql);
      const result = await suggestWithLlm(sql, SYSTEM, { language: "de", ids: [8] }, options(sql));
      checkEqual(result.suggestions, []);
      checkEqual(
        result.failed.map((entry) => entry.id),
        [8],
      );
    },
  },
  {
    name: "a language the project doesn't have has no suggestion",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, SYSTEM, { language: "it", ids: [1] }, options(sql)),
      );
      checkEqual(code, "not_found");
    },
  },
];
