// SPDX-License-Identifier: MIT
import { SYSTEM, type ServiceApi } from "../api.ts";
import { documentSource, restoreBackup } from "../backup.ts";
import { DAY_MS } from "../file_retention.ts";
import { createNightlyBackups, nextNightlyBackup } from "../nightly_backups.ts";
import type { Sql, Store } from "../ports.ts";
import { createAsyncService } from "../service_async.ts";
import { backupKey, HOUR_MS } from "../stored_backups.ts";
import { check, checkEqual } from "./assert.ts";
import { resetUploadSql } from "./upload_cases.ts";

const NOW = Date.UTC(2026, 9, 3, 12);
const FILE = { path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' };
const BYTES = new Uint8Array([1]);
function setup(sql: Sql, store: Store) {
  const time = { now: NOW };
  const calls: (number | null)[] = [];
  const options = {
    clock: () => time.now,
    scheduler: {
      schedule: (at: number) => {
        calls.push(at);
      },
      cancel: () => {
        calls.push(null);
      },
    },
  };
  const api = createAsyncService({
    sql,
    store,
    secretKey: "test",
    clock: options.clock,
    scheduler: { schedule() {}, cancel() {} },
  });
  return { api, time, calls, options, backups: createNightlyBackups(api, store, options) };
}
async function document(store: Store, key: string) {
  const bytes = await store.read(key);
  check(bytes !== null);
  const gzip = new Blob([bytes.slice()]).stream();
  const text = await new Response(gzip.pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text) as { tables: Record<string, { name?: string }[]> };
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

export const NIGHTLY_BACKUP_CASES: { name: string; run(sql: Sql, store: Store): Promise<void> }[] =
  [
    {
      name: "runs at 03:00 UTC and uses the newest complete gzip file after restart",
      async run(sql, store) {
        checkEqual(nextNightlyBackup(Date.UTC(2026, 9, 3, 2, 59)), Date.UTC(2026, 9, 3, 3));
        checkEqual(nextNightlyBackup(Date.UTC(2026, 9, 3, 3)), Date.UTC(2026, 9, 4, 3));
        const { api, backups, calls, time, options } = setup(sql, store);
        await api.start();
        await backups.start();
        checkEqual(calls, [Date.UTC(2026, 9, 4, 3)]);
        await backups.alarm();
        checkEqual(await store.read(backupKey(NOW, "json.gz")), null);
        await backups.snapshot();
        await store.write(backupKey(NOW + DAY_MS, "sqlite"), BYTES);
        time.now = NOW + DAY_MS;
        const restarted = createNightlyBackups(api, store, options);
        await restarted.start();
        checkEqual(restarted.nextWakeUp, time.now + 60_000);
        time.now += 60_000;
        await restarted.alarm();
        checkEqual(restarted.nextWakeUp, Date.UTC(2026, 9, 5, 3));
      },
    },
    {
      name: "gzip JSON round-trips into an empty database and republishes the restored files",
      async run(sql, store) {
        const { api, backups } = setup(sql, store);
        await api.start();
        await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
        const original = await api.exportFiles(SYSTEM, {});
        const key = await backups.snapshot();
        checkEqual(key, "backups/quaso-20261003T120000Z.json.gz");
        const saved = await document(store, key);
        checkEqual(saved.tables.strings.length, 1);
        await store.delete(["published/de/menu.json"]);
        await resetUploadSql(sql);
        const restored = setup(sql, store).api;
        await restored.start();
        const result = await restoreBackup(restored, documentSource(saved));
        checkEqual(result.tables.strings, 1);
        checkEqual((await restored.exportFiles(SYSTEM, {})).files, original.files);
        checkEqual(
          new TextDecoder().decode((await store.read("published/de/menu.json")) ?? undefined),
          '{"hello":"Hello"}\n',
        );
      },
    },
    {
      name: "a write between chunks restarts the export and includes the new data",
      async run(sql, store) {
        const { api, options } = setup(sql, store);
        await api.start();
        await api.upload(SYSTEM, { files: [FILE], languages: ["de"] });
        let wrote = false;
        let reads = 0;
        const reader = {
          backupInfo: api.backupInfo,
          recordBackup: api.recordBackup,
          async backupTables(...args: Parameters<ServiceApi["backupTables"]>) {
            reads++;
            const chunk = await api.backupTables(...args);
            if (!wrote) {
              wrote = true;
              await api.createApiToken(SYSTEM, { name: "During backup", scope: "read" });
            }
            return chunk;
          },
        };
        const key = await createNightlyBackups(reader, store, options).snapshot();
        check(reads > 1);
        checkEqual(
          (await document(store, key)).tables.api_tokens.map((row) => row.name),
          ["During backup"],
        );
      },
    },
    {
      name: "retention preserves the boundary, every copy within the window, and other object types",
      async run(sql, store) {
        const { api, backups } = setup(sql, store);
        await api.start();
        const expired = backupKey(NOW - 30 * DAY_MS - 1000, "json.gz");
        const boundary = backupKey(NOW - 30 * DAY_MS, "json.gz");
        const recent = backupKey(NOW - 3 * DAY_MS, "json.gz");
        const sameDay = backupKey(NOW - 3 * DAY_MS + HOUR_MS, "json.gz");
        const sqlite = backupKey(NOW - 100 * DAY_MS, "sqlite");
        const invalid = "backups/quaso-20260230T030000Z.json.gz";
        await store.write(expired, BYTES);
        await store.write(boundary, BYTES);
        await store.write(recent, BYTES);
        await store.write(sameDay, BYTES);
        await store.write(sqlite, BYTES);
        await store.write(invalid, BYTES);
        await store.write("published/de/menu.json", BYTES);
        await backups.snapshot();
        checkEqual(await store.read(expired), null);
        checkEqual(await store.read(boundary), BYTES);
        checkEqual(await store.read(recent), BYTES);
        checkEqual(await store.read(sameDay), BYTES);
        checkEqual(await store.read(sqlite), BYTES);
        checkEqual(await store.read(invalid), BYTES);
        checkEqual(await store.read("published/de/menu.json"), BYTES);
      },
    },
    {
      name: "a failed store write preserves old copies and retries an hour later",
      async run(sql, store) {
        const { api, time, options } = setup(sql, store);
        await api.start();
        const old = backupKey(NOW - 31 * DAY_MS, "json.gz");
        await store.write(old, BYTES);
        let offline = true;
        const flaky: Store = {
          ...store,
          async write(...args) {
            if (offline) {
              offline = false;
              throw new Error("offline");
            }
            return store.write(...args);
          },
        };
        const backups = createNightlyBackups(api, flaky, options);
        await backups.start();
        time.now += 60_000;
        await fail(() => backups.alarm());
        checkEqual(backups.nextWakeUp, time.now + HOUR_MS);
        checkEqual(await store.read(old), BYTES);
        checkEqual(backups.busy, false);
        time.now += HOUR_MS;
        await backups.alarm();
        checkEqual(await store.read(old), null);
        checkEqual((await document(store, backupKey(time.now, "json.gz"))).tables.strings, []);
      },
    },
    {
      name: "a failed backup read publishes no object and a saved second never recaptures or overwrites",
      async run(sql, store) {
        const { api, options } = setup(sql, store);
        await api.start();
        const failing = {
          ...api,
          async backupTables(): ReturnType<ServiceApi["backupTables"]> {
            throw new Error("offline");
          },
        };
        await fail(() => createNightlyBackups(failing, store, options).snapshot());
        const key = backupKey(NOW, "json.gz");
        checkEqual(await store.read(key), null);
        await createNightlyBackups(api, store, options).snapshot();
        const saved = await store.read(key);
        await createNightlyBackups(failing, store, options).snapshot();
        checkEqual(await store.read(key), saved);
      },
    },
    {
      name: "overlapping alarms coalesce and stopping an export prevents it from rearming",
      async run(sql, store) {
        const { api, time, options, calls } = setup(sql, store);
        await api.start();
        let release!: () => void;
        let enter!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const backups = createNightlyBackups(
          {
            ...api,
            async backupTables(...args) {
              enter();
              await held;
              return api.backupTables(...args);
            },
          },
          store,
          options,
        );
        await backups.start();
        time.now = backups.nextWakeUp!;
        const alarm = backups.alarm();
        checkEqual(backups.alarm(), alarm);
        await entered;
        checkEqual(backups.busy, true);
        await backups.stop();
        release();
        await alarm;
        checkEqual(backups.busy, false);
        checkEqual(backups.nextWakeUp, null);
        checkEqual(calls, [Date.UTC(2026, 9, 4, 3), null]);
      },
    },
    {
      name: "health stays busy until the controller acknowledges the next nightly deadline",
      async run(sql, store) {
        const time = { now: NOW };
        let release!: () => void;
        let enter!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const api = createAsyncService({
          sql,
          store,
          secretKey: "test",
          clock: () => time.now,
          scheduler: { schedule() {}, cancel() {} },
          background: { busy: () => backups.busy, nextWakeUp: () => backups.nextWakeUp },
        });
        const backups = createNightlyBackups(api, store, {
          clock: () => time.now,
          scheduler: {
            async schedule() {
              if (time.now === NOW) return;
              enter();
              await held;
            },
            cancel() {},
          },
        });
        await api.start();
        await backups.start();
        checkEqual((await api.getHealth(SYSTEM, {})).nextWakeUp, Date.UTC(2026, 9, 4, 3));
        time.now = backups.nextWakeUp!;
        const alarm = backups.alarm();
        await entered;
        checkEqual((await api.getHealth(SYSTEM, {})).busy, true);
        release();
        await alarm;
        checkEqual((await api.getHealth(SYSTEM, {})).busy, false);
        checkEqual(backups.nextWakeUp, Date.UTC(2026, 9, 5, 3));
      },
    },
    {
      name: "recording and pruning failures leave the completed object for a retry without rereading",
      async run(sql, store) {
        const { api, options } = setup(sql, store);
        await api.start();
        const old = backupKey(NOW - 31 * DAY_MS, "json.gz");
        await store.write(old, BYTES);
        const failedRecord = createNightlyBackups(
          {
            ...api,
            async recordBackup() {
              throw new Error("offline");
            },
          },
          store,
          options,
        );
        await fail(() => failedRecord.snapshot());
        const key = backupKey(NOW, "json.gz");
        const saved = await store.read(key);
        check(saved !== null);
        checkEqual(await store.read(old), BYTES);
        const reader = {
          ...api,
          async backupTables(): ReturnType<ServiceApi["backupTables"]> {
            throw new Error("should not recapture");
          },
        };
        const failedPrune: Store = {
          ...store,
          async delete() {
            throw new Error("offline");
          },
        };
        await fail(() => createNightlyBackups(reader, failedPrune, options).snapshot());
        checkEqual(await store.read(key), saved);
        checkEqual(await store.read(old), BYTES);
        await createNightlyBackups(reader, store, options).snapshot();
        checkEqual(await store.read(key), saved);
        checkEqual(await store.read(old), null);
      },
    },
    {
      name: "invalid retention cannot publish or delete objects",
      async run(sql, store) {
        const { api, options } = setup(sql, store);
        await api.start();
        const old = backupKey(NOW - 31 * DAY_MS, "json.gz");
        await store.write(old, BYTES);
        await fail(() =>
          createNightlyBackups(api, store, { ...options, retentionDays: () => 0 }).snapshot(),
        );
        await fail(() =>
          createNightlyBackups(api, store, { ...options, retentionDays: () => 1.5 }).snapshot(),
        );
        checkEqual(await store.read(old), BYTES);
        checkEqual(await store.read(backupKey(NOW, "json.gz")), null);
      },
    },
  ];
