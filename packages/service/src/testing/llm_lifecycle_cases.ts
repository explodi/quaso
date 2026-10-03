// SPDX-License-Identifier: MIT
import { SYSTEM } from "../api.ts";
import { createAsyncLlm } from "../jobs/llm_async.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { BUDGET_ERROR } from "../jobs/store.ts";
import { scriptedProvider } from "../jobs/testing.ts";
import type { Scheduler, Sql } from "../ports.ts";
import { createAsyncWakeUps } from "../wakeups.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobRunner } from "./job_runner_cases.ts";
import { cancelJobAsync } from "../jobs/jobs.ts";

function scheduler() {
  const calls: (number | null)[] = [];
  return {
    calls,
    schedule(at: number) {
      calls.push(at);
    },
    cancel() {
      calls.push(null);
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function revision(sql: Sql) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'" },
  ]);
  return Number(rows[0].n);
}

export const LLM_LIFECYCLE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "busy stays true until the scheduler acknowledges the completed alarm",
    async run(sql) {
      await seedJobRunner(sql);
      const entered = deferred();
      const release = deferred();
      const host: Scheduler = {
        schedule() {},
        async cancel() {
          entered.resolve();
          await release.promise;
        },
      };
      const llm = createAsyncLlm(sql, {
        provider: createFakeTranslator(),
        scheduler: host,
        concurrency: 1,
        clock: () => 200,
        model: "test",
      });
      await llm.afterCreateJob();
      const alarm = llm.alarm();
      await entered.promise;
      checkEqual(llm.busy, true);
      checkEqual(await llm.nextWakeUp(), null);
      release.resolve();
      await alarm;
      checkEqual(llm.busy, false);
    },
  },
  {
    name: "monthly budget pauses persist their next wake-up across a new lifecycle",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      const options = {
        provider: createFakeTranslator(),
        scheduler: host,
        concurrency: 1,
        monthlyTokenBudget: 1,
        clock: () => 200,
        model: "test",
      };
      const llm = createAsyncLlm(sql, options);
      await llm.start();
      await llm.alarm();
      const month = Date.UTC(1970, 1, 1);
      checkEqual(await llm.nextWakeUp(), month);
      const restarted = createAsyncLlm(sql, options);
      await restarted.start();
      checkEqual(host.calls, [null, 200, month, month, 200]);
      await restarted.alarm();
      checkEqual(await restarted.nextWakeUp(), month);
      checkEqual(await sql.read([{ sql: "SELECT status, done FROM jobs WHERE id = 1" }]), [
        [{ status: "paused", done: 1 }],
      ]);
    },
  },
  {
    name: "wake-ups retain the earliest time and re-arm unchanged values",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      const wake = createAsyncWakeUps(sql, host);
      await wake.schedule(300);
      await wake.schedule(400);
      await wake.schedule(200);
      checkEqual(await wake.next(), 200);
      checkEqual(host.calls, [300, 300, 200]);
      await wake.cancel();
      checkEqual(await wake.next(), null);
      checkEqual(host.calls, [300, 300, 200, null]);
    },
  },
  {
    name: "scheduler failure leaves a committed wake-up and permits a later retry",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      let fail = true;
      const wake = createAsyncWakeUps(sql, {
        ...host,
        schedule(at) {
          if (fail) throw new Error("offline");
          host.schedule(at);
        },
      });
      let error: unknown;
      try {
        await wake.schedule(200);
      } catch (caught) {
        error = caught;
      }
      check(error instanceof Error && error.message === "offline");
      checkEqual(await wake.next(), 200);
      fail = false;
      await wake.schedule(300);
      checkEqual(host.calls, [200]);
    },
  },
  {
    name: "scheduler calls cannot overtake earlier committed times",
    async run(sql) {
      await seedJobRunner(sql);
      const entered = deferred();
      const release = deferred();
      const host = scheduler();
      const wake = createAsyncWakeUps(sql, {
        ...host,
        async schedule(at) {
          host.schedule(at);
          if (at === 300) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const first = wake.schedule(300);
      await entered.promise;
      const second = wake.schedule(200);
      checkEqual(host.calls, [300]);
      release.resolve();
      await Promise.all([first, second]);
      checkEqual(host.calls, [300, 200]);
      checkEqual(await wake.next(), 200);
    },
  },
  {
    name: "finishing an alarm preserves a newer wake-up and separates repeated due times",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      const wake = createAsyncWakeUps(sql, host);
      await wake.schedule(200);
      await wake.finish(200, 200, 200);
      checkEqual(await wake.next(), 201);
      await wake.finish(200, 500, 200);
      checkEqual(await wake.next(), 201);
      await cancelJobAsync(sql, SYSTEM, 1, 200);
      await wake.finish(201, null, 200);
      checkEqual(await wake.next(), null);
      checkEqual(host.calls, [200, 201, 201, null]);
    },
  },
  {
    name: "a job queued before finish prevents clearing the due wake-up",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      const wake = createAsyncWakeUps(sql, host);
      await wake.schedule(200);
      await wake.finish(200, null, 200);
      checkEqual(await wake.next(), 201);
    },
  },
  {
    name: "conflicting wake-up commits re-read and retain the earlier stored request",
    async run(sql) {
      await seedJobRunner(sql);
      let interfere = true;
      const guarded: Sql = {
        ...sql,
        async commit(at, statements) {
          if (interfere) {
            interfere = false;
            await sql.commit(at, [
              { sql: "INSERT INTO meta (key, value) VALUES ('next_alarm', '100')" },
            ]);
          }
          return sql.commit(at, statements);
        },
      };
      const host = scheduler();
      const wake = createAsyncWakeUps(guarded, host);
      await wake.schedule(200);
      checkEqual(await wake.next(), 100);
      checkEqual(host.calls, [100]);
    },
  },
  {
    name: "start restores a persisted alarm and resumes paused jobs",
    async run(sql) {
      await seedJobRunner(sql);
      await sql.commit(2, [
        { sql: "INSERT INTO meta (key, value) VALUES ('next_alarm', '300')" },
        {
          sql: "UPDATE jobs SET status = 'paused', error = ? WHERE id = 1",
          params: [BUDGET_ERROR],
        },
      ]);
      const host = scheduler();
      const llm = createAsyncLlm(sql, {
        provider: createFakeTranslator(),
        scheduler: host,
        clock: () => 200,
        model: "test",
      });
      await llm.start();
      checkEqual(host.calls, [300, 200]);
      checkEqual(await llm.nextWakeUp(), 200);
      checkEqual(await sql.read([{ sql: "SELECT status, error FROM jobs WHERE id = 1" }]), [
        [{ status: "queued", error: null }],
      ]);
      await llm.alarm();
      checkEqual(await llm.nextWakeUp(), null);
      checkEqual(llm.busy, false);
      checkEqual(host.calls, [300, 200, null]);
    },
  },
  {
    name: "overlapping alarms share one run and expose busy until scheduling completes",
    async run(sql) {
      await seedJobRunner(sql);
      const entered = deferred();
      const release = deferred();
      const provider = scriptedProvider(async () => {
        entered.resolve();
        await release.promise;
        return undefined;
      });
      const host = scheduler();
      const llm = createAsyncLlm(sql, {
        provider,
        scheduler: host,
        concurrency: 1,
        clock: () => 200,
        model: "test",
      });
      await llm.start();
      const first = llm.alarm();
      await entered.promise;
      checkEqual(llm.busy, true);
      const second = llm.alarm();
      check(first === second);
      release.resolve();
      await Promise.all([first, second]);
      checkEqual(provider.requests.length, 3);
      checkEqual(llm.busy, false);
      checkEqual(await llm.nextWakeUp(), null);
    },
  },
  {
    name: "jobs queued during a provider request receive the next alarm",
    async run(sql) {
      await seedJobRunner(sql);
      const host = scheduler();
      const provider = scriptedProvider(async (_request, index) => {
        if (index === 0)
          await sql.commit(await revision(sql), [
            {
              sql: "INSERT INTO jobs (id, status, priority, source, scope, actor_type, created_at, updated_at) VALUES (2, 'queued', 0, 'website', '{\"strings\":[1],\"languages\":[\"fr\"]}', 'system', 200, 200)",
            },
          ]);
        return undefined;
      });
      const llm = createAsyncLlm(sql, {
        provider,
        scheduler: host,
        concurrency: 1,
        clock: () => 200,
        model: "test",
      });
      await llm.start();
      await llm.alarm();
      checkEqual(await llm.nextWakeUp(), 201);
      await llm.alarm();
      checkEqual(await llm.nextWakeUp(), null);
      checkEqual(provider.requests.length, 4);
    },
  },
  {
    name: "failed alarm reads retain the due time and release the busy state for retry",
    async run(sql) {
      await seedJobRunner(sql);
      let fail = false;
      const guarded: Sql = {
        ...sql,
        read(statements) {
          if (fail) throw new Error("database offline");
          return sql.read(statements);
        },
      };
      const host = scheduler();
      const llm = createAsyncLlm(guarded, {
        provider: createFakeTranslator(),
        scheduler: host,
        concurrency: 1,
        clock: () => 200,
        model: "test",
      });
      await llm.start();
      fail = true;
      let error: unknown;
      try {
        await llm.alarm();
      } catch (caught) {
        error = caught;
      }
      check(error instanceof Error && error.message === "database offline");
      checkEqual(llm.busy, false);
      fail = false;
      checkEqual(await llm.nextWakeUp(), 200);
      await llm.alarm();
      checkEqual(await llm.nextWakeUp(), null);
    },
  },
  {
    name: "upload scheduling failures are logged while job-creation scheduling failures propagate",
    async run(sql) {
      await seedJobRunner(sql);
      const errors: string[] = [];
      const host: Scheduler = {
        schedule() {
          throw new Error("offline");
        },
        cancel() {},
      };
      const llm = createAsyncLlm(sql, {
        provider: null,
        scheduler: host,
        clock: () => 200,
        logger: {
          debug() {},
          info() {},
          warn() {},
          error(message) {
            errors.push(message);
          },
        },
      });
      await llm.afterUpload(null);
      checkEqual(await llm.nextWakeUp(), null);
      await llm.afterUpload({ id: 1 });
      checkEqual(errors, ["Couldn't arm the wake-up for an upload's job"]);
      checkEqual(await llm.nextWakeUp(), 200);
      let error: unknown;
      try {
        await llm.afterCreateJob();
      } catch (caught) {
        error = caught;
      }
      check(error instanceof Error && error.message === "offline");
    },
  },
];
