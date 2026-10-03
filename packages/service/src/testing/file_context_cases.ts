// SPDX-License-Identifier: MIT
import { SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { generateFileContextAsync } from "../jobs/file_context.ts";
import { cancelJobAsync } from "../jobs/jobs.ts";
import { recordRequestAsync } from "../jobs/usage.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { ProviderError, type TextRequest } from "../llm/provider.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobWork } from "./job_work_cases.ts";

const RESULT = {
  text: "  Generated context  ",
  model: "reported-model",
  usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 2 },
};
function options(generateText: (request: TextRequest) => Promise<typeof RESULT>) {
  return {
    provider: { ...createFakeTranslator(), generateText },
    clock: () => 200,
    model: "test",
    monthlyTokenBudget: null,
  };
}
export const FILE_CONTEXT_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "failed requests with no usage still record an attempt and do not add tokens",
    async run(sql) {
      await seedJobWork(sql);
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async () => {
          throw new ProviderError("network", "Offline");
        }),
      );
      checkEqual(
        await sql.read([
          {
            sql: "SELECT outcome, error, input_tokens, output_tokens, thinking_tokens FROM llm_requests",
          },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
        ]),
        [
          [
            {
              outcome: "failed",
              error: "Offline",
              input_tokens: 0,
              output_tokens: 0,
              thinking_tokens: 0,
            },
          ],
          [{ input_tokens: 0 }],
        ],
      );
    },
  },
  {
    name: "a replacement job cannot receive a prior job's usage or generated context",
    async run(sql) {
      await seedJobWork(sql);
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async () => {
          await sql.commit(1, [
            { sql: "DELETE FROM jobs WHERE id = 1" },
            {
              sql: "INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (1, 'queued', 2, 'website', '{}', 'system', 300, 300)",
            },
          ]);
          return RESULT;
        }),
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT job_id, input_tokens FROM llm_requests" },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
        ]),
        [
          [{ job_id: null, input_tokens: 10 }],
          [{ input_tokens: 0 }],
          [{ generated_context: null }],
        ],
      );
    },
  },
  {
    name: "context and usage commit together and a completed attempt is never repeated",
    async run(sql) {
      await seedJobWork(sql);
      await sql.commit(1, [
        { sql: `UPDATE jobs SET scope = '{"model":"custom-model"}' WHERE id = 1` },
      ]);
      const requests: TextRequest[] = [];
      const env = options(async (request) => {
        requests.push(request);
        return RESULT;
      });
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), 1);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      checkEqual(requests.length, 1);
      checkEqual(requests[0].model, "custom-model");
      check(requests[0].prompt.includes('"key":"1","english":"Hello"'));
      check(!requests[0].prompt.includes('"key":"8"'));
      checkEqual(
        await sql.read([
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
          {
            sql: "SELECT language, file_id, strings, model, outcome, created_at FROM llm_requests",
          },
          { sql: "SELECT input_tokens, output_tokens, thinking_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [
          [{ generated_context: "Generated context" }],
          [
            {
              language: null,
              file_id: 1,
              strings: 0,
              model: "reported-model",
              outcome: "ok",
              created_at: 200,
            },
          ],
          [{ input_tokens: 10, output_tokens: 5, thinking_tokens: 2 }],
          [{ value: "3" }],
        ],
      );
    },
  },
  {
    name: "blank answers record an attempt without a cache and a later job can ask again",
    async run(sql) {
      await seedJobWork(sql);
      let requests = 0;
      const env = options(async () => {
        requests++;
        return { ...RESULT, text: "  " };
      });
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), 1);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      await sql.commit(2, [
        {
          sql: "INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (2, 'queued', 2, 'website', '{}', 'system', 200, 200)",
        },
      ]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 2, 1, env), 2);
      checkEqual(requests, 2);
      checkEqual(await sql.read([{ sql: "SELECT generated_context FROM files WHERE id = 1" }]), [
        [{ generated_context: null }],
      ]);
    },
  },
  {
    name: "provider failures preserve supplied usage and prevent repeated attempts with post-commit logs",
    async run(sql) {
      await seedJobWork(sql);
      let requests = 0;
      let now = 200;
      const logs: unknown[] = [];
      const env = {
        ...options(async () => {
          requests++;
          now = 250;
          throw new ProviderError("blocked", "Blocked", { usage: RESULT.usage });
        }),
        clock: () => now,
        logger: {
          debug: () => {},
          info: () => {},
          error: () => {},
          warn: (...args: unknown[]) => logs.push(args),
        },
      };
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), 1);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      checkEqual(requests, 1);
      checkEqual(logs, [["Couldn't generate a file's context", { fileId: 1, error: "Blocked" }]]);
      checkEqual(
        await sql.read([
          { sql: "SELECT outcome, error, duration_ms, input_tokens FROM llm_requests" },
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
        ]),
        [
          [{ outcome: "blocked", error: "Blocked", duration_ms: 50, input_tokens: 10 }],
          [{ generated_context: null }],
        ],
      );
    },
  },
  {
    name: "written context and existing generated context prevent provider calls",
    async run(sql) {
      await seedJobWork(sql);
      const env = options(async () => {
        throw new Error("Unexpected provider call");
      });
      await sql.commit(1, [{ sql: "UPDATE files SET context = 'Written' WHERE id = 1" }]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      await sql.commit(2, [
        { sql: "UPDATE files SET context = '', generated_context = '' WHERE id = 1" },
      ]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      checkEqual(await sql.read([{ sql: "SELECT id FROM llm_requests" }]), [[]]);
    },
  },
  {
    name: "unavailable provider, inactive or missing files and inactive jobs cannot generate context",
    async run(sql) {
      await seedJobWork(sql);
      const env = options(async () => {
        throw new Error("Unexpected provider call");
      });
      checkEqual(
        await generateFileContextAsync(sql, SYSTEM, 1, 1, { ...env, provider: null }),
        null,
      );
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 3, env), null);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 999, env), null);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 999, 1, env), null);
      await sql.commit(1, [{ sql: "UPDATE jobs SET status = 'paused' WHERE id = 1" }]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      await sql.commit(2, [{ sql: "UPDATE jobs SET status = 'cancelled' WHERE id = 1" }]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
    },
  },
  {
    name: "disabled context and empty English skip generation while the budget pauses active jobs",
    async run(sql) {
      await seedJobWork(sql);
      const env = options(async () => {
        throw new Error("Unexpected provider call");
      });
      await sql.commit(1, [
        { sql: `INSERT INTO settings VALUES (1, '{"llm":{"context":{"fileContext":false}}}')` },
      ]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      await sql.commit(2, [
        { sql: "DELETE FROM settings" },
        { sql: "UPDATE strings SET active = 0 WHERE file_id = 1" },
      ]);
      checkEqual(await generateFileContextAsync(sql, SYSTEM, 1, 1, env), null);
      checkEqual(
        await generateFileContextAsync(sql, SYSTEM, 1, 2, { ...env, monthlyTokenBudget: 0 }),
        null,
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT status, error FROM jobs WHERE id = 1" },
          { sql: "SELECT id FROM llm_requests" },
        ]),
        [[{ status: "paused", error: "Monthly token budget reached" }], []],
      );
    },
  },
  {
    name: "a person's context arriving during the request wins while usage is still recorded",
    async run(sql) {
      await seedJobWork(sql);
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async () => {
          await sql.commit(1, [
            { sql: "UPDATE files SET context = 'New written context' WHERE id = 1" },
          ]);
          return RESULT;
        }),
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT context, generated_context FROM files WHERE id = 1" },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
        ]),
        [[{ context: "New written context", generated_context: null }], [{ input_tokens: 10 }]],
      );
    },
  },
  {
    name: "English and file-path changes during the request discard the stale cache",
    async run(sql) {
      await seedJobWork(sql);
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async () => {
          await sql.commit(1, [{ sql: `UPDATE strings SET source = '"Changed"' WHERE id = 1` }]);
          return RESULT;
        }),
      );
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        2,
        options(async () => {
          await sql.commit(3, [{ sql: "UPDATE files SET path = 'renamed.json' WHERE id = 2" }]);
          return RESULT;
        }),
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT generated_context FROM files WHERE id IN (1,2) ORDER BY id" },
          { sql: "SELECT COUNT(*) AS n FROM llm_requests" },
        ]),
        [[{ generated_context: null }, { generated_context: null }], [{ n: 2 }]],
      );
    },
  },
  {
    name: "cancellation during the request discards the cache and retains paid usage",
    async run(sql) {
      await seedJobWork(sql);
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async () => {
          await cancelJobAsync(sql, SYSTEM, 1, 150);
          return RESULT;
        }),
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
          { sql: "SELECT status, input_tokens FROM jobs WHERE id = 1" },
        ]),
        [[{ generated_context: null }], [{ status: "cancelled", input_tokens: 10 }]],
      );
    },
  },
  {
    name: "commit retries preserve a competing cache and request ID without repeating the provider",
    async run(sql) {
      await seedJobWork(sql);
      let first = true;
      let calls = 0;
      const raced: Sql = {
        ...sql,
        async commit(revision, statements) {
          if (first) {
            first = false;
            await recordRequestAsync(
              sql,
              SYSTEM,
              {
                jobId: 1,
                language: "de",
                fileId: 1,
                provider: "fake",
                model: "test",
                strings: 1,
                usage: RESULT.usage,
                durationMs: 1,
                outcome: "ok",
                error: null,
              },
              150,
            );
            await sql.commit(2, [
              { sql: "UPDATE files SET generated_context = 'Competing' WHERE id = 1" },
            ]);
          }
          return sql.commit(revision, statements);
        },
      };
      checkEqual(
        await generateFileContextAsync(
          raced,
          SYSTEM,
          1,
          1,
          options(async () => {
            calls++;
            return RESULT;
          }),
        ),
        2,
      );
      checkEqual(calls, 1);
      checkEqual(
        await sql.read([
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT COUNT(*) AS n FROM llm_requests" },
        ]),
        [[{ generated_context: "Competing" }], [{ input_tokens: 20 }], [{ n: 2 }]],
      );
    },
  },
  {
    name: "cache failures roll back usage and tokens and unexpected provider failures stay visible",
    async run(sql) {
      await seedJobWork(sql);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await generateFileContextAsync(
          broken,
          SYSTEM,
          1,
          1,
          options(async () => RESULT),
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(
        await sql.read([
          { sql: "SELECT generated_context FROM files WHERE id = 1" },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT id FROM llm_requests" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ generated_context: null }], [{ input_tokens: 0 }], [], [{ value: "1" }]],
      );
      const providerFailure = new Error("Unexpected provider failure");
      try {
        await generateFileContextAsync(
          sql,
          SYSTEM,
          1,
          1,
          options(async () => {
            throw providerFailure;
          }),
        );
      } catch (error) {
        failure = error;
      }
      checkEqual(failure, providerFailure);
    },
  },
  {
    name: "non-system access fails before I/O and English context is limited to 200 strings",
    async run(sql) {
      const unavailable: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      let failure: unknown;
      try {
        await generateFileContextAsync(
          unavailable,
          { type: "user", userId: 1 },
          1,
          1,
          options(async () => RESULT),
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof ServiceError);
      checkEqual(failure.code, "forbidden");
      await seedJobWork(sql);
      await sql.commit(1, [
        {
          sql: `INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash, search_text, position, created_at, updated_at)
        SELECT value, 1, CAST(value AS TEXT), '[]', CAST(value AS TEXT), 'text', '"More"', 'new', '', value, 100, 100 FROM json_each(?)`,
          params: [JSON.stringify(Array.from({ length: 210 }, (_, index) => index + 100))],
        },
      ]);
      const requests: TextRequest[] = [];
      await generateFileContextAsync(
        sql,
        SYSTEM,
        1,
        1,
        options(async (request) => {
          requests.push(request);
          return RESULT;
        }),
      );
      checkEqual(
        requests[0].prompt.split("\n").filter((line) => line.startsWith('{"key":')).length,
        200,
      );
      check(requests[0].prompt.includes('"key":"293"'));
      check(!requests[0].prompt.includes('"key":"294"'));
    },
  },
];
