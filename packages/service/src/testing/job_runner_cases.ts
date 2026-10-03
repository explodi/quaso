// SPDX-License-Identifier: MIT
import { SYSTEM } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { cancelJobAsync } from "../jobs/jobs.ts";
import { runJobsAsync, type AsyncJobsOptions } from "../jobs/runner_async.ts";
import { MAX_ATTEMPTS, RETRY_BASE_MS } from "../jobs/runner.ts";
import { resumeJobsAsync, AUTH_ERROR, BUDGET_ERROR, NO_PROVIDER_ERROR } from "../jobs/store.ts";
import { answered, scriptedProvider } from "../jobs/testing.ts";
import { nextMonthStart } from "../jobs/usage.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { ProviderError } from "../llm/provider.ts";
import type { Sql } from "../ports.ts";
import { defaultSettings } from "../settings.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobWork } from "./job_work_cases.ts";

export async function seedJobRunner(sql: Sql, batchSize = 1) {
  await seedJobWork(sql);
  const settings = defaultSettings("test");
  settings.llm.batchSize = batchSize;
  settings.llm.context.fileContext = false;
  await sql.commit(1, [
    { sql: "DELETE FROM translations" },
    { sql: "DELETE FROM suggestions" },
    { sql: "DELETE FROM job_items" },
    { sql: "UPDATE strings SET active = CASE WHEN id IN (1,3,5) THEN 1 ELSE 0 END" },
    {
      sql: `UPDATE jobs SET status = 'queued', scope = '{"languages":["de"]}', total = 3 WHERE id = 1`,
    },
    { sql: "INSERT INTO settings VALUES (1, ?)", params: [JSON.stringify(settings)] },
  ]);
}
function run(sql: Sql, options: Partial<AsyncJobsOptions> = {}) {
  return runJobsAsync(sql, SYSTEM, {
    provider: createFakeTranslator(),
    concurrency: 1,
    model: "test",
    clock: () => 200,
    ...options,
  });
}

