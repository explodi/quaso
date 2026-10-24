// SPDX-License-Identifier: MIT
import { createMemoryStore } from "../adapters/memory_store.ts";
import { SYSTEM } from "../api.ts";
import type { Sql, Store } from "../ports.ts";
import { createPublisher } from "../publisher.ts";
import { createAsyncService } from "../service_async.ts";
import { check, checkEqual } from "./assert.ts";

async function seed(sql: Sql) {
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "test",
    clock: () => 100,
    defaultModel: "test",
  });
  await service.start();
  await service.upload(SYSTEM, {
    files: [
      { path: "nested/menu.json", repoPath: "nested/menu.json", content: '{"hello":"Hello"}' },
    ],
    languages: ["de", "fr"],
  });
  return service;
}
async function revision(sql: Sql) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  return Number(rows[0].revision);
}
async function keys(store: Store) {
  const result: string[] = [];
  for await (const object of store.list("")) result.push(object.key);
  return result;
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

export const PUBLISHER_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "initial publication records both languages and an unchanged run touches no object",
    async run(sql) {
      const api = await seed(sql);
      const memory = createMemoryStore();
      const writes: string[] = [];
      const reads: string[] = [];
      const store: Store = {
        ...memory,
        async read(key) {
          reads.push(key);
          return memory.read(key);
        },
        async write(key, bytes, options) {
          writes.push(key);
          return memory.write(key, bytes, options);
        },
      };
      const publisher = createPublisher(sql, store, { clock: () => 200, model: "test" });
      const before = await revision(sql);
      checkEqual(await publisher.publish(), { published: 2 });
      checkEqual(writes.length, 2);
      const [rows] = await sql.read([
        {
          sql: "SELECT language, file, revision, published_at, replaced_at FROM file_versions ORDER BY language",
        },
      ]);
      checkEqual(rows, [
        {
          language: "de",
          file: "nested/menu.json",
          revision: before,
          published_at: 200,
          replaced_at: null,
        },
        {
          language: "fr",
          file: "nested/menu.json",
          revision: before,
          published_at: 200,
          replaced_at: null,
        },
      ]);
      const after = await revision(sql);
      checkEqual(await publisher.publish(), { published: 0 });
      checkEqual(writes.length, 2);
      checkEqual(reads, []);
      checkEqual(await revision(sql), after);
      const [current] = await sql.read([
        { sql: "SELECT store_key FROM file_versions WHERE language = 'de'" },
      ]);
      const rendered = await api.exportFiles(SYSTEM, {});
      checkEqual(
        new TextDecoder().decode((await memory.read(String(current[0].store_key))) ?? undefined),
        rendered.files[0].content,
      );
    },
  },
  {
    name: "one edit replaces exactly one version and retains its old immutable bytes",
    async run(sql) {
      const api = await seed(sql);
      const store = createMemoryStore();
      const publisher = createPublisher(sql, store, { clock: () => 200, model: "test" });
      await publisher.publish();
      const [before] = await sql.read([
        { sql: "SELECT store_key FROM file_versions WHERE language = 'de'" },
      ]);
      const original = await store.read(before[0].store_key as string);
      await api.importTranslations(SYSTEM, {
        language: "de",
        files: [{ path: "nested/menu.json", content: '{"hello":"Hallo"}' }],
        as: "blue",
      });
      checkEqual(await publisher.publish(), { published: 1 });
      checkEqual(
        await sql.read([
          { sql: "SELECT language, published_at, replaced_at FROM file_versions ORDER BY id" },
        ]),
        [
          [
            { language: "de", published_at: 200, replaced_at: 201 },
            { language: "fr", published_at: 200, replaced_at: null },
            { language: "de", published_at: 201, replaced_at: null },
          ],
        ],
      );
      checkEqual(await store.read(before[0].store_key as string), original);
      checkEqual((await keys(store)).length, 3);
    },
  },
  {
    name: "a crash after the version object but before SQL leaves an orphan without a row",
    async run(sql) {
      await seed(sql);
      const store = createMemoryStore();
      const failing: Sql = {
        ...sql,
        async commit() {
          throw new Error("crash before row");
        },
      };
      await fails(() => createPublisher(failing, store, { clock: () => 200 }).publish());
      checkEqual(await sql.read([{ sql: "SELECT id FROM file_versions" }]), [[]]);
      checkEqual((await keys(store)).length, 2);
      checkEqual(await createPublisher(sql, store, { clock: () => 200 }).publish(), {
        published: 2,
      });
      checkEqual((await keys(store)).length, 2);
    },
  },
  {
    name: "failed version writes cannot commit history",
    async run(sql) {
      await seed(sql);
      const memory = createMemoryStore();
      const store: Store = {
        ...memory,
        async write() {
          throw new Error("store offline");
        },
      };
      await fails(() => createPublisher(sql, store).publish());
      checkEqual(await sql.read([{ sql: "SELECT id FROM file_versions" }]), [[]]);
      checkEqual(await keys(memory), []);
    },
  },
  {
    name: "a source change during object writes retries from fresh rendering and leaves only orphans",
    async run(sql) {
      const api = await seed(sql);
      const memory = createMemoryStore();
      let change = true;
      const store: Store = {
        ...memory,
        async write(key, bytes, options) {
          const result = await memory.write(key, bytes, options);
          if (change) {
            change = false;
            await api.upload(SYSTEM, {
              files: [
                {
                  path: "nested/menu.json",
                  repoPath: "nested/menu.json",
                  content: '{"hello":"New source"}',
                },
              ],
            });
          }
          return result;
        },
      };
      checkEqual(await createPublisher(sql, store, { clock: () => 200, model: "test" }).publish(), {
        published: 2,
      });
      checkEqual(await sql.read([{ sql: "SELECT COUNT(*) AS n FROM file_versions" }]), [
        [{ n: 2 }],
      ]);
      checkEqual((await keys(store)).length, 4);
    },
  },
  {
    name: "removal retires current rows while retaining history",
    async run(sql) {
      const api = await seed(sql);
      const store = createMemoryStore();
      const publisher = createPublisher(sql, store, { clock: () => 200 });
      await publisher.publish();
      await api.removeLanguage(SYSTEM, { tag: "de" });
      checkEqual(await publisher.publish(), { published: 0 });
      checkEqual(
        await sql.read([
          { sql: "SELECT language, replaced_at FROM file_versions ORDER BY language" },
        ]),
        [
          [
            { language: "de", replaced_at: 201 },
            { language: "fr", replaced_at: null },
          ],
        ],
      );
      await api.addLanguage(SYSTEM, { tag: "de" });
      checkEqual(await publisher.publish(), { published: 1 });
      checkEqual(await sql.read([{ sql: "SELECT COUNT(*) AS n FROM file_versions" }]), [
        [{ n: 3 }],
      ]);
    },
  },
  {
    name: "restored history rebuilds missing version objects without new rows",
    async run(sql) {
      await seed(sql);
      const first = createMemoryStore();
      await createPublisher(sql, first, { clock: () => 200 }).publish();
      const fresh = createMemoryStore();
      const before = await revision(sql);
      const publisher = createPublisher(sql, fresh);
      checkEqual(await publisher.restoreMissingVersions(), { restored: 2 });
      checkEqual(await keys(fresh), await keys(first));
      checkEqual(await publisher.restoreMissingVersions(), { restored: 0 });
      checkEqual(await publisher.publish(), { published: 0 });
      checkEqual(await revision(sql), before);
    },
  },
  {
    name: "overlapping publication requests share one reconciliation and expose busy state",
    async run(sql) {
      await seed(sql);
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
      const publisher = createPublisher(sql, store, { clock: () => 200 });
      const first = publisher.publish();
      await entered;
      checkEqual(publisher.busy, true);
      const second = publisher.publish();
      check(first === second);
      release();
      await Promise.all([first, second]);
      checkEqual(publisher.busy, false);
      checkEqual(await sql.read([{ sql: "SELECT COUNT(*) AS n FROM file_versions" }]), [
        [{ n: 2 }],
      ]);
    },
  },
];
