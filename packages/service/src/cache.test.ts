// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { estimateBytes, MemoryCache } from "./cache.ts";

const BUDGET = 1000;

function cacheAt(time: { now: number }) {
  return new MemoryCache({ budgetBytes: BUDGET, defaultTtlMs: 60_000, clock: () => time.now });
}

test("cache: a value is found until its time to live ends", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  cache.set(["a"], 1, { ttlMs: 500 });
  time.now = 499;
  expect(cache.get(["a"])).toBe(1);
  time.now = 500;
  expect(cache.get(["a"])).toBe(undefined);
  expect(cache.stats().entries).toBe(0);
});

test("cache: a value stored without a time to live gets the default one", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  cache.set(["a"], 1);
  time.now = 59_999;
  expect(cache.get(["a"])).toBe(1);
  time.now = 60_000;
  expect(cache.get(["a"])).toBe(undefined);
});

test("cache: expired entries nobody reads are swept within 30 seconds", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  cache.set(["old"], "x", { ttlMs: 1000 });
  time.now = 30_000;
  cache.get(["other"]);
  expect(cache.stats()).toStrictEqual({
    entries: 0,
    bytes: 0,
    budgetBytes: BUDGET,
    hits: 0,
    misses: 1,
    evictions: 0,
    tooLarge: 0,
  });
});

test("cache: past the budget, the least recently used entry is evicted", () => {
  const cache = cacheAt({ now: 0 });
  const value = "x".repeat(100); // 216 bytes estimated
  cache.set(["a"], value);
  cache.set(["b"], value);
  cache.set(["c"], value);
  cache.set(["d"], value);
  cache.get(["a"]);
  cache.set(["e"], value);
  expect(
    [cache.get(["a"]), cache.get(["b"]), cache.get(["c"])].map((found) => found !== undefined),
  ).toStrictEqual([true, false, true]);
  expect(cache.stats().evictions).toBe(1);
});

test("cache: past the budget, expired entries go before live ones", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  const value = "x".repeat(100);
  cache.set(["live"], value, { ttlMs: 10_000 });
  cache.set(["expiring"], value, { ttlMs: 100 });
  cache.set(["c"], value);
  cache.set(["d"], value);
  time.now = 200;
  cache.set(["e"], value);
  expect(cache.get(["live"])).toStrictEqual(value);
  expect(cache.stats().evictions).toBe(0);
});

test("cache: a value larger than a quarter of the budget isn't stored", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["big"], "x".repeat(200)); // 416 bytes estimated
  expect(cache.get(["big"])).toBe(undefined);
  expect(cache.stats().tooLarge).toBe(1);
});

test("cache: setting a key again replaces it and its size", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], "x".repeat(100));
  cache.set(["a"], "y");
  expect(cache.get(["a"])).toBe("y");
  expect(cache.stats().bytes).toStrictEqual(estimateBytes("y"));
});

test("cache: storing undefined forgets the key", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], 1);
  cache.set(["a"], undefined);
  expect(cache.stats().entries).toBe(0);
});

test("cache: delete and clear remove entries", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], 1);
  cache.set(["b"], 2);
  cache.delete(["a"]);
  expect([cache.get(["a"]), cache.stats().entries]).toStrictEqual([undefined, 1]);
  cache.clear();
  expect([cache.stats().entries, cache.stats().bytes]).toStrictEqual([0, 0]);
});

test("cache: keys whose joined parts look alike are different keys", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a:b", "c"], 1);
  expect(cache.get(["a", "b:c"])).toBe(undefined);
  expect(cache.get(["1"])).toBe(undefined);
  expect(cache.get(["a:b", "c"])).toBe(1);
});

test("cache: stored values are frozen, inside Maps too", () => {
  const cache = cacheAt({ now: 0 });
  const value = { list: [{ n: 1 }], byId: new Map([[1, { n: 2 }]]) };
  cache.set(["a"], value);
  expect(() => value.list.push({ n: 3 })).toThrow(TypeError);
  expect(() => {
    value.byId.get(1)!.n = 5;
  }).toThrow(TypeError);
});

test("cache: a value holding bytes can be stored", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], { bytes: new Uint8Array([1, 2]) });
  expect(cache.get(["a"])).toStrictEqual({ bytes: new Uint8Array([1, 2]) });
});

test("cache: remember loads once, then answers from the cache", async () => {
  const cache = cacheAt({ now: 0 });
  let loads = 0;
  const load = async () => ++loads;
  expect(await cache.remember(["a"], load)).toBe(1);
  expect(await cache.remember(["a"], load)).toBe(1);
  expect(loads).toBe(1);
});

test("cache: lookups during a load share it", async () => {
  const cache = cacheAt({ now: 0 });
  let loads = 0;
  const load = async () => {
    loads++;
    await Promise.resolve();
    return "value";
  };
  const answers = await Promise.all([
    cache.remember(["a"], load),
    cache.remember(["a"], load),
    cache.remember(["a"], load),
  ]);
  expect([answers, loads]).toStrictEqual([["value", "value", "value"], 1]);
});

test("cache: a load that lands after its key was deleted isn't stored", async () => {
  const cache = cacheAt({ now: 0 });
  let finish = (_value: string) => {};
  const loading = cache.remember(["a"], () => new Promise<string>((resolve) => (finish = resolve)));
  cache.delete(["a"]);
  finish("stale");
  expect(await loading).toBe("stale");
  expect(cache.get(["a"])).toBe(undefined);
});

test("cache: a load that lands after a clear isn't stored", async () => {
  const cache = cacheAt({ now: 0 });
  let finish = (_value: string) => {};
  const loading = cache.remember(["a"], () => new Promise<string>((resolve) => (finish = resolve)));
  cache.clear();
  finish("stale");
  await loading;
  expect(cache.get(["a"])).toBe(undefined);
});

test("cache: a failed load isn't stored, and the next lookup loads again", async () => {
  const cache = cacheAt({ now: 0 });
  await expect(cache.remember(["a"], () => Promise.reject(new Error("down")))).rejects.toThrow();
  expect(await cache.remember(["a"], async () => "value")).toBe("value");
});

test("cache: a value too large to store is still returned, frozen", async () => {
  const cache = cacheAt({ now: 0 });
  const value = await cache.remember(["big"], async () => ({ text: "x".repeat(200) }));
  expect(value.text.length).toBe(200);
  assert(Object.isFrozen(value));
});

test("cache: an object reached twice is counted once", () => {
  const shared = { text: "x".repeat(50) };
  expect(estimateBytes(shared)).toBe(180);
  expect(estimateBytes([shared, shared])).toBe(228); // 32 + (8 + 180) + (8 + 0)
});

test("cache: budgets and times to live must be positive", () => {
  expect(() => new MemoryCache({ budgetBytes: 0, defaultTtlMs: 1 })).toThrow(RangeError);
  expect(() => new MemoryCache({ budgetBytes: 1, defaultTtlMs: 0 })).toThrow(RangeError);
  expect(() => cacheAt({ now: 0 }).set(["a"], 1, { ttlMs: 0 })).toThrow(RangeError);
});
