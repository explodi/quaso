// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import {
  type FetchContext,
  IDLE_AFTER_MS,
  isIdle,
  keyStartsWith,
  noteInput,
  QueryCache,
  type QueryState,
  shownData,
} from "./data.ts";

/** A fetcher whose answers the test releases one by one. */
function controlled<T>() {
  const pending: { resolve(value: T): void; reject(error: unknown): void }[] = [];
  let calls = 0;
  return {
    fetcher: () => {
      calls++;
      return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
    },
    get calls() {
      return calls;
    },
    resolve(index: number, value: T) {
      pending[index].resolve(value);
    },
    reject(index: number, error: unknown) {
      pending[index].reject(error);
    },
  };
}

test("key prefixes", () => {
  expect(keyStartsWith(["strings", "de", "a.json"], ["strings"])).toBe(true);
  expect(keyStartsWith(["strings", "de", "a.json"], ["strings", "de"])).toBe(true);
  expect(keyStartsWith(["strings", "de"], ["strings", "fr"])).toBe(false);
  expect(keyStartsWith(["strings"], ["strings", "de"])).toBe(false);
  expect(keyStartsWith(["string", 5], [])).toBe(true);
});

test("requests for the same key are shared", async () => {
  const cache = new QueryCache();
  const source = controlled<string>();
  const a = cache.fetch(["project"], source.fetcher);
  const b = cache.fetch(["project"], source.fetcher);
  expect(source.calls).toBe(1);
  expect(cache.get(["project"]).fetching).toBe(true);
  source.resolve(0, "Quaso");
  expect(await a).toBe("Quaso");
  expect(await b).toBe("Quaso");
  expect(cache.get(["project"]).data).toBe("Quaso");
  expect(cache.get(["project"]).status).toBe("success");
  expect(cache.get(["project"]).fetching).toBe(false);
});

test("the state object stays the same until it changes, and listeners hear changes", async () => {
  let now = 1000;
  const cache = new QueryCache({ now: () => now });
  let heard = 0;
  const stop = cache.subscribe(["files", "de"], () => heard++);
  const before = cache.get(["files", "de"]);
  expect(cache.get(["files", "de"])).toStrictEqual(before);
  await cache.fetch(["files", "de"], () => Promise.resolve([1, 2]));
  const after = cache.get(["files", "de"]);
  expect(after.data).toStrictEqual([1, 2]);
  expect(after.updatedAt).toBe(1000);
  expect(cache.get(["files", "de"]) === after).toBe(true);
  expect(heard).toBe(2); // fetching, then the data
  stop();
  now = 2000;
  await cache.fetch(["files", "de"], () => Promise.resolve([3]), { force: true });
  expect(heard).toBe(2);
});

test("a forced request wins over an older one", async () => {
  const cache = new QueryCache();
  const source = controlled<number>();
  const first = cache.fetch(["n"], source.fetcher);
  const second = cache.fetch(["n"], source.fetcher, { force: true });
  expect(source.calls).toBe(2);
  source.resolve(1, 2);
  await second;
  source.resolve(0, 1);
  await first;
  expect(cache.get(["n"]).data).toBe(2);
});

test("an error keeps the data we had", async () => {
  const cache = new QueryCache();
  await cache.fetch(["project"], () => Promise.resolve("old"));
  await expect(
    cache.fetch(["project"], () => Promise.reject(new Error("offline")), { force: true }),
  ).rejects.toThrow("offline");
  const state = cache.get(["project"]);
  expect(state.data).toBe("old");
  expect(state.status).toBe("error");
  expect((state.error as Error).message).toBe("offline");
});

test("ensure fetches only stale data", async () => {
  let now = 1;
  const cache = new QueryCache({ now: () => now });
  let calls = 0;
  cache.register(["activity"], () => Promise.resolve(++calls));
  cache.ensure(["activity"], 1000);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  now = 500;
  cache.ensure(["activity"], 1000);
  expect(calls).toBe(1);
  now = 1500;
  cache.ensure(["activity"], 1000);
  expect(calls).toBe(2);
});

test("invalidate refetches keys in use under the prefix, and marks the others stale", async () => {
  const cache = new QueryCache();
  let deCalls = 0;
  let frCalls = 0;
  let projectCalls = 0;
  await cache.fetch(["strings", "de"], () => Promise.resolve(++deCalls));
  await cache.fetch(["strings", "fr"], () => Promise.resolve(++frCalls));
  await cache.fetch(["project"], () => Promise.resolve(++projectCalls));
  const stop = cache.subscribe(["strings", "de"], () => {});
  await cache.invalidate(["strings"]);
  expect([deCalls, frCalls, projectCalls]).toStrictEqual([2, 1, 1]);
  expect(cache.get(["strings", "de"]).data).toBe(2);
  // Not in use: stale, fetched when next used.
  expect(cache.get(["strings", "fr"]).updatedAt).toBe(0);
  expect(cache.get(["strings", "fr"]).data).toBe(1);
  expect(cache.get(["project"]).updatedAt > 0).toBe(true);
  stop();
});

test("setData and update change data without fetching", async () => {
  const cache = new QueryCache();
  cache.setData(["list", "de"], [1, 2, 3]);
  cache.setData<number[]>(["list", "de"], (current) => [...(current ?? []), 4]);
  cache.setData(["list", "fr"], [5]);
  cache.update<number[]>(["list"], (list) => list.map((n) => n * 10));
  expect(cache.get(["list", "de"]).data).toStrictEqual([10, 20, 30, 40]);
  expect(cache.get(["list", "fr"]).data).toStrictEqual([50]);
  await Promise.resolve();
});

