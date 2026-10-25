// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
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
  assertEquals(cache.get(["a"]), 1);
  time.now = 500;
  assertEquals(cache.get(["a"]), undefined);
  assertEquals(cache.stats().entries, 0);
});

test("cache: a value stored without a time to live gets the default one", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  cache.set(["a"], 1);
  time.now = 59_999;
  assertEquals(cache.get(["a"]), 1);
  time.now = 60_000;
  assertEquals(cache.get(["a"]), undefined);
});

test("cache: expired entries nobody reads are swept within 30 seconds", () => {
  const time = { now: 0 };
  const cache = cacheAt(time);
  cache.set(["old"], "x", { ttlMs: 1000 });
  time.now = 30_000;
  cache.get(["other"]);
  assertEquals(cache.stats(), {
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
  assertEquals(
    [cache.get(["a"]), cache.get(["b"]), cache.get(["c"])].map((found) => found !== undefined),
    [true, false, true],
  );
  assertEquals(cache.stats().evictions, 1);
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
  assertEquals(cache.get(["live"]), value);
  assertEquals(cache.stats().evictions, 0);
});

test("cache: a value larger than a quarter of the budget isn't stored", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["big"], "x".repeat(200)); // 416 bytes estimated
  assertEquals(cache.get(["big"]), undefined);
  assertEquals(cache.stats().tooLarge, 1);
});

test("cache: setting a key again replaces it and its size", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], "x".repeat(100));
  cache.set(["a"], "y");
  assertEquals(cache.get(["a"]), "y");
  assertEquals(cache.stats().bytes, estimateBytes("y"));
});

test("cache: storing undefined forgets the key", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], 1);
  cache.set(["a"], undefined);
  assertEquals(cache.stats().entries, 0);
});

test("cache: delete and clear remove entries", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], 1);
  cache.set(["b"], 2);
  cache.delete(["a"]);
  assertEquals([cache.get(["a"]), cache.stats().entries], [undefined, 1]);
  cache.clear();
  assertEquals([cache.stats().entries, cache.stats().bytes], [0, 0]);
});

test("cache: keys whose joined parts look alike are different keys", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a:b", "c"], 1);
  assertEquals(cache.get(["a", "b:c"]), undefined);
  assertEquals(cache.get(["1"]), undefined);
  assertEquals(cache.get(["a:b", "c"]), 1);
});

test("cache: stored values are frozen, inside Maps too", () => {
  const cache = cacheAt({ now: 0 });
  const value = { list: [{ n: 1 }], byId: new Map([[1, { n: 2 }]]) };
  cache.set(["a"], value);
  assertThrows(() => value.list.push({ n: 3 }), TypeError);
  assertThrows(() => {
    value.byId.get(1)!.n = 5;
  }, TypeError);
});

test("cache: a value holding bytes can be stored", () => {
  const cache = cacheAt({ now: 0 });
  cache.set(["a"], { bytes: new Uint8Array([1, 2]) });
  assertEquals(cache.get(["a"]), { bytes: new Uint8Array([1, 2]) });
});

test("cache: remember loads once, then answers from the cache", async () => {
  const cache = cacheAt({ now: 0 });
  let loads = 0;
  const load = async () => ++loads;
  assertEquals(await cache.remember(["a"], load), 1);
  assertEquals(await cache.remember(["a"], load), 1);
  assertEquals(loads, 1);
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
  assertEquals([answers, loads], [["value", "value", "value"], 1]);
});

test("cache: a load that lands after its key was deleted isn't stored", async () => {
  const cache = cacheAt({ now: 0 });
  let finish = (_value: string) => {};
  const loading = cache.remember(["a"], () => new Promise<string>((resolve) => (finish = resolve)));
  cache.delete(["a"]);
  finish("stale");
  assertEquals(await loading, "stale");
  assertEquals(cache.get(["a"]), undefined);
});

test("cache: a load that lands after a clear isn't stored", async () => {
  const cache = cacheAt({ now: 0 });
  let finish = (_value: string) => {};
  const loading = cache.remember(["a"], () => new Promise<string>((resolve) => (finish = resolve)));
  cache.clear();
  finish("stale");
  await loading;
  assertEquals(cache.get(["a"]), undefined);
});

test("cache: a failed load isn't stored, and the next lookup loads again", async () => {
  const cache = cacheAt({ now: 0 });
  await assertRejects(() => cache.remember(["a"], () => Promise.reject(new Error("down"))));
  assertEquals(await cache.remember(["a"], async () => "value"), "value");
});

test("cache: a value too large to store is still returned, frozen", async () => {
  const cache = cacheAt({ now: 0 });
  const value = await cache.remember(["big"], async () => ({ text: "x".repeat(200) }));
  assertEquals(value.text.length, 200);
  assert(Object.isFrozen(value));
});

test("cache: an object reached twice is counted once", () => {
  const shared = { text: "x".repeat(50) };
  assertEquals(estimateBytes(shared), 180);
  assertEquals(estimateBytes([shared, shared]), 228); // 32 + (8 + 180) + (8 + 0)
});

test("cache: budgets and times to live must be positive", () => {
  assertThrows(() => new MemoryCache({ budgetBytes: 0, defaultTtlMs: 1 }), RangeError);
  assertThrows(() => new MemoryCache({ budgetBytes: 1, defaultTtlMs: 0 }), RangeError);
  assertThrows(() => cacheAt({ now: 0 }).set(["a"], 1, { ttlMs: 0 }), RangeError);
});
