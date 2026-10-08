// SPDX-License-Identifier: MIT
import { createMemoryStore } from "../adapters/memory_store.ts";
import { SYSTEM } from "../api.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { scriptedProvider } from "../jobs/testing.ts";
import { LLM_ALARM, PUBLISH_PENDING } from "../publication.ts";
import { DAY_MS } from "../file_retention.ts";
import { publishedKey } from "../publisher.ts";
import type { Sql, Store, Scheduler } from "../ports.ts";
import { createAsyncService, type AsyncServiceOptions } from "../service_async.ts";
import { backupJsonStream, documentSource, restoreBackup } from "../backup.ts";
import { resetUploadSql } from "./upload_cases.ts";
import { check, checkEqual } from "./assert.ts";

const FILE = { path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' };
function setup(sql: Sql, extra: Partial<AsyncServiceOptions> = {}) {
  const time = { now: 100 };
  const calls: (number | null)[] = [];
  const store = createMemoryStore();
  const scheduler = {
    schedule(at: number) {
      calls.push(at);
    },
    cancel() {
      calls.push(null);
    },
  };
  const options: AsyncServiceOptions = {
    sql,
    store,
    scheduler,
    secretKey: "test",
    clock: () => time.now,
    defaultModel: "test",
    ...extra,
  };
  return { api: createAsyncService(options), options, time, calls, store };
}
async function pending(sql: Sql) {
  const [rows] = await sql.read([
    { sql: "SELECT value FROM meta WHERE key = ?", params: [PUBLISH_PENDING] },
  ]);
  return rows.length === 0
    ? null
    : (JSON.parse(String(rows[0].value)) as {
        first: number;
        last: number;
        due: number;
        revision: number;
      });
}
async function versionCount(sql: Sql) {
  const [rows] = await sql.read([{ sql: "SELECT COUNT(*) AS n FROM file_versions" }]);
  return Number(rows[0].n);
}
async function fail(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  check(error instanceof Error);
}

export const PUBLICATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "host backup work contributes its busy state and earliest wake-up to health",
    async run(sql) {
      let busy = true;
      let next: number | null = 500;
      const { api } = setup(sql, { background: { busy: () => busy, nextWakeUp: () => next } });
      await api.start();
      const first = await api.getHealth(SYSTEM, {});
      checkEqual([first.busy, first.nextWakeUp], [true, 500]);
      busy = false;
      next = null;
      const done = await api.getHealth(SYSTEM, {});
      checkEqual([done.busy, done.nextWakeUp], [false, 100 + DAY_MS]);
    },
  },
  {
    name: "daily maintenance persists its deadline and removes aged orphans without a project write",
    async run(sql) {
      const { api, time, store } = setup(sql);
      await api.start();
      const orphan = "versions/de/menu.json/19700101T000000000Z-12345678";
      await store.write(orphan, new Uint8Array([1]));
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 100 + DAY_MS);
      time.now = DAY_MS;
      await api.alarm();
      check((await store.read(orphan)) !== null);
      time.now = 100 + DAY_MS;
      await api.alarm();
      checkEqual(await store.read(orphan), null);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 100 + 2 * DAY_MS);
    },
  },
  {
    name: "a failed LLM alarm restores its separate deadline and can retry",
    async run(sql) {
      let offline = false;
      const guardedSql: Sql = {
        ...sql,
        async read(statements) {
          const readsJobs = statements.some((statement) =>
            statement.sql.includes("status IN ('queued', 'running', 'paused')"),
          );
          if (offline && readsJobs) {
            offline = false;
            throw new Error("offline");
          }
          return sql.read(statements);
        },
      };
      const { api } = setup(guardedSql, { provider: createFakeTranslator() });
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      offline = true;
      await fail(() => api.alarm());
      const health = await api.getHealth(SYSTEM, {});
      checkEqual([health.busy, health.nextWakeUp], [false, 100]);
      await api.alarm();
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 5100);
    },
  },
  {
    name: "a long LLM request cannot hold publication past its own deadline",
    async run(sql) {
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
      const { api, time } = setup(sql, { provider, llmConcurrency: 1 });
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      const llm = api.alarm();
      await entered;
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 5100);
      time.now = 5100;
      await api.alarm();
      checkEqual(await versionCount(sql), 1);
      checkEqual((await api.getHealth(SYSTEM, {})).busy, true);
      release();
      await llm;
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 10100);
    },
  },
  {
    name: "restoring a published project rebuilds its objects and preserves history without duplicate versions",
    async run(sql) {
      const source = setup(sql);
      await source.api.start();
      await source.api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      source.time.now = 5100;
      await source.api.alarm();
      const content = await source.store.read(publishedKey("de", FILE.path));
      const document = await new Response(backupJsonStream(source.api, SYSTEM)).json();
      await resetUploadSql(sql);
      const target = setup(sql);
      await target.api.start();
      await restoreBackup(target.api, documentSource(document), SYSTEM);
      checkEqual(await versionCount(sql), 1);
      checkEqual(await target.store.read(publishedKey("de", FILE.path)), content);
      checkEqual(await pending(sql), null);
    },
  },
  {
    name: "four LLM workers can commit guarded results and publication deadlines on one service",
    async run(sql) {
      const { api, time } = setup(sql, { provider: createFakeTranslator(), llmConcurrency: 4 });
      await api.start();
      await api.updateSettings(SYSTEM, { llm: { batchSize: 1, context: { fileContext: false } } });
      const upload = await api.upload(SYSTEM, {
        files: [{ ...FILE, content: '{"one":"One","two":"Two","three":"Three","four":"Four"}' }],
        languages: ["de", "fr"],
      });
      check(upload.job !== null);
      await api.alarm();
      const job = await api.getJob(SYSTEM, { id: upload.job.id });
      checkEqual(job.error, null);
      checkEqual([job.status, job.progress.done, job.progress.translated], ["done", 8, 8]);
      time.now = 5100;
      await api.alarm();
      checkEqual(await versionCount(sql), 2);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 100 + DAY_MS);
    },
  },
  {
    name: "uploads persist a five-second debounce and early alarms leave it pending",
    async run(sql) {
      const { api, time, store } = setup(sql);
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      checkEqual((await pending(sql))?.due, 5100);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 5100);
      time.now = 5099;
      await api.alarm();
      checkEqual(await versionCount(sql), 0);
      time.now = 5100;
      await api.alarm();
      checkEqual(await versionCount(sql), 1);
      checkEqual(await pending(sql), null);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 100 + DAY_MS);
      check((await store.read(publishedKey("de", FILE.path))) !== null);
    },
  },
  {
    name: "bursts move the quiet deadline while the first write caps the wait at one minute",
    async run(sql) {
      const { api, time } = setup(sql);
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      time.now = 4100;
      await api.upload(SYSTEM, { files: [{ ...FILE, content: '{"hello":"Second"}' }] });
      checkEqual([(await pending(sql))?.first, (await pending(sql))?.due], [100, 9100]);
      time.now = 59100;
      await api.upload(SYSTEM, { files: [{ ...FILE, content: '{"hello":"Third"}' }] });
      checkEqual((await pending(sql))?.due, 60100);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 60100);
      time.now = 60100;
      await api.alarm();
      checkEqual(await versionCount(sql), 1);
      checkEqual(await pending(sql), null);
    },
  },
  {
    name: "unchanged uploads and unrelated key writes do not mark downloads dirty",
    async run(sql) {
      const { api, time, calls } = setup(sql);
      await api.start();
      const request = { files: [FILE], languages: ["de"] };
      await api.upload(SYSTEM, request);
      time.now = 5100;
      await api.alarm();
      const armed = calls.length;
      await api.upload(SYSTEM, request);
      await api.createApiToken(SYSTEM, { name: "CI", scope: "read" });
      checkEqual(await pending(sql), null);
      checkEqual(calls.length, armed);
      checkEqual(await versionCount(sql), 1);
    },
  },
  {
    name: "translation edits publish a new version and language removal retires the old latest copy",
    async run(sql) {
      const { api, time, store } = setup(sql);
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      time.now = 5100;
      await api.alarm();
      await api.importTranslations(SYSTEM, {
        language: "de",
        files: [{ path: FILE.path, content: '{"hello":"Hallo"}' }],
        as: "blue",
      });
      checkEqual((await pending(sql))?.due, 10100);
      time.now = 10100;
      await api.alarm();
      checkEqual(await versionCount(sql), 2);
      await api.removeLanguage(SYSTEM, { tag: "de" });
      time.now = 15100;
      await api.alarm();
      checkEqual(await store.read(publishedKey("de", FILE.path)), null);
      checkEqual(await versionCount(sql), 2);
    },
  },
  {
    name: "a restart publishes immediately from persisted dirty state without waiting for the old deadline",
    async run(sql) {
      const first = setup(sql);
      await first.api.start();
      await first.api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      const restarted = createAsyncService(first.options);
      await restarted.start();
      checkEqual(await versionCount(sql), 1);
      checkEqual(await pending(sql), null);
      checkEqual((await restarted.getHealth(SYSTEM, {})).nextWakeUp, 100 + DAY_MS);
    },
  },
  {
    name: "publication alarms cannot run an LLM job before its separate deadline",
    async run(sql) {
      const provider = scriptedProvider();
      const { api, time, store } = setup(sql, { provider, llmConcurrency: 1 });
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      const [revision] = await sql.read([
        { sql: "SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'" },
      ]);
      await sql.commit(Number(revision[0].n), [
        { sql: "UPDATE meta SET value = '20100' WHERE key = ?", params: [LLM_ALARM] },
      ]);
      time.now = 5100;
      await api.alarm();
      checkEqual(provider.requests.length, 0);
      check((await store.read(publishedKey("de", FILE.path))) !== null);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 20100);
      time.now = 20100;
      await api.alarm();
      checkEqual(provider.requests.length, 1);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 25100);
    },
  },
  {
    name: "budget-paused LLM work keeps its monthly alarm while partial files publish sooner",
    async run(sql) {
      const provider = scriptedProvider();
      const { api, time } = setup(sql, { provider, llmConcurrency: 1, monthlyTokenBudget: 1 });
      await api.start();
      await api.updateSettings(SYSTEM, { llm: { batchSize: 1, context: { fileContext: false } } });
      await api.upload(SYSTEM, {
        files: [{ ...FILE, content: '{"one":"One","two":"Two"}' }],
        languages: ["de"],
      });
      await api.alarm();
      checkEqual(provider.requests.length, 1);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 5100);
      time.now = 5100;
      await api.alarm();
      checkEqual(provider.requests.length, 1);
      checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, 100 + DAY_MS);
      checkEqual(await versionCount(sql), 1);
    },
  },
  {
    name: "a failed data commit rolls back its publication marker together with its files",
    async run(sql) {
      let broken = false;
      const bad: Sql = {
        ...sql,
        commit(revision, statements) {
          if (!broken) return sql.commit(revision, statements);
          return sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_table VALUES (1)" },
          ]);
        },
      };
      const { api } = setup(bad);
      await api.start();
      broken = true;
      await fail(() => api.upload(SYSTEM, { files: [FILE], languages: ["de"] }));
      checkEqual(await pending(sql), null);
      checkEqual(await sql.read([{ sql: "SELECT id FROM files" }]), [[]]);
    },
  },
  {
    name: "failed timer arming leaves the successful upload and dirty deadline recoverable",
    async run(sql) {
      const errors: string[] = [];
      let offline = false;
      const scheduler: Scheduler = {
        schedule() {
          if (offline) throw new Error("timer offline");
        },
        cancel() {},
      };
      const first = setup(sql, {
        scheduler,
        logger: {
          debug() {},
          info() {},
          warn() {},
          error(message) {
            errors.push(message);
          },
        },
      });
      await first.api.start();
      offline = true;
      await first.api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      checkEqual(errors, ["Couldn't arm publication; its deadline remains stored"]);
      checkEqual((await pending(sql))?.due, 5100);
      const restarted = createAsyncService({
        ...first.options,
        scheduler: { schedule() {}, cancel() {} },
      });
      await restarted.start();
      checkEqual(await versionCount(sql), 1);
      checkEqual(await pending(sql), null);
    },
  },
  {
    name: "writes during publication remain pending for a later debounce even after reconciliation",
    async run(sql) {
      const memory = createMemoryStore();
      let change = true;
      const store: Store = {
        ...memory,
        async write(key, bytes, options) {
          const result = await memory.write(key, bytes, options);
          if (change) {
            change = false;
            await api.upload(SYSTEM, { files: [{ ...FILE, content: '{"hello":"Latest"}' }] });
          }
          return result;
        },
      };
      const setupResult = setup(sql, { store });
      const api = setupResult.api;
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      setupResult.time.now = 5100;
      await api.alarm();
      checkEqual((await pending(sql))?.due, 10100);
      setupResult.time.now = 10100;
      await api.alarm();
      checkEqual(await pending(sql), null);
      checkEqual(await versionCount(sql), 1);
    },
  },
  {
    name: "health stays busy through publication and private deadlines are omitted from backups",
    async run(sql) {
      const memory = createMemoryStore();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store: Store = {
        ...memory,
        async write(key, bytes, options) {
          enter();
          await held;
          return memory.write(key, bytes, options);
        },
      };
      const { api, time } = setup(sql, { store });
      await api.start();
      await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
      time.now = 5100;
      const alarm = api.alarm();
      await entered;
      checkEqual((await api.getHealth(SYSTEM, {})).busy, true);
      release();
      await alarm;
      checkEqual((await api.getHealth(SYSTEM, {})).busy, false);
      const meta = await api.backupTables(SYSTEM, { table: "meta" });
      checkEqual(
        meta.rows.map((row) => row[meta.columns.indexOf("key")]),
        ["schema_generation", "schema_version", "revision", "file_version_id"],
      );
    },
  },
];
