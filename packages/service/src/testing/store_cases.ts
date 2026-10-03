// SPDX-License-Identifier: MIT
import type { Store, StoredObject } from "../ports.ts";
import { StoreConflict } from "../store.ts";
import { check, checkEqual } from "./assert.ts";

export async function listed(store: Store, prefix = ""): Promise<StoredObject[]> {
  const rows = [];
  for await (const row of store.list(prefix)) rows.push(row);
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const STORE_CASES: { name: string; run(store: Store): Promise<void> }[] = [
  {
    name: "missing objects and empty stores have no rows",
    async run(store) {
      checkEqual(await store.read("missing"), null);
      checkEqual(await listed(store), []);
      await store.delete(["missing"]);
      await store.delete([]);
    },
  },
  {
    name: "binary and empty objects round-trip with version and byte size",
    async run(store) {
      const first = await store.write("binary", new Uint8Array([0, 255, 10, 128]));
      const empty = await store.write("empty", new Uint8Array());
      checkEqual(await store.read("binary"), new Uint8Array([0, 255, 10, 128]));
      checkEqual(await store.read("empty"), new Uint8Array());
      checkEqual(await listed(store), [
        { key: "binary", size: 4, version: first.version },
        { key: "empty", size: 0, version: empty.version },
      ]);
    },
  },
  {
    name: "writes own their bytes and reads return independent buffers",
    async run(store) {
      const bytes = new Uint8Array([9, 1, 2, 9]);
      const writing = store.write("copy", bytes.subarray(1, 3));
      bytes[1] = 99;
      await writing;
      const read = await store.read("copy");
      checkEqual(read, new Uint8Array([1, 2]));
      read![0] = 77;
      checkEqual(await store.read("copy"), new Uint8Array([1, 2]));
    },
  },
  {
    name: "absent and matching-version writes are conditional",
    async run(store) {
      const first = await store.write("cas", new Uint8Array([1]), { ifMatch: "absent" });
      const conflict = await store
        .write("cas", new Uint8Array([2]), { ifMatch: "absent" })
        .catch((error: unknown) => error);
      check(conflict instanceof StoreConflict);
      checkEqual(await store.read("cas"), new Uint8Array([1]));
      const next = await store.write("cas", new Uint8Array([2]), { ifMatch: first.version });
      check(next.version !== first.version);
      const stale = await store
        .write("cas", new Uint8Array([3]), { ifMatch: first.version })
        .catch((error: unknown) => error);
      check(stale instanceof StoreConflict);
      checkEqual(await store.read("cas"), new Uint8Array([2]));
      const missing = await store
        .write("unknown", new Uint8Array([3]), { ifMatch: next.version })
        .catch((error: unknown) => error);
      check(missing instanceof StoreConflict);
    },
  },
  {
    name: "competing conditional writes have exactly one winner",
    async run(store) {
      const first = await store.write("race", new Uint8Array([0]));
      const results = await Promise.allSettled([
        store.write("race", new Uint8Array([1]), { ifMatch: first.version }),
        store.write("race", new Uint8Array([2]), { ifMatch: first.version }),
      ]);
      checkEqual(results.filter((result) => result.status === "fulfilled").length, 1);
      const failed = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      check(failed.reason instanceof StoreConflict);
      const bytes = await store.read("race");
      check(bytes?.[0] === 1 || bytes?.[0] === 2);
    },
  },
  {
    name: "literal prefixes and overlapping keys list independently",
    async run(store) {
      await store.write("a", new Uint8Array([1]));
      await store.write("a/b", new Uint8Array([2]));
      await store.write("a-other", new Uint8Array([3]));
      checkEqual(
        (await listed(store, "a/")).map((row) => row.key),
        ["a/b"],
      );
      checkEqual(
        (await listed(store, "a")).map((row) => row.key),
        ["a", "a-other", "a/b"],
      );
    },
  },
  {
    name: "Unicode and URL punctuation are literal object keys",
    async run(store) {
      const key = "versions/日本語/../a?x=#%\\b";
      await store.write(key, new Uint8Array([7]));
      checkEqual(await store.read(key), new Uint8Array([7]));
      checkEqual(
        (await listed(store, "versions/日本語/")).map((row) => row.key),
        [key],
      );
    },
  },
  {
    name: "keys use UTF-8 byte limits without filesystem segment limits",
    async run(store) {
      const key = "é".repeat(512);
      await store.write(key, new Uint8Array([1]));
      checkEqual(await store.read(key), new Uint8Array([1]));
      const tooLong = await store
        .write(key + "é", new Uint8Array())
        .catch((error: unknown) => error);
      check(tooLong instanceof RangeError);
      const invalid = await store
        .write("\ud800", new Uint8Array())
        .catch((error: unknown) => error);
      check(invalid instanceof RangeError);
      const empty = await store.write("", new Uint8Array()).catch((error: unknown) => error);
      check(empty instanceof RangeError);
      checkEqual(
        (await listed(store)).map((row) => row.key),
        [key],
      );
    },
  },
  {
    name: "delete is idempotent and does not remove a neighboring prefix",
    async run(store) {
      await store.write("a", new Uint8Array([1]));
      await store.write("a/b", new Uint8Array([2]));
      await store.delete(["a", "a", "missing"]);
      checkEqual(await store.read("a"), null);
      checkEqual(await store.read("a/b"), new Uint8Array([2]));
      await store.delete(["a/b"]);
      checkEqual(await listed(store), []);
    },
  },
];