test("revalidateActive refetches old keys that are on screen", async () => {
  let now = 0;
  const cache = new QueryCache({ now: () => now });
  let calls = 0;
  await cache.fetch(["project"], () => Promise.resolve(++calls));
  await cache.fetch(["other"], () => Promise.resolve(0));
  const stop = cache.subscribe(["project"], () => {});
  now = 1000;
  cache.revalidateActive(5000);
  expect(calls).toBe(1);
  now = 10_000;
  cache.revalidateActive(5000);
  await Promise.resolve();
  expect(calls).toBe(2);
  stop();
});

test("unused entries are dropped above the limit, oldest first", async () => {
  let now = 0;
  const cache = new QueryCache({ now: () => now, maxEntries: 3 });
  for (const n of [1, 2, 3, 4]) {
    now = n;
    await cache.fetch(["n", n], () => Promise.resolve(n));
  }
  expect(cache.size).toBe(3);
  expect(cache.get(["n", 1]).data).toBe(undefined);
  expect(cache.get(["n", 4]).data).toBe(4);
});

test("refetches the website knows are needed bypass the HTTP cache; polls don't", async () => {
  let now = 0;
  const cache = new QueryCache({ now: () => now });
  const seen: boolean[] = [];
  const fetcher = ({ fresh }: FetchContext) => {
    seen.push(fresh);
    return Promise.resolve(seen.length);
  };
  const stop = cache.subscribe(["string", 19, "ja"], () => {});
  cache.register(["string", 19, "ja"], fetcher);
  // The first load, a poll and a revalidation on focus may take the browser's cached copy.
  cache.ensure(["string", 19, "ja"], 5_000);
  await cache.fetch(["string", 19, "ja"]);
  now = 10_000;
  cache.revalidateActive(5_000);
  await cache.fetch(["string", 19, "ja"]);
  expect(seen).toStrictEqual([false, false]);
  // The project's revision changed: invalidate() and forced refreshes must reach the server.
  await cache.invalidate(["string"]);
  await cache.fetch(["string", 19, "ja"], undefined, { force: true });
  expect(seen).toStrictEqual([false, false, true, true]);
  stop();
  // An invalidated key nobody shows is fetched fresh when it is next used, once.
  await cache.invalidate(["string"]);
  cache.ensure(["string", 19, "ja"], 5_000);
  await cache.fetch(["string", 19, "ja"]);
  now = 20_000;
  cache.ensure(["string", 19, "ja"], 5_000);
  await cache.fetch(["string", 19, "ja"]);
  expect(seen).toStrictEqual([false, false, true, true, true, false]);
});

test("a query can opt out of revalidation on focus", async () => {
  let now = 0;
  const cache = new QueryCache({ now: () => now });
  let listCalls = 0;
  let projectCalls = 0;
  const stops = [
    cache.subscribe(["strings", "de"], () => {}),
    cache.subscribe(["project"], () => {}),
  ];
  cache.register(["strings", "de"], () => Promise.resolve(++listCalls), {
    revalidateOnFocus: false,
  });
  cache.register(["project"], () => Promise.resolve(++projectCalls));
  await cache.fetch(["strings", "de"]);
  await cache.fetch(["project"]);
  now = 60_000;
  cache.revalidateActive(5_000);
  await cache.fetch(["project"]);
  expect([listCalls, projectCalls]).toStrictEqual([1, 2]);
  // It is still refreshed when told to.
  await cache.invalidate(["strings"]);
  expect(listCalls).toBe(2);
  for (const stop of stops) stop();
});

test("keepPrevious shows the previous data while loading, but not once the new key failed", () => {
  const state = (patch: Partial<QueryState<string[]>>): QueryState<string[]> => ({
    data: undefined,
    error: undefined,
    status: "pending",
    fetching: true,
    updatedAt: 0,
    ...patch,
  });
  const kept = ["unfiltered"];
  expect(shownData(state({}), kept, true)).toStrictEqual({ data: kept, previous: true });
  expect(shownData(state({}), kept, false)).toStrictEqual({ data: undefined, previous: false });
  expect(
    shownData(state({ status: "error", error: new Error("400"), fetching: false }), kept, true),
  ).toStrictEqual({ data: undefined, previous: false });
  expect(shownData(state({ data: ["new"], status: "success" }), kept, true)).toStrictEqual({
    data: ["new"],
    previous: false,
  });
  // A failed revalidation keeps the key's own data.
  expect(
    shownData(state({ data: ["own"], status: "error", error: new Error("500") }), kept, true),
  ).toStrictEqual({ data: ["own"], previous: false });
});

test("polling stops after five minutes without input, and input brings it back", () => {
  noteInput(1_000_000);
  expect(isIdle(1_000_000 + IDLE_AFTER_MS - 1)).toBe(false);
  expect(isIdle(1_000_000 + IDLE_AFTER_MS)).toBe(true);
  expect(noteInput(1_000_000 + IDLE_AFTER_MS)).toBe(true);
  expect(isIdle(1_000_000 + IDLE_AFTER_MS + 1)).toBe(false);
  expect(noteInput(1_000_000 + IDLE_AFTER_MS + 2)).toBe(false);
});
