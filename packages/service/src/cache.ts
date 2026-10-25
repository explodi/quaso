// SPDX-License-Identifier: MIT
/**
 * A small in-memory cache in the spirit of Redis with `maxmemory` and `allkeys-lru`: values
 * live for a time to live (a default one if none is given) within a memory budget, and when the
 * budget runs out, expired entries go first, then the least recently used.
 *
 * It never decides whether a value is current: callers put what a value depends on in its key,
 * such as the project revision (`["progress", 41, "es"]`). A write raises the revision, so later
 * lookups use a new key and the old entry ages out. That holds only while what the key names
 * can't change without changing the key; the time to live bounds the damage when it does.
 *
 * Pitfalls it guards against:
 * - Unbounded growth: a byte budget, with sizes estimated when a value is stored, and a value
 *   larger than a quarter of the budget not stored at all.
 * - Keys that never expire: every entry has a time to live.
 * - Expired entries nobody reads again: a sweep runs from get and set at most every 30 seconds,
 *   with no timer that keeps the process busy.
 * - Stampedes: lookups of a key while it loads share that one load.
 * - A load that lands after its key was deleted or the cache cleared: it isn't stored.
 * - Failures: a load that throws isn't stored; the next lookup tries again.
 * - Callers mutating a shared value: values are frozen when stored.
 * - Key collisions: keys are arrays of parts, encoded so `["a:b", "c"]` and `["a", "b:c"]` differ.
 * - Clock jumps: time comes from a monotonic clock.
 */
export type CacheKey = readonly (string | number | boolean | null)[];

export interface CacheOptions {
  /** What stored values may take, estimated; past it, entries are evicted. */
  budgetBytes: number;
  /** How long a value lives when it's stored without a time to live. */
  defaultTtlMs: number;
  clock?: () => number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
  /** Entries removed because the budget ran out. */
  evictions: number;
  /** Values not stored because they're larger than a quarter of the budget. */
  tooLarge: number;
}

interface Entry {
  value: unknown;
  bytes: number;
  expiresAt: number;
}

const SWEEP_EVERY_MS = 30_000;

export class MemoryCache {
  // A Map iterates in insertion order: re-inserting on each hit keeps the least recently used first.
  #entries = new Map<string, Entry>();
  #loading = new Map<string, Promise<unknown>>();
  #bytes = 0;
  #lastSweep: number;
  #budgetBytes: number;
  #defaultTtlMs: number;
  #clock: () => number;
  #stats = { hits: 0, misses: 0, evictions: 0, tooLarge: 0 };

  constructor(options: CacheOptions) {
    if (!(options.budgetBytes > 0)) throw new RangeError("A cache's budget must be positive.");
    if (!(options.defaultTtlMs > 0)) throw new RangeError("A time to live must be positive.");
    this.#budgetBytes = options.budgetBytes;
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#clock = options.clock ?? (() => performance.now());
    this.#lastSweep = this.#clock();
  }

  get<T>(key: CacheKey): T | undefined {
    this.#sweepIfDue();
    const name = encode(key);
    const entry = this.#entries.get(name);
    if (entry === undefined || entry.expiresAt <= this.#clock()) {
      if (entry !== undefined) this.#remove(name, entry);
      this.#stats.misses++;
      return undefined;
    }
    this.#entries.delete(name);
    this.#entries.set(name, entry);
    this.#stats.hits++;
    return entry.value as T;
  }

  /** Stores `value`; undefined stores nothing and forgets the key. */
  set(key: CacheKey, value: unknown, options: { ttlMs?: number } = {}): void {
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (!(ttlMs > 0)) throw new RangeError("A time to live must be positive.");
    this.#sweepIfDue();
    const name = encode(key);
    const previous = this.#entries.get(name);
    if (previous !== undefined) this.#remove(name, previous);
    if (value === undefined) return;
    deepFreeze(value);
    const bytes = estimateBytes(value);
    if (bytes > this.#budgetBytes / 4) {
      this.#stats.tooLarge++;
      return;
    }
    this.#entries.set(name, { value, bytes, expiresAt: this.#clock() + ttlMs });
    this.#bytes += bytes;
    this.#makeRoom();
  }

  delete(key: CacheKey): void {
    const name = encode(key);
    const entry = this.#entries.get(name);
    if (entry !== undefined) this.#remove(name, entry);
    this.#loading.delete(name);
  }

  clear(): void {
    this.#entries.clear();
    this.#loading.clear();
    this.#bytes = 0;
  }

  stats(): CacheStats {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      budgetBytes: this.#budgetBytes,
      ...this.#stats,
    };
  }

  /**
   * The cached value, or `load`'s, stored for the time to live. Lookups of a key while it loads
   * share that one load.
   */
  remember<T>(key: CacheKey, load: () => Promise<T>, options: { ttlMs?: number } = {}): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const name = encode(key);
    const running = this.#loading.get(name);
    if (running !== undefined) return running as Promise<T>;
    const loading: Promise<T> = load().then(
      (value) => {
        // Deleted or cleared while loading: the value may predate that, so it isn't stored.
        const stillWanted = this.#loading.get(name) === loading;
        if (stillWanted) {
          this.#loading.delete(name);
          this.set(key, value, options);
        }
        // Frozen whether stored or not, so callers can't come to rely on mutating it.
        return deepFreeze(value);
      },
      (error) => {
        if (this.#loading.get(name) === loading) this.#loading.delete(name);
        throw error;
      },
    );
    this.#loading.set(name, loading);
    return loading;
  }

  #remove(name: string, entry: Entry) {
    this.#entries.delete(name);
    this.#bytes -= entry.bytes;
  }

  /** Over budget: expired entries go first, then the least recently used. */
  #makeRoom() {
    if (this.#bytes <= this.#budgetBytes) return;
    this.#sweep();
    for (const [name, entry] of this.#entries) {
      if (this.#bytes <= this.#budgetBytes) return;
      this.#remove(name, entry);
      this.#stats.evictions++;
    }
  }

  #sweepIfDue() {
    if (this.#clock() - this.#lastSweep >= SWEEP_EVERY_MS) this.#sweep();
  }

  #sweep() {
    const now = this.#clock();
    this.#lastSweep = now;
    for (const [name, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#remove(name, entry);
  }
}

function encode(key: CacheKey): string {
  return JSON.stringify(key);
}

/**
 * Roughly what a value takes in a JavaScript engine: 2 bytes per string character, 8 per number,
 * and an overhead per object, array and entry. An object reached twice is counted once.
 */
export function estimateBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 64 + value.byteLength;
  let bytes = 32;
  if (value instanceof Map) {
    for (const [key, child] of value)
      bytes += 16 + estimateBytes(key, seen) + estimateBytes(child, seen);
    return bytes;
  }
  if (value instanceof Set) {
    for (const child of value) bytes += 8 + estimateBytes(child, seen);
    return bytes;
  }
  for (const [key, child] of Object.entries(value))
    bytes += 8 + (Array.isArray(value) ? 0 : estimateBytes(key, seen)) + estimateBytes(child, seen);
  return bytes;
}

/** Freezes objects and arrays, and what Maps and Sets hold; a Map's own set() still works. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  // Typed arrays with elements can't be frozen.
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  let children: unknown[] = Object.values(value);
  if (value instanceof Map) children = [...value.keys(), ...value.values()];
  if (value instanceof Set) children = [...value];
  for (const child of children) deepFreeze(child);
  return value;
}
