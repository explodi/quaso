// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { createMemoryStore } from "../adapters/memory_store.ts";
import { ServiceError } from "../errors.ts";
import type { Sql, Store } from "../ports.ts";
import { createAsyncService, type AsyncServiceOptions } from "../service_async.ts";
import { checkEqual } from "./assert.ts";

const FILE = "menus/main.json";
const OLD = '{"hello":"Hello"}\n';
const NEW = '{"hello":"Hallo"}\n';
const START = Date.UTC(2026, 9, 2);
async function setup(sql: Sql, store: Store = createMemoryStore()) {
  const time = { now: START };
  const options: AsyncServiceOptions = {
    sql,
    store,
    scheduler: { schedule() {}, cancel() {} },
    clock: () => time.now,
    secretKey: "test",
  };
  const api = createAsyncService(options);
  await api.start();
  await api.upload(SYSTEM, {
    files: [{ path: FILE, repoPath: FILE, content: OLD }],
    languages: ["de"],
  });
  time.now += 5000;
  await api.alarm();
  const firstAt = time.now;
  await api.importTranslations(SYSTEM, {
    language: "de",
    files: [{ path: FILE, content: NEW }],
    as: "blue",
  });
  time.now += 5000;
  await api.alarm();
  return { api, options, store, time, firstAt, secondAt: time.now };
}
async function errorCode(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error instanceof ServiceError ? error.code : "unexpected";
  }
  return null;
}

export const FILE_READ_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "history lists newest first without exposing private store keys and returns immutable content",
    async run(sql) {
      const { api, firstAt, secondAt } = await setup(sql);
      const { versions } = await api.getFileVersions(SYSTEM, { file: FILE, language: "DE" });
      checkEqual(
        versions.map((row) => [row.id, row.publishedAt, row.replacedAt]),
        [
          [2, secondAt, null],
          [1, firstAt, secondAt],
        ],
      );
      checkEqual("store_key" in versions[0], false);
      checkEqual((await api.getFileVersion(SYSTEM, { file: FILE, id: 1 })).content, OLD);
      checkEqual(
        (await api.getPublishedFile(ANONYMOUS, { file: FILE, language: "de" })).content,
        NEW,
      );
      checkEqual(
        await errorCode(() => api.getFileVersion(SYSTEM, { file: "wrong.json", id: 1 })),
        "not_found",
      );
    },
  },
  {
    name: "historical exports include the exact publication and replacement boundaries",
    async run(sql) {
      const { api, firstAt, secondAt } = await setup(sql);
      const at = (time: number) => ({ at: new Date(time).toISOString() });
      checkEqual((await api.exportFiles(SYSTEM, at(firstAt - 1))).files, []);
      checkEqual((await api.exportFiles(SYSTEM, at(firstAt))).files[0].content, OLD);
      checkEqual((await api.exportFiles(SYSTEM, at(secondAt - 1))).files[0].content, OLD);
      checkEqual((await api.exportFiles(SYSTEM, at(secondAt))).files[0].content, NEW);
      checkEqual(
        (await api.exportFiles(SYSTEM, { ...at(firstAt), languages: ["DE"], files: [FILE] }))
          .files[0].content,
        OLD,
      );
      checkEqual((await api.exportFiles(SYSTEM, { ...at(firstAt), files: [] })).files, []);
    },
  },
  {
    name: "removed languages retire published downloads but keep historical bytes",
    async run(sql) {
      const { api, time, secondAt } = await setup(sql);
      await api.removeLanguage(SYSTEM, { tag: "de" });
      time.now += 5000;
      await api.alarm();
      checkEqual(
        await errorCode(() => api.getPublishedFile(SYSTEM, { file: FILE, language: "de" })),
        "not_found",
      );
      checkEqual(
        (await api.exportFiles(SYSTEM, { at: new Date(secondAt).toISOString() })).files[0].content,
        NEW,
      );
      checkEqual((await api.getFileVersion(SYSTEM, { file: FILE, id: 2 })).content, NEW);
      checkEqual(
        (await api.exportFiles(SYSTEM, { at: new Date(time.now).toISOString() })).files,
        [],
      );
    },
  },
  {
    name: "missing objects are expired and corrupt objects never become downloads",
    async run(sql) {
      const { api, store, firstAt } = await setup(sql);
      const [rows] = await sql.read([{ sql: "SELECT store_key FROM file_versions ORDER BY id" }]);
      await store.delete([String(rows[0].store_key)]);
      checkEqual(
        await errorCode(() => api.getFileVersion(SYSTEM, { file: FILE, id: 1 })),
        "expired",
      );
      checkEqual(
        await errorCode(() => api.exportFiles(SYSTEM, { at: new Date(firstAt).toISOString() })),
        "expired",
      );
      await store.write(String(rows[1].store_key), new Uint8Array([1]));
      checkEqual(
        await errorCode(() => api.getPublishedFile(SYSTEM, { file: FILE, language: "de" })),
        "unavailable",
      );
    },
  },
  {
    name: "download permissions and validated UTC dates apply to history as well as current exports",
    async run(sql) {
      const { api } = await setup(sql);
      checkEqual(
        await errorCode(() => api.getFileVersions(ANONYMOUS, { file: FILE, language: "de" })),
        "unauthorized",
      );
      checkEqual(
        await errorCode(() => api.exportFiles(ANONYMOUS, { at: "invalid" })),
        "unauthorized",
      );
      checkEqual(
        await errorCode(() => api.exportFiles(SYSTEM, { at: "2026-02-30T00:00Z" })),
        "validation_failed",
      );
      checkEqual(
        await errorCode(() => api.exportFiles(SYSTEM, { at: "2026-10-02T00:00" })),
        "validation_failed",
      );
      checkEqual(
        await errorCode(() =>
          api.getFileVersions(SYSTEM, { file: "../menu.json", language: "de" }),
        ),
        "validation_failed",
      );
      const token = await api.createApiToken(SYSTEM, { name: "reader", scope: "read" });
      const actor: Actor = { type: "token", tokenId: token.id };
      checkEqual((await api.getFileVersion(actor, { file: FILE, id: 1 })).content, OLD);
      await api.revokeApiToken(SYSTEM, { id: token.id });
      checkEqual(
        await errorCode(() => api.getFileVersion(actor, { file: FILE, id: 1 })),
        "forbidden",
      );
    },
  },
  {
    name: "revocation during object reads is rechecked before returning bytes",
    async run(sql) {
      const { api, options, store } = await setup(sql);
      const token = await api.createApiToken(SYSTEM, { name: "reader", scope: "read" });
      const guarded: Store = {
        ...store,
        async read(key) {
          const bytes = await store.read(key);
          await api.revokeApiToken(SYSTEM, { id: token.id });
          return bytes;
        },
      };
      const reader = createAsyncService({ ...options, store: guarded });
      checkEqual(
        await errorCode(() =>
          reader.getFileVersion({ type: "token", tokenId: token.id }, { file: FILE, id: 1 }),
        ),
        "forbidden",
      );
    },
  },
];
