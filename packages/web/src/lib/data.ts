// SPDX-License-Identifier: MIT
/**
 * A small data-fetching module (design §5.9): `useQuery` with an in-memory cache shared by
 * the whole website, deduplicated requests, revalidation when the window gets focus again,
 * polling (`refreshInterval`: the design's "polling, not WebSockets", so job progress and
 * new translations appear), `invalidate` by key prefix, and `useMutation`.
 *
 * Keys are arrays, such as `["strings", "de", "common.json"]`; `invalidate(["strings"])`
 * refreshes every key that starts with `"strings"`.
 *
 * Fetchers get `{ fresh }`: true when the website knows the data changed (an invalidation,
 * a forced refresh), so the request must reach the server rather than the browser's HTTP
 * cache, which may hold public answers for a while (the server lets anonymous reads be
 * cached). First loads, polling and revalidation on focus may use the HTTP cache.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export type KeyPart = string | number | boolean | null | undefined;
export type QueryKey = readonly KeyPart[];

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  status: "pending" | "success" | "error";
  /** A request is running (the first one, or a revalidation). */
  fetching: boolean;
  /** When the data arrived (ms); 0 when there is none or it was invalidated. */
  updatedAt: number;
}

/** What a fetcher is told about the request it makes. */
export interface FetchContext {
  /** Bypass the browser's HTTP cache: the data is known to have changed. */
  fresh: boolean;
}

export type Fetcher<T> = (context: FetchContext) => Promise<T>;

interface Entry {
  key: QueryKey;
  state: QueryState<unknown>;
  /** The request running now. */
  promise: Promise<unknown> | undefined;
  /** Goes up with every request, so only the latest one's answer is kept. */
  generation: number;
  /** How to fetch it again, from the last `useQuery` that used the key. */
  fetcher: Fetcher<unknown> | undefined;
  /** Refetch when the window gets focus again (unless the query opted out). */
  revalidateOnFocus: boolean;
  /** Invalidated: the next request must reach the server. */
  mustRevalidate: boolean;
  listeners: Set<() => void>;
  lastUsed: number;
}

const EMPTY: QueryState<never> = Object.freeze({
  data: undefined,
  error: undefined,
  status: "pending",
  fetching: false,
  updatedAt: 0,
}) as QueryState<never>;

export function hashKey(key: QueryKey): string {
  return JSON.stringify(key);
}

/** Whether `key` starts with every part of `prefix`. */
export function keyStartsWith(key: QueryKey, prefix: QueryKey): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every((part, index) => Object.is(part, key[index]));
}

export interface QueryCacheOptions {
  now?: () => number;
  /** Entries nobody uses are dropped, oldest first, above this many. Default: 200. */
  maxEntries?: number;
}

/** The cache behind `useQuery`. The website has one; tests make their own. */
export class QueryCache {
  #entries = new Map<string, Entry>();
  #now: () => number;
  #maxEntries: number;

  constructor(options: QueryCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 200;
  }

