// SPDX-License-Identifier: MIT
import { SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { suggestWithLlm, type LlmSuggestionOptions } from "../jobs/llm_suggestion.ts";
import { recordRequestAsync } from "../jobs/usage.ts";
import { createFakeTranslator, FAKE_MODEL } from "../llm/fake.ts";
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
    name: "a manager gets the LLM's translation of the string",
    async run(sql) {
      await seed(sql);
      const suggestion = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { id: 1, language: "de" },
        options(sql),
      );
      checkEqual(suggestion, { value: "[Ĥéļļö]", model: FAKE_MODEL });
    },
  },
  {
    name: "the suggestion isn't saved as a translation",
    async run(sql) {
      await seed(sql);
      await suggestWithLlm(sql, MANAGER_OF_DE, { id: 1, language: "de" }, options(sql));
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
      await suggestWithLlm(sql, MANAGER_OF_DE, { id: 1, language: "de" }, options(sql));
      const [rows] = await sql.read([
        { sql: "SELECT job_id, language, strings, outcome FROM llm_requests" },
      ]);
      checkEqual(rows, [{ job_id: null, language: "de", strings: 1, outcome: "ok" }]);
    },
  },
  {
    name: "a proofread string gets a fresh suggestion too",
    async run(sql) {
      await seed(sql);
      const suggestion = await suggestWithLlm(
        sql,
        MANAGER_OF_DE,
        { id: 4, language: "de" },
        options(sql),
      );
      checkEqual(suggestion.value, "[Ĥéļļö]");
    },
  },
  {
    name: "contributors can't ask for suggestions",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, CONTRIBUTOR, { id: 1, language: "de" }, options(sql)),
      );
      checkEqual(code, "forbidden");
    },
  },
  {
    name: "a manager can't ask in a language that isn't theirs",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, MANAGER_OF_DE, { id: 1, language: "fr" }, options(sql)),
      );
      checkEqual(code, "forbidden");
    },
  },
  {
    name: "without a provider, the LLM is unavailable",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, SYSTEM, { id: 1, language: "de" }, options(sql, { provider: null })),
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
          { id: 1, language: "de" },
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
      const code = await failure(() =>
        suggestWithLlm(sql, SYSTEM, { id: 8, language: "de" }, options(sql)),
      );
      checkEqual(code, "not_found");
    },
  },
  {
    name: "a language the project doesn't have has no suggestion",
    async run(sql) {
      await seed(sql);
      const code = await failure(() =>
        suggestWithLlm(sql, SYSTEM, { id: 1, language: "it" }, options(sql)),
      );
      checkEqual(code, "not_found");
    },
  },
];
