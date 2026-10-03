// SPDX-License-Identifier: MIT
/**
 * The editor's string list: the first page through the cache, more pages as the list
 * scrolls, and rows refreshed in place after a change, so the list doesn't jump. Fetching
 * the list again (after someone else's change) fetches as many strings as are loaded, so
 * the rows, the scroll position and the selected string stay where they are.
 */
import type { StateFilter, StringsPage, StringsQueue, StringSummary } from "@quaso/core";
import { useCallback, useMemo, useRef } from "react";
import { getStringsQueue, listStrings } from "../../lib/api.ts";
import { queryCache, type QueryKey, useQuery } from "../../lib/data.ts";

/** Strings per request. */
export const PAGE_SIZE = 200;
/** The API's largest page. */
const MAX_PAGE = 500;

export interface ListFilters {
  file?: string;
  state?: StateFilter;
  q?: string;
  order?: "queue" | "file";
}

interface ListPage extends StringsPage {
  queue?: StringsQueue;
}

export interface StringList {
  strings: StringSummary[];
  /** Every string matching the filters, loaded or not. */
  total: number;
  /** Initial unfinished IDs, in opening order; subsequent refreshes never regroup them. */
  toDoIds?: number[];
  queueLoaded?: number;
  findToDo(id: number | null, delta: 1 | -1): Promise<number | null>;
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  /** The strings shown are the previous filters' while the new ones load. */
  previous: boolean;
  /** Loads the next page; resolves with every loaded string. */
  loadMore(): Promise<StringSummary[]>;
  /** Fetches these strings again and updates them wherever they are listed. */
  refreshStrings(ids: number[]): Promise<void>;
  /** Fetches the loaded strings again (after someone else's change). */
  refresh(): Promise<void>;
  retry(): void;
}

export function isToDo(row: StringSummary): boolean {
  return row.translation === null || row.translation.outdated;
}

/** Unloaded IDs retain their opening state until their details arrive. */
export function queueCounter(
  ids: number[],
  rows: StringSummary[],
  selected: number | null,
  loaded = rows.length,
): string {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const remaining = ids.some((id, index) => {
    const row = byId.get(id);
    return row === undefined ? index >= loaded : isToDo(row);
  });
  if (!remaining) return "Done";
  const index = selected === null ? -1 : ids.indexOf(selected);
  return index >= 0 ? `${index + 1} / ${ids.length}` : `To do: ${ids.length}`;
}

/**
 * Where the next (`delta` 1) or previous (-1) string is: beside the current one, or, when it
 * has left the list (it no longer matches the filter, say), from where it was last seen: the
 * string that took its place is the next one.
 */
export function neighbourIndex(current: number, lastSeen: number, delta: 1 | -1): number {
  if (current >= 0) return current + delta;
  return delta > 0 ? lastSeen : lastSeen - 1;
}

export function stringsKey(language: string, filters: ListFilters): QueryKey {
  return [
    "strings",
    language,
    filters.file ?? "",
    filters.state ?? "",
    filters.q ?? "",
    filters.order ?? "file",
  ];
}

/** Details may arrive in file order; only the opening ID sequence determines row order. */
export async function fetchQueuePage(
  language: string,
  queue: StringsQueue,
  offset: number,
  count: number,
  fresh: boolean,
  list = listStrings,
): Promise<ListPage> {
  const end = Math.min(queue.ids.length, offset + count);
  const wanted = queue.ids.slice(offset, end);
  const byId = new Map<number, StringSummary>();
  for (let start = 0; start < wanted.length; start += MAX_PAGE) {
    const page = await list(
      { language, ids: wanted.slice(start, start + MAX_PAGE), limit: MAX_PAGE },
      { fresh },
    );
    for (const summary of page.strings) byId.set(summary.id, summary);
  }
  return {
    language,
    total: queue.ids.length,
    queue,
    strings: wanted
      .map((id) => byId.get(id))
      .filter((summary): summary is StringSummary => summary !== undefined),
    nextCursor: end < queue.ids.length ? String(end) : null,
  };
}

/** Merges a page into a list, leaving out strings already there (offsets can shift). */
function merge(list: StringSummary[], page: StringSummary[]): StringSummary[] {
  const seen = new Set(list.map((s) => s.id));
  return [...list, ...page.filter((s) => !seen.has(s.id))];
}

/**
 * The list's first `count` strings (at least one page), in as few requests as the API's
 * largest page allows, following the cursors. The answer's cursor continues after them.
 */
export async function fetchLoaded(
  language: string,
  filters: ListFilters,
  count: number,
  fresh: boolean,
  list = listStrings,
): Promise<StringsPage> {
  const wanted = Math.max(PAGE_SIZE, count);
  const { file, state, q } = filters;
  let page = await list({ language, file, state, q, limit: Math.min(MAX_PAGE, wanted) }, { fresh });
  let strings = page.strings;
  while (page.nextCursor && strings.length < wanted) {
    page = await list(
      {
        language,
        file,
        state,
        q,
        cursor: page.nextCursor,
        limit: Math.min(MAX_PAGE, wanted - strings.length),
      },
      { fresh },
    );
    strings = merge(strings, page.strings);
  }
  return { ...page, strings };
}

