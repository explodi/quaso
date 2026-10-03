// SPDX-License-Identifier: MIT
import { getAdminInfoAsync, type AdminHost } from "../admin.ts";
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { backupInfoAsync } from "../backup.ts";
import { ServiceError } from "../errors.ts";
import { DATABASE_VERSION } from "../migrations.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";

const NOW = Date.UTC(2026, 8, 25);
const ADMIN: Actor = { type: "user", userId: 1 };
const HOST: AdminHost = {
  version: "1.2.3",
  setup: "cloudflare",
  startedAt: 100,
  provider: "fake",
  databaseSize: () => 12345,
};

async function seed(sql: Sql): Promise<void> {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Ada', 'administrator', 100), (2, 'Reader', 'manager', 100)",
    },
    { sql: 'INSERT INTO settings (id, data) VALUES (1, \'{"llm":{"model":"stored-model"}}\')' },
    {
      sql: 'INSERT INTO meta (key, value) VALUES (\'last_backup\', \'{"at":99,"file":"backups/test.gz"}\')',
    },
    {
      sql: `INSERT INTO jobs (status, priority, source, scope, actor_type, created_at, updated_at)
      VALUES ('queued', 2, 'website', '{}', 'system', 100, 100), ('running', 2, 'website', '{}', 'system', 100, 100), ('paused', 2, 'website', '{}', 'system', 100, 100), ('done', 2, 'website', '{}', 'system', 100, 100)`,
    },
    {
      sql: `INSERT INTO llm_requests (provider, model, outcome, error, input_tokens, output_tokens, thinking_tokens, created_at)
      VALUES ('fake', 'm', 'ok', NULL, 1000, 0, 0, ?),
        ('fake', 'm', 'partial', NULL, 10, 2, 1, ?),
        ('fake', 'm', 'failed', 'First error', 20, 4, 2, ?),
        ('fake', 'm', 'blocked', NULL, 30, 6, 3, ?)`,
      params: [Date.UTC(2026, 7, 31), NOW - 1000, NOW, NOW],
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

export const ADMIN_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "empty admin information uses runtime settings and zero operational totals",
    async run(sql) {
      checkEqual(await getAdminInfoAsync(sql, SYSTEM, HOST, "runtime-model", NOW), {
        version: "1.2.3",
        setup: "cloudflare",
        startedAt: 100,
        database: { schemaVersion: DATABASE_VERSION, sizeBytes: 12345, revision: 0 },
        recentErrors: [],
        jobs: { queued: 0, running: 0, paused: 0 },
        llm: { provider: "fake", model: "runtime-model", lastSuccessAt: null, lastError: null },
        usageThisMonth: {
          requests: 0,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
        },
        lastBackup: null,
      });
    },
  },
  {
    name: "admin information decodes jobs, stored settings, request outcomes and last backup",
    async run(sql) {
      await seed(sql);
      const info = await getAdminInfoAsync(sql, ADMIN, HOST, "runtime-model", NOW);
      checkEqual(info.jobs, { queued: 1, running: 1, paused: 1 });
      checkEqual(info.llm, {
        provider: "fake",
        model: "stored-model",
        lastSuccessAt: NOW - 1000,
        lastError: { at: NOW, message: "The request blocked" },
      });
      checkEqual(info.usageThisMonth, {
        requests: 3,
        failures: 2,
        inputTokens: 60,
        outputTokens: 12,
        thinkingTokens: 6,
      });
      checkEqual(info.lastBackup, { at: 99, file: "backups/test.gz" });
      checkEqual(info.database.revision, 1);
      await sql.commit(1, [{ sql: "UPDATE meta SET value = 'invalid' WHERE key = 'last_backup'" }]);
      checkEqual((await getAdminInfoAsync(sql, ADMIN, HOST, "test", NOW)).lastBackup, null);
    },
  },
  {
    name: "private admin data requires administrator access",
    async run(sql) {
      await seed(sql);
      await rejected(() => getAdminInfoAsync(sql, ANONYMOUS, HOST, "test", NOW), "unauthorized");
      await rejected(
        () => getAdminInfoAsync(sql, { type: "user", userId: 2 }, HOST, "test", NOW),
        "forbidden",
      );
      await rejected(
        () => getAdminInfoAsync(sql, { type: "token", tokenId: 999 }, HOST, "test", NOW),
        "forbidden",
      );
    },
  },
  {
    name: "restore warnings distinguish resumable and subsequently changed data",
    async run(sql) {
      await seed(sql);
      const manifest = await backupInfoAsync(sql, ADMIN, NOW);
      await sql.migrate([
        {
          sql: "INSERT INTO meta (key, value) VALUES ('restore', ?)",
          params: [
            JSON.stringify({
              schemaVersion: DATABASE_VERSION,
              startedAt: 123,
              state: manifest.state,
            }),
          ],
        },
      ]);
      const resumable = await getAdminInfoAsync(sql, ADMIN, HOST, "test", NOW);
      checkEqual(resumable.recentErrors[0].at, 123);
      check(resumable.recentErrors[0].message.includes("LLM jobs wait"));
      await sql.commit(1, [{ sql: "UPDATE users SET display_name = 'Changed' WHERE id = 2" }]);
      const changed = await getAdminInfoAsync(sql, ADMIN, HOST, "test", NOW);
      check(changed.recentErrors[0].message.includes("new, empty instance"));
    },
  },
  {
    name: "a demotion between planning and the final read denies access",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(1, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(() => getAdminInfoAsync(changing, ADMIN, HOST, "test", NOW), "forbidden");
      checkEqual(reads, 2);
    },
  },
  {
    name: "the final snapshot retains permissions and operational data across later edits",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 2)
            await sql.commit(1, [
              { sql: "UPDATE users SET role = 'manager' WHERE id = 1" },
              { sql: "UPDATE jobs SET status = 'done'" },
              { sql: "UPDATE llm_requests SET input_tokens = 0" },
            ]);
          return rows;
        },
      };
      const info = await getAdminInfoAsync(changing, ADMIN, HOST, "test", NOW);
      checkEqual(
        [reads, info.database.revision, info.jobs.queued, info.usageThisMonth.inputTokens],
        [2, 1, 1, 60],
      );
      await rejected(() => getAdminInfoAsync(sql, ADMIN, HOST, "test", NOW), "forbidden");
    },
  },
  {
    name: "unavailable size reporting leaves the operational snapshot usable",
    async run(sql) {
      const withoutSize: Sql = {
        ...sql,
        async read(statements) {
          if (statements[0].sql.includes("pragma_page_count"))
            throw new Error("Size reporting unavailable");
          return sql.read(statements);
        },
      };
      const info = await getAdminInfoAsync(
        withoutSize,
        SYSTEM,
        { ...HOST, databaseSize: () => NaN },
        "test",
        NOW,
      );
      checkEqual([info.database.sizeBytes, info.database.revision, info.jobs.queued], [null, 0, 0]);
    },
  },
  {
    name: "schema additions between planning and the final batch replan the admin read",
    async run(sql) {
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.migrate([{ sql: "CREATE TABLE extra_admin (id INTEGER PRIMARY KEY)" }]);
          return rows;
        },
      };
      const info = await getAdminInfoAsync(changing, SYSTEM, HOST, "test", NOW);
      checkEqual([reads, info.database.revision, info.recentErrors], [4, 0, []]);
    },
  },
  {
    name: "schemas without job tables retain zero operational totals",
    async run(sql) {
      await sql.migrate([{ sql: "DROP TABLE jobs" }, { sql: "DROP TABLE llm_requests" }]);
      const info = await getAdminInfoAsync(sql, SYSTEM, HOST, "test", NOW);
      checkEqual(info.jobs, { queued: 0, running: 0, paused: 0 });
      checkEqual(
        [info.llm.lastSuccessAt, info.llm.lastError, info.usageThisMonth.requests],
        [null, null, 0],
      );
    },
  },
];