  #entry(key: QueryKey): Entry {
    const hash = hashKey(key);
    let entry = this.#entries.get(hash);
    if (!entry) {
      entry = {
        key,
        state: EMPTY,
        promise: undefined,
        generation: 0,
        fetcher: undefined,
        revalidateOnFocus: true,
        mustRevalidate: false,
        listeners: new Set(),
        lastUsed: this.#now(),
      };
      this.#entries.set(hash, entry);
      this.#evict();
    }
    return entry;
  }

  #set(entry: Entry, patch: Partial<QueryState<unknown>>): void {
    entry.state = { ...entry.state, ...patch };
    for (const listener of [...entry.listeners]) listener();
  }

  /** Drops the least recently used entries that nobody listens to, above the limit. */
  #evict(): void {
    if (this.#entries.size <= this.#maxEntries) return;
    const idle = [...this.#entries.entries()]
      .filter(([, entry]) => entry.listeners.size === 0 && entry.promise === undefined)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [hash] of idle) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(hash);
    }
  }

  /** The key's state; the same object until it changes. */
  get<T>(key: QueryKey): QueryState<T> {
    return (this.#entries.get(hashKey(key))?.state ?? EMPTY) as QueryState<T>;
  }

  /** Calls `listener` whenever the key's state changes. Returns the unsubscribe function. */
  subscribe(key: QueryKey, listener: () => void): () => void {
    const entry = this.#entry(key);
    entry.listeners.add(listener);
    entry.lastUsed = this.#now();
    return () => {
      entry.listeners.delete(listener);
      entry.lastUsed = this.#now();
    };
  }

  /** Remembers how to fetch the key, for revalidation. */
  register(
    key: QueryKey,
    fetcher: Fetcher<unknown>,
    options: { revalidateOnFocus?: boolean } = {},
  ): void {
    const entry = this.#entry(key);
    entry.fetcher = fetcher;
    entry.revalidateOnFocus = options.revalidateOnFocus ?? true;
  }

  /**
   * Fetches the key. A request already running is shared, unless `force`, which starts a
   * new one whose answer wins, and bypasses the HTTP cache (`fresh`), as does the first
   * request after an invalidation. Rejects with the fetcher's error.
   */
  fetch<T>(key: QueryKey, fetcher?: Fetcher<T>, options: { force?: boolean } = {}): Promise<T> {
    const entry = this.#entry(key);
    if (fetcher) entry.fetcher = fetcher;
    if (entry.promise && !options.force) return entry.promise as Promise<T>;
    const run = entry.fetcher;
    if (!run) return Promise.reject(new Error(`No fetcher for ${hashKey(key)}`));
    const generation = ++entry.generation;
    const fresh = options.force === true || entry.mustRevalidate;
    const promise = (async () => {
      try {
        const data = await run({ fresh });
        if (entry.generation === generation) {
          entry.promise = undefined;
          if (fresh) entry.mustRevalidate = false;
          this.#set(entry, {
            data,
            error: undefined,
            status: "success",
            fetching: false,
            updatedAt: this.#now(),
          });
        }
        return data as T;
      } catch (error) {
        if (entry.generation === generation) {
          entry.promise = undefined;
          // Keep the data we had: a failed revalidation shouldn't blank the page.
          this.#set(entry, { error, status: "error", fetching: false });
        }
        throw error;
      }
    })();
    entry.promise = promise;
    if (!entry.state.fetching) this.#set(entry, { fetching: true });
    return promise;
  }

  /** Fetches the key unless its data is younger than `staleTime` or a request is running. */
  ensure(key: QueryKey, staleTime: number): void {
    const entry = this.#entry(key);
    if (entry.promise) return;
    const { updatedAt, status } = entry.state;
    if (status === "success" && updatedAt !== 0 && this.#now() - updatedAt < staleTime) return;
    this.fetch(key).catch(() => {});
  }

  /** Sets the key's data, or changes it with a function of the current data. */
  setData<T>(key: QueryKey, data: T | ((current: T | undefined) => T)): void {
    const entry = this.#entry(key);
    const next =
      typeof data === "function"
        ? (data as (current: T | undefined) => T)(entry.state.data as T | undefined)
        : data;
    this.#set(entry, { data: next, error: undefined, status: "success", updatedAt: this.#now() });
  }

  /** Changes the data of every key under `prefix` that has data. */
  update<T>(prefix: QueryKey, change: (current: T, key: QueryKey) => T): void {
    for (const entry of this.#entries.values()) {
      if (!keyStartsWith(entry.key, prefix) || entry.state.data === undefined) continue;
      this.#set(entry, { data: change(entry.state.data as T, entry.key) });
    }
  }

  /**
   * Marks every key under `prefix` as stale: keys in use are fetched again at once, the
   * others when they are next used. Resolves when the refetches are done.
   */
  invalidate(prefix: QueryKey = []): Promise<void> {
    const refetches: Promise<unknown>[] = [];
    for (const entry of this.#entries.values()) {
      if (!keyStartsWith(entry.key, prefix)) continue;
      entry.state = { ...entry.state, updatedAt: 0 };
      entry.mustRevalidate = true;
      if (entry.listeners.size > 0 && entry.fetcher) {
        refetches.push(this.fetch(entry.key, undefined, { force: true }).catch(() => {}));
      }
    }
    return Promise.all(refetches).then(() => {});
  }

  /**
   * Refetches the keys in use whose data is older than `minAge` (after a focus, say),
   * except those that opted out of revalidation on focus.
   */
  revalidateActive(minAge: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.listeners.size === 0 || !entry.fetcher || entry.promise) continue;
      if (!entry.revalidateOnFocus) continue;
      if (this.#now() - entry.state.updatedAt >= minAge) this.fetch(entry.key).catch(() => {});
    }
  }

  /** Forgets every key under `prefix`. */
  remove(prefix: QueryKey = []): void {
    for (const [hash, entry] of this.#entries) {
      if (keyStartsWith(entry.key, prefix) && entry.listeners.size === 0) {
        this.#entries.delete(hash);
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The website's cache. */
export const queryCache = new QueryCache();

/**
 * Revalidates what's on screen when the window gets focus again or the tab becomes
 * visible, if it's older than `minAge`. Returns a function that stops listening.
 */
export function revalidateOnFocus(cache = queryCache, minAge = 5_000): () => void {
  const onFocus = () => {
    if (document.visibilityState !== "hidden") cache.revalidateActive(minAge);
  };
  addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  return () => {
    removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
}

export interface QueryOptions {
  /** Poll every so many milliseconds while the page is visible. */
  refreshInterval?: number;
  /** Data younger than this isn't fetched again when a component mounts. Default: 10 s. */
  staleTime?: number;
  /**
   * While a new key loads, keep showing the previous key's data (search as you type). Not
   * once the new key fails: its error shows instead of data that doesn't match it.
   */
  keepPrevious?: boolean;
  /**
   * Refetch when the window gets focus again. Default: true. A query that another one's
   * change tells to refresh (the editor's string list, by the project's revision) can opt
   * out, when refetching it is costly.
   */
  revalidateOnFocus?: boolean;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** No data yet, and a request is running or about to. */
  loading: boolean;
  /** Any request is running, including a revalidation. */
  fetching: boolean;
  /** The data belongs to the previous key (`keepPrevious`). */
  previous: boolean;
  refresh(): Promise<T | undefined>;
}

const NO_KEY: QueryKey = ["\u0000none"];
const noop = () => () => {};

/**
 * What `useQuery` shows: the key's data, or with `keepPrevious`, the previous key's data
 * (`kept`) while the new key is still loading, but not once it has failed.
 */
export function shownData<T>(
  state: QueryState<T>,
  kept: T | undefined,
  keepPrevious: boolean,
): { data: T | undefined; previous: boolean } {
  if (state.data !== undefined) return { data: state.data, previous: false };
  const previous = keepPrevious && kept !== undefined && state.status === "pending";
  return { data: previous ? kept : undefined, previous };
}

/**
 * Reads data through the cache: fetches on first use, shares requests between components,
 * and re-renders when the data changes. A `null` key waits (for a dependency, say).
 */
export function useQuery<T>(
  key: QueryKey | null,
  fetcher: Fetcher<T>,
  options: QueryOptions = {},
  cache: QueryCache = queryCache,
): QueryResult<T> {
  const effectiveKey = key ?? NO_KEY;
  const hash = hashKey(effectiveKey);
  const latest = useRef(fetcher);
  latest.current = fetcher;
  // The key is compared by its hash, so callers may pass a new array on every render.
  const stableKey = useMemo(() => effectiveKey, [hash]);

  const subscribe = useCallback(
    (listener: () => void) => (key === null ? noop() : cache.subscribe(stableKey, listener)),
    [cache, stableKey, key === null],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => cache.get<T>(stableKey),
    () => cache.get<T>(stableKey),
  );

  const staleTime = options.staleTime ?? 10_000;
  const revalidateOnFocus = options.revalidateOnFocus ?? true;
  useEffect(() => {
    if (key === null) return;
    cache.register(stableKey, (context) => latest.current(context), { revalidateOnFocus });
    cache.ensure(stableKey, staleTime);
  }, [cache, stableKey, key === null, staleTime, revalidateOnFocus]);

  const interval = options.refreshInterval;
  useEffect(() => {
    if (key === null || !interval) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") cache.fetch(stableKey).catch(() => {});
    }, interval);
    return () => clearInterval(timer);
  }, [cache, stableKey, key === null, interval]);

  const kept = useRef<T | undefined>(undefined);
  if (state.data !== undefined) kept.current = state.data;
  const { data, previous } = shownData(state, kept.current, options.keepPrevious === true);

  const refresh = useCallback(async () => {
    if (key === null) return undefined;
    return await cache.fetch<T>(stableKey, (context) => latest.current(context), {
      force: true,
    });
  }, [cache, stableKey, key === null]);

  return {
    data,
    error: state.error,
    loading: key !== null && data === undefined && state.status !== "error",
    fetching: state.fetching,
    previous,
    refresh,
  };
}

export interface MutationOptions<R> {
  /** Keys to invalidate after success. */
  invalidate?: QueryKey[];
  onSuccess?: (result: R) => void | Promise<void>;
}

export interface Mutation<A extends unknown[], R> {
  /** Runs the mutation; rejects with its error, which also stays in `error`. */
  run(...args: A): Promise<R>;
  pending: boolean;
  error: unknown;
  reset(): void;
}

/** A write to the API, with its pending state and error, invalidating keys on success. */
export function useMutation<A extends unknown[], R>(
  mutate: (...args: A) => Promise<R>,
  options: MutationOptions<R> = {},
  cache: QueryCache = queryCache,
): Mutation<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const latest = useRef({ mutate, options });
  latest.current = { mutate, options };

  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(undefined);
      try {
        const result = await latest.current.mutate(...args);
        await Promise.all(
          (latest.current.options.invalidate ?? []).map((k) => cache.invalidate(k)),
        );
        await latest.current.options.onSuccess?.(result);
        return result;
      } catch (caught) {
        setError(caught);
        throw caught;
      } finally {
        setPending(false);
      }
    },
    [cache],
  );
  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}