export function useStringList(language: string | null, filters: ListFilters): StringList {
  const { file, state, q, order = "file" } = filters;
  const key = useMemo(
    () => (language ? stringsKey(language, { file, state, q, order }) : null),
    [language, file, state, q, order],
  );
  const snapshot = useRef<{ scope: string; queue: Promise<StringsQueue> } | null>(null);
  const query = useQuery<ListPage>(
    key,
    // However the list is fetched again (a revision change, "Try again", coming back to the
    // page), it fetches as many strings as are loaded, not only the first page.
    async ({ fresh }) => {
      if (order === "queue") {
        const scope = JSON.stringify(key);
        if (snapshot.current?.scope !== scope) {
          const opening = {
            scope,
            queue: getStringsQueue({ language: language!, file, state, q }, { fresh: true }),
          };
          snapshot.current = opening;
          opening.queue.catch(() => {
            if (snapshot.current === opening) snapshot.current = null;
          });
        }
        const queue = await snapshot.current!.queue;
        const current = key ? queryCache.get<ListPage>(key).data : undefined;
        const loaded =
          current?.queue === queue ? Number(current.nextCursor ?? queue.ids.length) : 0;
        return fetchQueuePage(language!, queue, 0, Math.max(PAGE_SIZE, loaded), fresh);
      }
      snapshot.current = null;
      return fetchLoaded(
        language!,
        { file, state, q },
        key ? (queryCache.get<StringsPage>(key).data?.strings.length ?? 0) : 0,
        fresh,
      );
    },
    // Not on focus: the editor polls the project, and its revision says when to refresh.
    { keepPrevious: true, staleTime: order === "queue" ? 0 : 5_000, revalidateOnFocus: false },
  );
  const loadingMore = useRef<{ scope: string; promise: Promise<StringSummary[]> } | null>(null);

  const loadMore = useCallback(async (): Promise<StringSummary[]> => {
    if (!key || !language) return [];
    const data = queryCache.get<ListPage>(key).data;
    if (!data?.nextCursor) return data?.strings ?? [];
    const scope = JSON.stringify(key);
    if (loadingMore.current?.scope === scope) return await loadingMore.current.promise;
    const cursor = data.nextCursor;
    const promise = (async () => {
      const page = data.queue
        ? await fetchQueuePage(language, data.queue, Number(cursor), PAGE_SIZE, false)
        : await listStrings({ language, file, state, q, cursor, limit: PAGE_SIZE });
      let strings: StringSummary[] = [];
      queryCache.setData<ListPage>(key, (current) => {
        if (current && data.queue && current.queue !== data.queue) {
          strings = current.strings;
          return current;
        }
        strings = merge(current?.strings ?? [], page.strings);
        return { ...page, strings };
      });
      return strings;
    })();
    loadingMore.current = { scope, promise };
    try {
      return await promise;
    } finally {
      if (loadingMore.current?.promise === promise) loadingMore.current = null;
    }
  }, [key, language, file, state, q]);

  const findToDo = useCallback(
    async (id: number | null, delta: 1 | -1) => {
      if (!key) return null;
      let data = queryCache.get<ListPage>(key).data;
      if (!data) return null;
      const ids = data.queue?.ids.slice(0, data.queue.toDo);
      if (ids) {
        const selected = id === null ? -1 : data.queue!.ids.indexOf(id);
        let index = delta > 0 ? selected + 1 : Math.min(selected - 1, ids.length - 1);
        while (index >= 0 && index < ids.length) {
          const target = ids[index];
          while (data.nextCursor && Number(data.nextCursor) <= index) {
            await loadMore();
            data = queryCache.get<ListPage>(key).data!;
          }
          const row = data.strings.find((row) => row.id === target);
          if (row && isToDo(row)) return target;
          index += delta;
        }
        return null;
      }
      let index = neighbourIndex(
        data.strings.findIndex((row) => row.id === id),
        0,
        delta,
      );
      while (index >= 0) {
        if (index >= data.strings.length) {
          if (delta < 0 || !data.nextCursor) return null;
          await loadMore();
          data = queryCache.get<ListPage>(key).data!;
          continue;
        }
        const row = data.strings[index];
        if (isToDo(row)) return row.id;
        index += delta;
      }
      return null;
    },
    [key, loadMore],
  );

  const refreshStrings = useCallback(
    async (ids: number[]) => {
      if (!language || ids.length === 0) return;
      const fresh = new Map<number, StringSummary>();
      for (let i = 0; i < ids.length; i += MAX_PAGE) {
        const page = await listStrings(
          {
            language,
            ids: ids.slice(i, i + MAX_PAGE),
            limit: MAX_PAGE,
          },
          { fresh: true },
        );
        for (const summary of page.strings) fresh.set(summary.id, summary);
      }
      queryCache.update<StringsPage>(["strings", language], (list) => ({
        ...list,
        strings: list.strings.map((summary) => fresh.get(summary.id) ?? summary),
      }));
    },
    [language],
  );

  const refresh = useCallback(async () => {
    if (!key || !language) return;
    await queryCache.fetch(key, undefined, { force: true }).catch(() => {});
  }, [key, language]);

  const data = query.data;
  return {
    strings: data?.strings ?? [],
    total: data?.total ?? 0,
    toDoIds: data?.queue?.ids.slice(0, data.queue.toDo),
    queueLoaded: data?.queue ? Number(data.nextCursor ?? data.queue.ids.length) : undefined,
    findToDo,
    hasMore: data?.nextCursor !== null && data?.nextCursor !== undefined,
    loading: query.loading,
    error: query.error,
    previous: query.previous,
    loadMore,
    refreshStrings,
    refresh,
    retry: () => {
      query.refresh().catch(() => {});
    },
  };
}