export const JOB_RUNNER_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "four concurrent workers complete a twelve-batch slice without losing progress",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        { sql: "UPDATE jobs SET scope = '{}' WHERE id = 1" },
        { sql: "UPDATE strings SET active = 1 WHERE id BETWEEN 1 AND 7" },
      ]);
      let active = 0;
      let most = 0;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedProvider(async (_request, index) => {
        active++;
        most = Math.max(most, active);
        if (index === 3) release();
        await started;
        active--;
        return undefined;
      });
      checkEqual(await run(sql, { provider, concurrency: 4 }), 200);
      checkEqual([most, provider.requests.length], [4, 12]);
      checkEqual(
        await sql.read([{ sql: "SELECT status, total, done, translated FROM jobs WHERE id = 1" }]),
        [[{ status: "running", total: 14, done: 12, translated: 12 }]],
      );
      checkEqual(await run(sql, { provider, concurrency: 4 }), null);
      checkEqual(provider.requests.length, 14);
    },
  },
  {
    name: "plural QA retries preserve interpolation and masked references through the async runner",
    async run(sql) {
      await seedJobRunner(sql, 25);
      await sql.commit(2, [
        {
          sql: `UPDATE strings SET kind = 'plural', source = '{"one":"{{count}} coin","other":"{{count}} coins"}', source_hash = 'plural' WHERE id = 3`,
        },
        { sql: `UPDATE strings SET source = '"Go $t(1)"', source_hash = 'reference' WHERE id = 5` },
      ]);
      const provider = scriptedProvider((request, index) =>
        index === 0
          ? answered({
              translations: request.batch!.strings.map((string) =>
                string.id === "s3"
                  ? { id: string.id, forms: { one: "{{count}} coin", other: "coins" } }
                  : { id: string.id, text: string.english },
              ),
            })
          : undefined,
      );
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 2);
      checkEqual(
        provider.requests[1].batch?.strings.map((string) => string.kind),
        ["plural"],
      );
      check(provider.requests[1].prompt.includes("Placeholder {{count}} is missing"));
      checkEqual(
        await sql.read([
          { sql: "SELECT value FROM translations WHERE string_id = 5 AND language = 'de'" },
          { sql: "SELECT qa_errors FROM translations WHERE string_id = 3 AND language = 'de'" },
        ]),
        [[{ value: '"Go $t(1)"' }], [{ qa_errors: 0 }]],
      );
    },
  },
  {
    name: "outdated proofread strings receive proposals while fresh green strings remain untouched",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at) VALUES (1, 'de', '"Fresh"', 'green', 'new', 'llm', 1, '', 100, 100), (3, 'de', '"Proofread"', 'blue', 'old', 'user', 1, '', 100, 100)`,
        },
      ]);
      const provider = scriptedProvider();
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 2);
      checkEqual(
        await sql.read([
          { sql: "SELECT value, colour FROM translations WHERE string_id = 3 AND language = 'de'" },
          { sql: "SELECT kind, status, source_hash FROM suggestions WHERE string_id = 3" },
          { sql: "SELECT translated, proposed, total FROM jobs WHERE id = 1" },
        ]),
        [
          [{ value: '"Proofread"', colour: "blue" }],
          [{ kind: "llm", status: "pending", source_hash: "new" }],
          [{ translated: 1, proposed: 1, total: 2 }],
        ],
      );
    },
  },
  {
    name: "failed file context is attempted once across alarm slices while translation continues",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        { sql: "UPDATE jobs SET scope = '{}' WHERE id = 1" },
        {
          sql: `UPDATE settings SET data = json_set(data, '$.llm.context.fileContext', json('true')) WHERE id = 1`,
        },
      ]);
      let contexts = 0;
      const provider = {
        ...scriptedProvider(),
        generateText: async () => {
          contexts++;
          throw new ProviderError("network", "Offline");
        },
      };
      checkEqual(await run(sql, { provider }), 200);
      checkEqual(await run(sql, { provider }), null);
      checkEqual(contexts, 1);
      checkEqual(
        await sql.read([
          { sql: "SELECT status, translated FROM jobs WHERE id = 1" },
          { sql: "SELECT COUNT(*) AS n FROM llm_requests WHERE language IS NULL" },
        ]),
        [[{ status: "done", translated: 6 }], [{ n: 1 }]],
      );
    },
  },
  {
    name: "an uneven concurrent slice records usage and finishes with creator activity",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider();
      checkEqual(await run(sql, { provider, concurrency: 2 }), null);
      checkEqual(provider.requests.length, 3);
      checkEqual(
        await sql.read([
          {
            sql: "SELECT status, total, done, translated, started_at, finished_at FROM jobs WHERE id = 1",
          },
          { sql: "SELECT COUNT(*) AS n FROM translations" },
          { sql: "SELECT COUNT(*) AS n FROM llm_requests" },
          { sql: "SELECT job_id FROM job_items" },
          { sql: "SELECT summary FROM activity" },
        ]),
        [
          [{ status: "done", total: 3, done: 3, translated: 3, started_at: 200, finished_at: 200 }],
          [{ n: 3 }],
          [{ n: 3 }],
          [],
          [{ summary: "Translation job 1 finished: 3 translated" }],
        ],
      );
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 3);
    },
  },
  {
    name: "single-string and upload jobs run before bulk jobs and empty jobs finish without requests",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        {
          sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (2, 'queued', 0, 'website', '{"languages":["de"],"strings":[1]}', 'system', 100, 100), (3, 'queued', 1, 'upload', '{"languages":["de"]}', 'system', 100, 100)`,
        },
      ]);
      const provider = scriptedProvider();
      checkEqual(await run(sql, { provider }), 200);
      checkEqual(
        provider.requests[0].batch?.strings.map((string) => string.id),
        ["s1"],
      );
      checkEqual(await sql.read([{ sql: "SELECT id, status FROM jobs ORDER BY id" }]), [
        [
          { id: 1, status: "queued" },
          { id: 2, status: "done" },
          { id: 3, status: "queued" },
        ],
      ]);
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 3);
      checkEqual(
        await sql.read([{ sql: "SELECT id, status, total, translated FROM jobs ORDER BY id" }]),
        [
          [
            { id: 1, status: "done", total: 0, translated: 0 },
            { id: 2, status: "done", total: 1, translated: 1 },
            { id: 3, status: "done", total: 2, translated: 2 },
          ],
        ],
      );
    },
  },
  {
    name: "concurrency and three-batches-per-worker bounds preserve remaining work for the next alarm",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        { sql: "UPDATE jobs SET scope = '{}' WHERE id = 1" },
        { sql: "UPDATE strings SET active = 1 WHERE id = 7" },
      ]);
      let active = 0;
      let most = 0;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedProvider(async (_request, index) => {
        active++;
        most = Math.max(most, active);
        if (index === 1) release();
        await started;
        active--;
        return undefined;
      });
      checkEqual(await run(sql, { provider, concurrency: 2 }), 200);
      checkEqual([most, provider.requests.length], [2, 6]);
      checkEqual(await sql.read([{ sql: "SELECT status, total, done FROM jobs WHERE id = 1" }]), [
        [{ status: "running", total: 8, done: 6 }],
      ]);
      checkEqual(await run(sql, { provider, concurrency: 2 }), null);
      checkEqual(provider.requests.length, 8);
    },
  },
  {
    name: "failed answers retry only failed strings with reasons and each request's usage",
    async run(sql) {
      await seedJobRunner(sql, 25);
      const provider = scriptedProvider((request, index) =>
        index === 0
          ? answered({
              translations: request
                .batch!.strings.filter((string) => string.id !== "s3")
                .map((string) => ({ id: string.id, text: "Hallo" })),
            })
          : undefined,
      );
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 2);
      checkEqual(
        provider.requests[1].batch?.strings.map((string) => string.id),
        ["s3"],
      );
      check(provider.requests[1].prompt.includes("No translation was returned."));
      checkEqual(
        await sql.read([
          { sql: "SELECT outcome FROM llm_requests ORDER BY id" },
          { sql: "SELECT status, translated, failed FROM jobs WHERE id = 1" },
        ]),
        [
          [{ outcome: "partial" }, { outcome: "ok" }],
          [{ status: "done", translated: 3, failed: 0 }],
        ],
      );
    },
  },
  {
    name: "three failed answers record per-string failure and finish without repeated work",
    async run(sql) {
      await seedJobRunner(sql, 25);
      const provider = scriptedProvider(() => answered({ translations: [] }));
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 3);
      checkEqual(
        await sql.read([
          { sql: "SELECT status, failed, done FROM jobs WHERE id = 1" },
          { sql: "SELECT COUNT(*) AS n FROM llm_failures" },
        ]),
        [[{ status: "done", failed: 3, done: 3 }], [{ n: 3 }]],
      );
    },
  },
  {
    name: "blocked provider failures split retries and keep their billed usage",
    async run(sql) {
      await seedJobRunner(sql, 25);
      const provider = scriptedProvider((_request, index) => {
        if (index === 0)
          throw new ProviderError("blocked", "Blocked", {
            usage: { inputTokens: 10, outputTokens: 0, thinkingTokens: 0 },
          });
        return undefined;
      });
      checkEqual(await run(sql, { provider }), null);
      checkEqual(
        provider.requests.map((request) => request.batch?.strings.length),
        [3, 2, 1],
      );
      checkEqual(await sql.read([{ sql: "SELECT outcome FROM llm_requests ORDER BY id" }]), [
        [{ outcome: "blocked" }, { outcome: "ok" }, { outcome: "ok" }],
      ]);
    },
  },
  {
    name: "auth failures pause the job until an explicit restart resumes it",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider(() => {
        throw new ProviderError("auth", "Refused");
      });
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 1);
      checkEqual(await sql.read([{ sql: "SELECT status, error, done FROM jobs WHERE id = 1" }]), [
        [{ status: "paused", error: AUTH_ERROR, done: 0 }],
      ]);
      checkEqual(await run(sql), null);
      checkEqual(await resumeJobsAsync(sql, SYSTEM, 300), true);
      checkEqual(await run(sql), null);
      checkEqual(await sql.read([{ sql: "SELECT status FROM jobs WHERE id = 1" }]), [
        [{ status: "done" }],
      ]);
    },
  },
  {
    name: "no provider pauses active work without requests or a repeated write",
    async run(sql) {
      await seedJobRunner(sql);
      checkEqual(await run(sql, { provider: null }), null);
      checkEqual(await sql.read([{ sql: "SELECT status, error FROM jobs WHERE id = 1" }]), [
        [{ status: "paused", error: NO_PROVIDER_ERROR }],
      ]);
      const readOnly: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await run(readOnly, { provider: null }), null);
    },
  },
  {
    name: "budget exhaustion stops before the next request and resumes in the next UTC month",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider();
      checkEqual(await run(sql, { provider, monthlyTokenBudget: 1 }), nextMonthStart(200));
      checkEqual(provider.requests.length, 1);
      checkEqual(await sql.read([{ sql: "SELECT status, error, done FROM jobs WHERE id = 1" }]), [
        [{ status: "paused", error: BUDGET_ERROR, done: 1 }],
      ]);
      checkEqual(
        await run(sql, { provider, monthlyTokenBudget: 1, clock: () => nextMonthStart(200) }),
        nextMonthStart(nextMonthStart(200)),
      );
      checkEqual(provider.requests.length, 2);
      checkEqual(await run(sql, { provider, monthlyTokenBudget: null }), null);
      checkEqual(provider.requests.length, 3);
    },
  },
  {
    name: "unexpected failures back off and fail the job on the fifth run",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider(() => {
        throw new Error("Unexpected");
      });
      checkEqual(await run(sql, { provider }), 200 + RETRY_BASE_MS);
      checkEqual(await run(sql, { provider }), 200 + RETRY_BASE_MS * 2);
      await sql.commit(5, [{ sql: "UPDATE jobs SET attempts = 4 WHERE id = 1" }]);
      checkEqual(await run(sql, { provider }), null);
      checkEqual(
        await sql.read([
          { sql: "SELECT status, attempts, error FROM jobs WHERE id = 1" },
          { sql: "SELECT summary FROM activity" },
        ]),
        [
          [
            {
              status: "failed",
              attempts: MAX_ATTEMPTS,
              error: "The job failed 5 times in a row: Unexpected",
            },
          ],
          [{ summary: "Translation job 1 failed: 0 translated" }],
        ],
      );
    },
  },
  {
    name: "cancellation during a request records usage and drops results without resuming the job",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider(async () => {
        await cancelJobAsync(sql, SYSTEM, 1, 150);
        return undefined;
      });
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.requests.length, 1);
      checkEqual(
        await sql.read([
          { sql: "SELECT status, done FROM jobs WHERE id = 1" },
          { sql: "SELECT string_id FROM translations" },
          { sql: "SELECT COUNT(*) AS n FROM llm_requests" },
        ]),
        [[{ status: "cancelled", done: 0 }], [], [{ n: 1 }]],
      );
    },
  },
  {
    name: "a person's translation during the provider request wins over the result",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider(async (_request, index) => {
        if (index === 0)
          await sql.commit(3, [
            {
              sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at) VALUES (1, 'de', '"Person"', 'blue', 'new', 'user', 4, '', 100, 100)`,
            },
          ]);
        return undefined;
      });
      checkEqual(await run(sql, { provider }), null);
      checkEqual(
        await sql.read([
          { sql: "SELECT value, colour FROM translations WHERE string_id = 1 AND language = 'de'" },
          { sql: "SELECT translated, skipped FROM jobs WHERE id = 1" },
        ]),
        [[{ value: '"Person"', colour: "blue" }], [{ translated: 2, skipped: 1 }]],
      );
    },
  },
  {
    name: "file context is generated before batches and only once for a job",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        {
          sql: `UPDATE settings SET data = json_set(data, '$.llm.context.fileContext', json('true')) WHERE id = 1`,
        },
      ]);
      const provider = scriptedProvider();
      checkEqual(await run(sql, { provider }), null);
      checkEqual(provider.texts.length, 1);
      check(provider.requests[0].prompt.includes("A file of texts"));
      checkEqual(
        await sql.read([{ sql: "SELECT COUNT(*) AS n FROM llm_requests WHERE language IS NULL" }]),
        [[{ n: 1 }]],
      );
    },
  },
  {
    name: "replaced jobs cannot receive old results or usage and start on a later alarm",
    async run(sql) {
      await seedJobRunner(sql);
      const provider = scriptedProvider(async (_request, index) => {
        if (index === 0)
          await sql.commit(3, [
            { sql: "DELETE FROM jobs WHERE id = 1" },
            {
              sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (1, 'queued', 2, 'website', '{"languages":["de"]}', 'system', 300, 300)`,
            },
          ]);
        return undefined;
      });
      checkEqual(await run(sql, { provider }), 200);
      checkEqual(provider.requests.length, 1);
      checkEqual(
        await sql.read([
          { sql: "SELECT status, done, input_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT string_id FROM translations" },
          { sql: "SELECT job_id FROM llm_requests" },
        ]),
        [[{ status: "queued", done: 0, input_tokens: 0 }], [], [{ job_id: null }]],
      );
      checkEqual(await run(sql), null);
    },
  },
  {
    name: "system access is required before any SQL or provider call",
    async run(sql) {
      const readOnly: Sql = {
        ...sql,
        read: async () => {
          throw new Error("Unexpected read");
        },
      };
      let failure: unknown;
      try {
        await runJobsAsync(
          readOnly,
          { type: "user", userId: 1 },
          { provider: createFakeTranslator() },
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof ServiceError);
      checkEqual(failure.code, "forbidden");
    },
  },
];
