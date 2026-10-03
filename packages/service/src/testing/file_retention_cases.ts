// SPDX-License-Identifier: MIT
import { createMemoryStore } from "../adapters/memory_store.ts";
import { SYSTEM } from "../api.ts";
import { DAY_MS } from "../file_retention.ts";
import type { Sql, Store } from "../ports.ts";
import { createPublisher } from "../publisher.ts";
import { createAsyncService } from "../service_async.ts";
import { RevisionConflict } from "../write.ts";
import { check, checkEqual } from "./assert.ts";

const NOW = 200 * DAY_MS;
const BYTES = new Uint8Array([1]);
function key(at: number, name = "menu.json") {
  return `versions/de/${name}/${new Date(at).toISOString().replace(/[-:.]/g, "")}-12345678`;
}
async function add(sql: Sql, store: Store, id: number, published: number, replaced: number | null) {
  const storeKey = key(published, `${id}.json`);
  await store.write(storeKey, BYTES);
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  await sql.commit(Number(rows[0]?.revision ?? 0), [
    {
      sql: "INSERT INTO file_versions (id, language, file, sha256, size, store_key, revision, published_at, replaced_at) VALUES (?, 'de', ?, '12345678', 1, ?, 0, ?, ?)",
      params: [id, `${id}.json`, storeKey, published, replaced],
    },
  ]);
  return storeKey;
}
async function ids(sql: Sql) {
  const [rows] = await sql.read([{ sql: "SELECT id FROM file_versions ORDER BY id" }]);
  return rows.map((row) => Number(row.id));
}
async function fails(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  check(error instanceof Error);
}

