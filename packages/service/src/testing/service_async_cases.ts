// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM } from "../api.ts";
import { BACKUP_FORMAT, BACKUP_VERSION, unfinishedRestoreAsync } from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { scriptedProvider } from "../jobs/testing.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { DATABASE_VERSION, MIGRATIONS } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { createAsyncService } from "../service_async.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobRunner } from "./job_runner_cases.ts";

function host() {
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
function service(sql: Sql, scheduler = host()) {
  return createAsyncService({
    sql,
    scheduler,
    secretKey: "test secret",
    clock: () => 200,
    defaultModel: "test",
    provider: createFakeTranslator(),
    llmConcurrency: 1,
  });
}
async function rejected(run: () => Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  check(error instanceof ServiceError);
  checkEqual(error.code, code);
}

export const ASYNC_SERVICE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "a fresh service migrates, creates defaults and restarts without changing the revision",
    async run(sql) {
      const tables = MIGRATIONS.flatMap((migration) =>
        [...migration.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(
          (match) => match[1],
        ),
      );
      await sql.migrate([
        { sql: "PRAGMA defer_foreign_keys = ON" },
        { sql: "DROP TABLE IF EXISTS revision_guard" },
        ...tables.reverse().map((table) => ({ sql: `DROP TABLE IF EXISTS ${table}` })),
      ]);
      const api = service(sql);
      checkEqual(await api.start(), {
        schemaVersion: { from: 0, to: DATABASE_VERSION },
        created: true,
      });
      checkEqual(await api.getHealth(ANONYMOUS, {}), {
        ok: true,
        schemaVersion: DATABASE_VERSION,
        revision: 0,
        busy: false,
        nextWakeUp: null,
      });
      checkEqual((await api.getSettings(SYSTEM, {})).settings.llm.model, "test");
      checkEqual(await service(sql).start(), {
        schemaVersion: { from: DATABASE_VERSION, to: DATABASE_VERSION },
        created: false,
      });
      checkEqual((await api.getHealth(SYSTEM, {})).revision, 0);
    },
  },
  {
    name: "upload, automatic translation, exports and history run through the composed service",
    async run(sql) {
      const scheduler = host();
      const api = service(sql, scheduler);
      await api.start();
      const result = await api.upload(SYSTEM, {
        files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
        languages: ["de"],
      });
      checkEqual(result.added, [{ file: "menu.json", key: "hello" }]);
      check(result.job !== null);
      checkEqual((await api.getHealth(ANONYMOUS, {})).nextWakeUp, 200);
      await api.alarm();
      checkEqual((await api.getJob(SYSTEM, { id: result.job.id })).status, "done");
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, null);
      const [translations, histories] = await sql.read([
        { sql: "SELECT colour FROM translations" },
        { sql: "SELECT event FROM history WHERE event = 'translation_llm'" },
      ]);
      checkEqual(translations, [{ colour: "green" }]);
      checkEqual(histories.length, 1);
      checkEqual((await api.exportFiles(SYSTEM, { languages: ["de"] })).files.length, 1);
      checkEqual(scheduler.calls.at(-1), null);
    },
  },
  {
    name: "explicit jobs schedule after commit while dry runs and cancellation stay consistent",
    async run(sql) {
      const api = service(sql);
      await api.start();
      await api.upload(SYSTEM, {
        files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
        languages: ["de"],
      });
      await api.alarm();
      const dry = await api.createJob(SYSTEM, { retranslate: true, dryRun: true });
      checkEqual(dry.job, null);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, null);
      const created = await api.createJob(SYSTEM, { retranslate: true });
      check(created.job !== null);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 200);
      checkEqual((await api.cancelJob(SYSTEM, { id: created.job.id })).status, "cancelled");
      await api.alarm();
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, null);
    },
  },
  {
    name: "health exposes an in-flight runner and both alarms await the same work",
    async run(sql) {
      await seedJobRunner(sql);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = scriptedProvider(async () => {
        enter();
        await held;
        return undefined;
      });
      const api = createAsyncService({
        sql,
        scheduler: host(),
        secretKey: "test",
        provider,
        clock: () => 200,
        defaultModel: "test",
        llmConcurrency: 1,
      });
      await api.start();
      const first = api.alarm();
      await entered;
      checkEqual((await api.getHealth(SYSTEM, {})).busy, true);
      const second = api.alarm();
      release();
      await Promise.all([first, second]);
      checkEqual(provider.requests.length, 3);
      checkEqual((await api.getHealth(SYSTEM, {})).busy, false);
    },
  },
  {
    name: "unfinished restore blocks startup defaults and jobs until finish resumes them",
    async run(sql) {
      const scheduler = host();
      const api = service(sql, scheduler);
      await api.start();
      await api.beginRestore(SYSTEM, {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        schemaVersion: DATABASE_VERSION,
      });
      await api.restoreRows(SYSTEM, {
        table: "jobs",
        rows: [
          {
            id: 1,
            status: "paused",
            priority: 2,
            source: "website",
            scope: "{}",
            actor_type: "system",
            created_at: 100,
            updated_at: 100,
          },
        ],
      });
      const restarting = service(sql, scheduler);
      const calls = scheduler.calls.length;
      await restarting.start();
      await restarting.alarm();
      checkEqual(scheduler.calls.length, calls);
      checkEqual((await unfinishedRestoreAsync(sql))?.resumable, true);
      checkEqual(
        await sql.read([{ sql: "SELECT id FROM settings" }, { sql: "SELECT status FROM jobs" }]),
        [[], [{ status: "paused" }]],
      );
      await restarting.finishRestore(SYSTEM, { counts: { jobs: 1, settings: 0 } });
      checkEqual(await unfinishedRestoreAsync(sql), null);
      checkEqual((await restarting.getHealth(SYSTEM, {})).nextWakeUp, 200);
      await restarting.alarm();
      checkEqual((await restarting.getJob(SYSTEM, { id: 1 })).status, "done");
    },
  },
  {
    name: "upload permissions are checked before planning and rechecked after conflicts",
    async run(sql) {
      const api = service(sql);
      await api.start();
      await rejected(() => api.upload(ANONYMOUS, { files: [] }), "unauthorized");
      const key = await api.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
      const actor = { type: "token" as const, tokenId: key.id, scope: "upload" as const };
      let revoke = true;
      const racing: Sql = {
        ...sql,
        async commit(revision, statements) {
          if (revoke) {
            revoke = false;
            await sql.commit(revision, [
              { sql: "UPDATE api_tokens SET revoked_at = 200 WHERE id = ?", params: [key.id] },
            ]);
          }
          return sql.commit(revision, statements);
        },
      };
      await rejected(
        () =>
          service(racing).upload(actor, {
            files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
          }),
        "forbidden",
      );
      checkEqual(await sql.read([{ sql: "SELECT id FROM uploads" }]), [[]]);
    },
  },
  {
    name: "upload records refreshed API key labels and dry runs do not arm a timer",
    async run(sql) {
      const scheduler = host();
      const api = service(sql, scheduler);
      await api.start();
      const key = await api.createApiToken(SYSTEM, { name: "CI", scope: "upload" });
      const actor = { type: "token" as const, tokenId: key.id, scope: "upload" as const };
      const request = {
        files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
        languages: ["de"],
      };
      const calls = scheduler.calls.length;
      await api.upload(actor, { ...request, dryRun: true });
      checkEqual(scheduler.calls.length, calls);
      let rename = true;
      const racing: Sql = {
        ...sql,
        async commit(revision, statements) {
          if (rename) {
            rename = false;
            await sql.commit(revision, [
              { sql: "UPDATE api_tokens SET name = 'Renamed CI' WHERE id = ?", params: [key.id] },
            ]);
          }
          return sql.commit(revision, statements);
        },
      };
      const result = await service(racing, scheduler).upload(actor, request);
      check(result.job !== null);
      checkEqual(
        await sql.read([
          { sql: "SELECT actor_type, actor_id, actor_label FROM activity WHERE type = 'upload'" },
        ]),
        [[{ actor_type: "token", actor_id: key.id, actor_label: "Renamed CI" }]],
      );
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 200);
    },
  },
];
