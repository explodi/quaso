// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { cancelJobAsync } from "../jobs/jobs.ts";
import { pauseActiveAsync, resumeJobsAsync } from "../jobs/runner.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const MANAGER: Actor = { type: "user", userId: 2 };
const TOKEN: Actor = { type: "token", tokenId: 7 };
async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, languages, created_at) VALUES (1, 'Admin', 'administrator', NULL, 100), (2, 'Manager', 'manager', '[\"de\"]', 100)",
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'CI', 'upload', 'hash7', 'qso_', 100), (8, 'Other', 'upload', 'hash8', 'qso_', 100)",
    },
    {
      sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, total, done, translated, failed, input_tokens, output_tokens, thinking_tokens, created_at, updated_at) VALUES (1, 'queued', 2, 'cli', '{"languages":["de"]}', 'token', 7, 10, 3, 2, 1, 100, 20, 3, 100, 100)`,
    },
    {
      sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, started_at, created_at, updated_at) VALUES (2, 'running', 2, 'website', '{"languages":["fr"]}', 'user', 1, 50, 100, 100), (3, 'paused', 2, 'website', '{}', 'system', NULL, NULL, 100, 100), (4, 'paused', 2, 'website', '{}', 'system', NULL, 50, 100, 100), (5, 'done', 2, 'website', '{}', 'system', NULL, 50, 100, 100), (6, 'failed', 2, 'website', '{}', 'system', NULL, 50, 100, 100)`,
    },
    { sql: "INSERT INTO job_items VALUES (1, 1, 'de', 'translated')" },
  ]);
}
async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}
function race(sql: Sql, update: () => Promise<void>): Sql {
  let first = true;
  return {
    ...sql,
    async read(statements) {
      const rows = await sql.read(statements);
      if (first) {
        first = false;
        await update();
      }
      return rows;
    },
  };
}
export const JOB_TRANSITION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "cancellation finishes the job, clears items and records creator activity atomically",
    async run(sql) {
      await seed(sql);
      const result = await cancelJobAsync(sql, MANAGER, 1, 200);
      checkEqual(
        [
          result.status,
          result.finishedAt,
          result.startedAt,
          result.createdBy.name,
          result.progress.translated,
        ],
        ["cancelled", 200, null, "CI", 2],
      );
      const [items, activity, revision] = await sql.read([
        { sql: "SELECT job_id FROM job_items WHERE job_id = 1" },
        { sql: "SELECT actor_type, actor_id, summary, detail FROM activity WHERE type = 'job'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(items, []);
      checkEqual(activity[0].actor_type, "token");
      checkEqual(activity[0].actor_id, 7);
      checkEqual(activity[0].summary, "Translation job 1 cancelled: 2 translated, 1 failed");
      checkEqual(JSON.parse(String(activity[0].detail)), {
        jobId: 1,
        status: "cancelled",
        translated: 2,
        proposed: 0,
        failed: 1,
        skipped: 0,
        tokens: 123,
      });
      checkEqual(revision, [{ value: "2" }]);
    },
  },
  {
    name: "repeated cancellation is a no-op with fresh metadata and no repeated log",
    async run(sql) {
      await seed(sql);
      await cancelJobAsync(sql, SYSTEM, 1, 200);
      const noCommit: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      const logs: unknown[] = [];
      const methods = asyncWriteMethods({
        sql: noCommit,
        logger: {
          debug: () => {},
          warn: () => {},
          error: () => {},
          info: (...args) => logs.push(args),
        },
      });
      checkEqual((await methods.cancelJob(SYSTEM, { id: 1 })).finishedAt, 200);
      checkEqual(logs, []);
    },
  },
  {
    name: "cancellation checks access, key ownership, language limits and terminal states",
    async run(sql) {
      await seed(sql);
      await rejected(() => cancelJobAsync(sql, ANONYMOUS, 1, 200), "unauthorized");
      await rejected(() => cancelJobAsync(sql, { type: "token", tokenId: 8 }, 1, 200), "forbidden");
      await rejected(() => cancelJobAsync(sql, TOKEN, 2, 200), "forbidden");
      await rejected(() => cancelJobAsync(sql, MANAGER, 2, 200), "forbidden");
      await rejected(() => cancelJobAsync(sql, MANAGER, 3, 200), "forbidden");
      await rejected(() => cancelJobAsync(sql, SYSTEM, 5, 200), "conflict");
      await rejected(() => cancelJobAsync(sql, SYSTEM, 6, 200), "conflict");
      await rejected(() => cancelJobAsync(sql, SYSTEM, 999, 200), "not_found");
      checkEqual((await cancelJobAsync(sql, TOKEN, 1, 200)).status, "cancelled");
    },
  },
  {
    name: "pause and resume preserve progress and running starts and skip terminal jobs",
    async run(sql) {
      await seed(sql);
      checkEqual(await pauseActiveAsync(sql, SYSTEM, "budget", 200), 2);
      checkEqual(await pauseActiveAsync(sql, SYSTEM, "budget", 250), 0);
      checkEqual(await resumeJobsAsync(sql, SYSTEM, 300), true);
      const [jobs, items] = await sql.read([
        { sql: "SELECT id, status, started_at, error FROM jobs ORDER BY id" },
        { sql: "SELECT job_id FROM job_items" },
      ]);
      checkEqual(jobs, [
        { id: 1, status: "queued", started_at: null, error: null },
        { id: 2, status: "running", started_at: 50, error: null },
        { id: 3, status: "queued", started_at: null, error: null },
        { id: 4, status: "running", started_at: 50, error: null },
        { id: 5, status: "done", started_at: 50, error: null },
        { id: 6, status: "failed", started_at: 50, error: null },
      ]);
      checkEqual(items, [{ job_id: 1 }]);
      const noCommit: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(await resumeJobsAsync(noCommit, SYSTEM, 350), true);
      await rejected(() => pauseActiveAsync(sql, MANAGER, "budget", 400), "forbidden");
      await rejected(() => resumeJobsAsync(sql, MANAGER, 400), "forbidden");
    },
  },
  {
    name: "a competing completion prevents cancellation without another activity",
    async run(sql) {
      await seed(sql);
      const raced = race(sql, () =>
        sql.commit(1, [{ sql: "UPDATE jobs SET status = 'done' WHERE id = 1" }]).then(() => {}),
      );
      await rejected(() => cancelJobAsync(raced, MANAGER, 1, 200), "conflict");
      const [activity] = await sql.read([{ sql: "SELECT id FROM activity" }]);
      checkEqual(activity, []);
    },
  },
  {
    name: "concurrent progress and actor metadata are refreshed in response and activity",
    async run(sql) {
      await seed(sql);
      const raced = race(sql, () =>
        sql
          .commit(1, [
            { sql: "UPDATE jobs SET translated = 4, done = 5, output_tokens = 30 WHERE id = 1" },
            { sql: "UPDATE api_tokens SET name = 'Renamed CI' WHERE id = 7" },
          ])
          .then(() => {}),
      );
      const result = await cancelJobAsync(raced, MANAGER, 1, 200);
      checkEqual(
        [
          result.progress.translated,
          result.progress.done,
          result.createdBy.name,
          result.tokens.output,
        ],
        [4, 5, "Renamed CI", 30],
      );
      const [activity] = await sql.read([{ sql: "SELECT detail FROM activity" }]);
      checkEqual(JSON.parse(String(activity[0].detail)).tokens, 133);
    },
  },
  {
    name: "revocation and demotion remove stale cancellation authority",
    async run(sql) {
      await seed(sql);
      const revoked = race(sql, () =>
        sql
          .commit(1, [{ sql: "UPDATE api_tokens SET revoked_at = 150 WHERE id = 7" }])
          .then(() => {}),
      );
      await rejected(() => cancelJobAsync(revoked, TOKEN, 1, 200), "forbidden");
      const demoted = race(sql, () =>
        sql
          .commit(2, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 2" }])
          .then(() => {}),
      );
      await rejected(() => cancelJobAsync(demoted, MANAGER, 1, 200), "forbidden");
    },
  },
  {
    name: "pause and resume retries preserve competing cancellation",
    async run(sql) {
      await seed(sql);
      const pausing = race(sql, () => cancelJobAsync(sql, SYSTEM, 1, 150).then(() => {}));
      checkEqual(await pauseActiveAsync(pausing, SYSTEM, "budget", 200), 1);
      const resuming = race(sql, () => cancelJobAsync(sql, SYSTEM, 3, 250).then(() => {}));
      checkEqual(await resumeJobsAsync(resuming, SYSTEM, 300), true);
      const [jobs] = await sql.read([
        { sql: "SELECT id, status FROM jobs WHERE id IN (1, 3) ORDER BY id" },
      ]);
      checkEqual(jobs, [
        { id: 1, status: "cancelled" },
        { id: 3, status: "cancelled" },
      ]);
    },
  },
  {
    name: "failed cancellation rolls back status, item cleanup, activity and revision",
    async run(sql) {
      await seed(sql);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await cancelJobAsync(broken, MANAGER, 1, 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [jobs, items, activity, revision] = await sql.read([
        { sql: "SELECT status FROM jobs WHERE id = 1" },
        { sql: "SELECT job_id FROM job_items" },
        { sql: "SELECT id FROM activity" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(jobs, [{ status: "queued" }]);
      checkEqual(items, [{ job_id: 1 }]);
      checkEqual(activity, []);
      checkEqual(revision, [{ value: "1" }]);
    },
  },
  {
    name: "validated cancellation keeps ID validation and emits counts only after commit",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const methods = asyncWriteMethods({
        sql,
        clock: () => 200,
        logger: {
          debug: () => {},
          warn: () => {},
          error: () => {},
          info: (...args) => logs.push(args),
        },
      });
      await rejected(() => methods.cancelJob(SYSTEM, { id: 0 }), "validation_failed");
      await methods.cancelJob(SYSTEM, { id: 1 });
      checkEqual(logs, [
        [
          "LLM job ended",
          { jobId: 1, status: "cancelled", translated: 2, proposed: 0, failed: 1, skipped: 0 },
        ],
        ["LLM job cancelled", { jobId: 1 }],
      ]);
    },
  },
];