export const FILE_RETENTION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "sweeps reread saved retention without restarting and always retain current files",
    async run(sql) {
      const api = createAsyncService({
        sql,
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "test",
      });
      await api.start();
      const store = createMemoryStore();
      await add(sql, store, 1, 0, NOW - 10 * DAY_MS);
      await add(sql, store, 2, 0, NOW - 1);
      await add(sql, store, 3, 0, null);
      const publisher = createPublisher(sql, store, { clock: () => NOW });
      checkEqual(await publisher.sweep(), { expired: 0, orphans: 0 });
      await api.updateSettings(SYSTEM, { fileHistoryDays: 7 });
      checkEqual(await publisher.sweep(), { expired: 1, orphans: 0 });
      checkEqual(await ids(sql), [2, 3]);
      await api.updateSettings(SYSTEM, { fileHistoryDays: 0 });
      checkEqual(await publisher.sweep(), { expired: 1, orphans: 0 });
      checkEqual(await ids(sql), [3]);
    },
  },
  {
    name: "publishing after every old row expires does not reuse a version ID",
    async run(sql) {
      const api = createAsyncService({
        sql,
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "test",
      });
      await api.start();
      const request = {
        files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
        languages: ["de"],
      };
      await api.upload(SYSTEM, request);
      const store = createMemoryStore();
      let now = 0;
      const publisher = createPublisher(sql, store, { clock: () => now });
      await publisher.publish();
      checkEqual(await ids(sql), [1]);
      await api.removeLanguage(SYSTEM, { tag: "de" });
      await publisher.publish();
      now = NOW;
      await publisher.sweep();
      checkEqual(await ids(sql), []);
      await api.upload(SYSTEM, request);
      await publisher.publish();
      checkEqual(await ids(sql), [2]);
    },
  },
  {
    name: "sweeps wait for publication and overlapping callers share the same sweep",
    async run(sql) {
      const api = createAsyncService({
        sql,
        scheduler: { schedule() {}, cancel() {} },
        secretKey: "test",
      });
      await api.start();
      await api.upload(SYSTEM, {
        files: [{ path: "menu.json", repoPath: "menu.json", content: '{"hello":"Hello"}' }],
        languages: ["de"],
      });
      const memory = createMemoryStore();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let listed = false;
      const store: Store = {
        ...memory,
        async write(key, bytes, options) {
          const result = await memory.write(key, bytes, options);
          if (key.startsWith("versions/")) {
            enter();
            await held;
          }
          return result;
        },
        async *list(prefix) {
          listed = true;
          yield* memory.list(prefix);
        },
      };
      let now = 0;
      const publisher = createPublisher(sql, store, { clock: () => now });
      const publishing = publisher.publish();
      await entered;
      now = NOW;
      const sweeping = publisher.sweep();
      checkEqual(sweeping, publisher.sweep());
      checkEqual(listed, false);
      checkEqual(publisher.busy, true);
      release();
      await publishing;
      checkEqual(await sweeping, { expired: 0, orphans: 0 });
      checkEqual(await ids(sql), [1]);
      checkEqual(publisher.busy, false);
    },
  },
  {
    name: "expiry uses replacement time and preserves current versions and the exact boundary",
    async run(sql) {
      const store = createMemoryStore();
      const expired = await add(sql, store, 1, 0, NOW - 90 * DAY_MS - 1);
      const boundary = await add(sql, store, 2, 0, NOW - 90 * DAY_MS);
      const recent = await add(sql, store, 3, 0, NOW - DAY_MS);
      const current = await add(sql, store, 4, 0, null);
      const latest = "published/de/menu.json";
      await store.write(latest, BYTES);
      checkEqual(await createPublisher(sql, store, { clock: () => NOW }).sweep(), {
        expired: 1,
        orphans: 0,
      });
      checkEqual(await ids(sql), [2, 3, 4]);
      checkEqual(await store.read(expired), null);
      checkEqual(await store.read(boundary), BYTES);
      checkEqual(await store.read(recent), BYTES);
      checkEqual(await store.read(current), BYTES);
      checkEqual(await store.read(latest), BYTES);
    },
  },
  {
    name: "zero days retains the current version and rejects invalid retention",
    async run(sql) {
      const store = createMemoryStore();
      await add(sql, store, 1, 0, NOW - 1);
      const current = await add(sql, store, 2, 0, null);
      const publisher = createPublisher(sql, store, { clock: () => NOW });
      await fails(() => publisher.sweep(-1));
      await fails(() => publisher.sweep(1.5));
      checkEqual(await ids(sql), [1, 2]);
      checkEqual(await publisher.sweep(0), { expired: 1, orphans: 0 });
      checkEqual(await store.read(current), BYTES);
    },
  },
  {
    name: "only unreferenced version objects older than a day are swept",
    async run(sql) {
      const store = createMemoryStore();
      const referenced = await add(sql, store, 1, 0, null);
      const old = key(NOW - DAY_MS - 1);
      const boundary = key(NOW - DAY_MS);
      const fresh = key(NOW - 1);
      const unknown = "versions/de/odd/unknown";
      const invalid = "versions/de/odd/19700230T000000000Z-12345678";
      const backup = "backups/old.json";
      await store.write(old, BYTES);
      await store.write(boundary, BYTES);
      await store.write(fresh, BYTES);
      await store.write(unknown, BYTES);
      await store.write(invalid, BYTES);
      await store.write(backup, BYTES);
      const publisher = createPublisher(sql, store, { clock: () => NOW });
      checkEqual(await publisher.sweep(), { expired: 0, orphans: 1 });
      checkEqual(await store.read(old), null);
      checkEqual(await store.read(referenced), BYTES);
      checkEqual(await store.read(boundary), BYTES);
      checkEqual(await store.read(fresh), BYTES);
      checkEqual(await store.read(unknown), BYTES);
      checkEqual(await store.read(invalid), BYTES);
      checkEqual(await store.read(backup), BYTES);
      checkEqual(await publisher.sweep(), { expired: 0, orphans: 0 });
    },
  },
  {
    name: "a failed row deletion leaves its object and a retry re-reads conflicts",
    async run(sql) {
      const store = createMemoryStore();
      const expired = await add(sql, store, 1, 0, NOW - 91 * DAY_MS);
      let conflict = true;
      const guarded: Sql = {
        ...sql,
        async commit(revision, statements) {
          if (conflict) {
            conflict = false;
            throw new RevisionConflict();
          }
          return sql.commit(revision, statements);
        },
      };
      const failing: Sql = {
        ...sql,
        async commit() {
          throw new Error("offline");
        },
      };
      await fails(() => createPublisher(failing, store, { clock: () => NOW }).sweep());
      checkEqual(await ids(sql), [1]);
      checkEqual(await store.read(expired), BYTES);
      checkEqual(await createPublisher(guarded, store, { clock: () => NOW }).sweep(), {
        expired: 1,
        orphans: 0,
      });
    },
  },
  {
    name: "object deletion happens after row commit and a failed deletion is recovered as an orphan",
    async run(sql) {
      const memory = createMemoryStore();
      const expired = await add(sql, memory, 1, 0, NOW - 91 * DAY_MS);
      let fail = true;
      const store: Store = {
        ...memory,
        async delete(keys) {
          checkEqual(await ids(sql), []);
          if (fail) {
            fail = false;
            throw new Error("offline");
          }
          return memory.delete(keys);
        },
      };
      const publisher = createPublisher(sql, store, { clock: () => NOW });
      await fails(() => publisher.sweep());
      checkEqual(await ids(sql), []);
      checkEqual(await memory.read(expired), BYTES);
      checkEqual(publisher.busy, false);
      checkEqual(await publisher.sweep(), { expired: 0, orphans: 1 });
      checkEqual(await memory.read(expired), null);
    },
  },
];
