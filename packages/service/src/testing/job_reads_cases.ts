// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { getJobAsync, listJobsAsync } from "../jobs/jobs.ts";
import { getUsageAsync } from "../jobs/usage.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

const NOW = Date.UTC(2026, 8, 25, 12);
const MANAGER: Actor = { type: "user", userId: 1 };
const KEY: Actor = { type: "token", tokenId: 7 };

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, languages, created_at) VALUES (1, 'Ada', 'manager', '[\"de\"]', 100), (2, 'Reader', 'contributor', NULL, 100)",
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'CI', 'upload', 'hash', 'qso_', 100)",
    },
    {
      sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, total, done, translated, proposed, failed, skipped, input_tokens, output_tokens, thinking_tokens, failures, error, created_at, started_at, finished_at, updated_at)
        VALUES (1, 'failed', 0, 'website', '{"languages":["fr"],"strings":[123]}', 'user', 1, 2, 4, 1, 1, 1, 1, 10, 20, 30, '[{"stringId":123,"language":"fr","reason":"Refused"}]', 'Provider failed', 100, 200, 300, 300)`,
    },
    {
      sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, created_at, updated_at)
        VALUES (2, 'queued', 1, 'cli', '{}', 'token', 7, 400, 400)`,
    },
    {
      sql: `INSERT INTO llm_requests (provider, model, language, input_tokens, output_tokens, thinking_tokens, outcome, created_at)
        VALUES ('fake', 'model-a', 'de', 10, 2, 1, 'ok', ?),
          ('fake', 'model-a', 'fr', 20, 4, 2, 'failed', ?),
          ('fake', 'model-b', NULL, 30, 6, 3, 'blocked', ?),
          ('fake', 'model-b', 'de', 40, 8, 4, 'partial', ?),
          ('fake', 'model-b', 'de', 50, 10, 5, 'ok', ?)`,
      params: [
        Date.UTC(2026, 8, 24),
        Date.UTC(2026, 8, 24, 23, 59),
        Date.UTC(2026, 8, 25),
        Date.UTC(2026, 8, 26),
        Date.UTC(2026, 7, 31, 23, 59),
      ],
    },
  ]);
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const JOB_READ_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "active jobs include every queued or running row and exclude terminal or paused rows",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at)
          VALUES (3, 'running', 2, 'website', '{}', 'system', 100, 100),
          (4, 'done', 2, 'website', '{}', 'system', 100, 100),
          (5, 'cancelled', 2, 'website', '{}', 'system', 100, 100),
          (6, 'paused', 2, 'website', '{}', 'system', 100, 100)`,
        },
      ]);
      checkEqual(
        (await listJobsAsync(sql, KEY, { active: true })).jobs.map((job) => job.id),
        [3, 2],
      );
      checkEqual(
        (await listJobsAsync(sql, KEY, { active: false })).jobs.map((job) => job.id),
        [6, 5, 4, 3, 2, 1],
      );
      await sql.commit(2, [
        {
          sql: `WITH RECURSIVE ids(id) AS (SELECT 7 UNION ALL SELECT id + 1 FROM ids WHERE id < 61)
          INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at)
          SELECT id, 'running', 2, 'website', '{}', 'system', 100, 100 FROM ids`,
        },
      ]);
      const active = (await listJobsAsync(sql, SYSTEM, { active: true })).jobs;
      checkEqual([active.length, active[0].id, active[56].id], [57, 61, 2]);
      await rejected(() => listJobsAsync(sql, ANONYMOUS, { active: true }), "unauthorized");
      await rejected(
        () => listJobsAsync(sql, { type: "user", userId: 2 }, { active: true }),
        "forbidden",
      );
    },
  },
  {
    name: "job details decode scope, progress, failures, tokens and creator identities",
    async run(sql) {
      await seed(sql);
      checkEqual(await getJobAsync(sql, MANAGER, 1), {
        id: 1,
        status: "failed",
        priority: "string",
        scope: { languages: ["fr"], strings: [123] },
        createdBy: { type: "user", id: 1, name: "Ada", avatarUrl: null },
        createdAt: 100,
        startedAt: 200,
        finishedAt: 300,
        progress: { total: 4, done: 4, translated: 1, proposed: 1, failed: 1, skipped: 1 },
        tokens: { input: 10, output: 20, thinking: 30 },
        failures: [{ stringId: 123, language: "fr", reason: "Refused" }],
        error: "Provider failed",
      });
      checkEqual(
        (await listJobsAsync(sql, KEY)).jobs.map((job) => [
          job.id,
          job.priority,
          job.createdBy.name,
        ]),
        [
          [2, "upload", "CI"],
          [1, "string", "Ada"],
        ],
      );
      await rejected(() => getJobAsync(sql, MANAGER, 999), "not_found");
    },
  },
  {
    name: "job lists return only the newest fifty rows",
    async run(sql) {
      await seed(sql);
      await sql.commit(1, [
        {
          sql: `WITH RECURSIVE ids(id) AS (SELECT 3 UNION ALL SELECT id + 1 FROM ids WHERE id < 55)
          INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_label, created_at, updated_at)
          SELECT id, 'done', 2, 'upload', '{}', 'system', 'System', 100, 100 FROM ids`,
        },
      ]);
      const jobs = (await listJobsAsync(sql, SYSTEM)).jobs;
      checkEqual([jobs.length, jobs[0].id, jobs[49].id, jobs[0].priority], [50, 55, 6, "bulk"]);
    },
  },
  {
    name: "job and usage reads enforce role and API-key access",
    async run(sql) {
      await seed(sql);
      await rejected(() => listJobsAsync(sql, ANONYMOUS), "unauthorized");
      await rejected(
        () => getUsageAsync(sql, ANONYMOUS, { period: "day" }, null, NOW),
        "unauthorized",
      );
      await rejected(() => getJobAsync(sql, { type: "user", userId: 2 }, 1), "forbidden");
      await rejected(
        () => getUsageAsync(sql, { type: "user", userId: 2 }, { period: "day" }, null, NOW),
        "forbidden",
      );
      checkEqual(
        (await getUsageAsync(sql, KEY, { period: "day" }, null, NOW)).budget.usedThisMonth,
        130,
      );
      await sql.commit(1, [{ sql: "UPDATE api_tokens SET scope = 'read'" }]);
      await rejected(() => listJobsAsync(sql, KEY), "forbidden");
      await rejected(() => getUsageAsync(sql, KEY, { period: "day" }, null, NOW), "forbidden");
    },
  },
  {
    name: "job data, creator and permissions retain the snapshot across concurrent edits",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [
            { sql: "UPDATE users SET role = 'contributor', display_name = 'Changed' WHERE id = 1" },
            { sql: "UPDATE jobs SET done = 99 WHERE id = 1" },
          ]);
          return rows;
        },
      };
      const job = await getJobAsync(changing, MANAGER, 1);
      checkEqual([reads, job.createdBy.name, job.progress.done], [1, "Ada", 4]);
      await rejected(() => getJobAsync(sql, MANAGER, 1), "forbidden");
      checkEqual((await getJobAsync(sql, SYSTEM, 1)).progress.total, 99);
    },
  },
  {
    name: "usage aggregates UTC ranges by language and model with a separate monthly budget",
    async run(sql) {
      await seed(sql);
      const days = await getUsageAsync(
        sql,
        MANAGER,
        { period: "day", from: "2026-09-23", to: "2026-09-25" },
        130,
        NOW,
      );
      checkEqual(
        days.rows.map((row) => [
          row.period,
          row.requests,
          row.failures,
          row.inputTokens,
          row.outputTokens,
          row.thinkingTokens,
        ]),
        [
          ["2026-09-23", 0, 0, 0, 0, 0],
          ["2026-09-24", 2, 1, 30, 6, 3],
          ["2026-09-25", 1, 1, 30, 6, 3],
        ],
      );
      checkEqual(days.rows[1].byLanguage, {
        de: { requests: 1, failures: 0, inputTokens: 10, outputTokens: 2, thinkingTokens: 1 },
        fr: { requests: 1, failures: 1, inputTokens: 20, outputTokens: 4, thinkingTokens: 2 },
      });
      checkEqual(days.rows[1].byModel["model-a"], {
        requests: 2,
        failures: 1,
        inputTokens: 30,
        outputTokens: 6,
        thinkingTokens: 3,
      });
      checkEqual(days.rows[2].byLanguage, {});
      checkEqual(days.budget, { monthlyTokens: 130, usedThisMonth: 130, paused: true });
      const months = await getUsageAsync(
        sql,
        MANAGER,
        { period: "month", from: "2026-08", to: "2026-09" },
        null,
        NOW,
      );
      checkEqual(
        months.rows.map((row) => [row.period, row.requests, row.failures]),
        [
          ["2026-08", 1, 0],
          ["2026-09", 4, 2],
        ],
      );
      checkEqual(months.budget.paused, false);
    },
  },
  {
    name: "usage defaults and invalid ranges preserve their behavior",
    async run(sql) {
      const days = await getUsageAsync(sql, SYSTEM, { period: "day" }, 0, NOW);
      checkEqual(
        [days.rows.length, days.rows[0].period, days.rows[29].period, days.budget],
        [30, "2026-08-27", "2026-09-25", { monthlyTokens: 0, usedThisMonth: 0, paused: true }],
      );
      const months = await getUsageAsync(sql, SYSTEM, { period: "month" }, null, NOW);
      checkEqual(
        [months.rows.length, months.rows[0].period, months.rows[11].period],
        [12, "2025-10", "2026-09"],
      );
      await rejected(
        () => getUsageAsync(sql, SYSTEM, { period: "day", from: "2026-02-30" }, null, NOW),
        "bad_request",
      );
      await rejected(
        () =>
          getUsageAsync(
            sql,
            SYSTEM,
            { period: "day", from: "2026-09-26", to: "2026-09-25" },
            null,
            NOW,
          ),
        "bad_request",
      );
      await rejected(
        () => getUsageAsync(sql, SYSTEM, { period: "day", from: "2020-01-01" }, null, NOW),
        "bad_request",
      );
      await rejected(
        () => getUsageAsync(sql, SYSTEM, { period: "month", from: "2026-13" }, null, NOW),
        "bad_request",
      );
      await rejected(
        () => getUsageAsync(sql, SYSTEM, { period: "month", from: "1990-01" }, null, NOW),
        "bad_request",
      );
    },
  },
  {
    name: "usage aggregates and budget retain the permission snapshot across concurrent writes",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(1, [
            { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
            { sql: "UPDATE llm_requests SET input_tokens = input_tokens + 100" },
          ]);
          return rows;
        },
      };
      const usage = await getUsageAsync(
        changing,
        MANAGER,
        { period: "day", from: "2026-09-24", to: "2026-09-25" },
        131,
        NOW,
      );
      checkEqual(
        [reads, usage.rows[0].inputTokens, usage.budget.usedThisMonth, usage.budget.paused],
        [1, 30, 130, false],
      );
      await rejected(() => getUsageAsync(sql, MANAGER, { period: "day" }, null, NOW), "forbidden");
      checkEqual(
        (await getUsageAsync(sql, SYSTEM, { period: "day" }, null, NOW)).budget.usedThisMonth,
        530,
      );
    },
  },
];
