// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { StringsPage, StringsQuery, StringSummary } from "@quaso/core";
import type { ReadOptions } from "../../lib/api.ts";
import {
  fetchLoaded,
  fetchQueuePage,
  neighbourIndex,
  PAGE_SIZE,
  queueCounter,
  upcomingToDo,
} from "./useStringList.ts";

test("queue details retain opening order and cursor slots even when a string disappears", async () => {
  const queue = { language: "de", ids: [300, 7, 12, 99], toDo: 3 };
  const calls: StringsQuery[] = [];
  const list = async (query: StringsQuery): Promise<StringsPage> => {
    calls.push(query);
    return {
      language: "de",
      total: 2,
      nextCursor: null,
      strings: [{ id: 12 }, { id: 300 }] as StringSummary[],
    };
  };
  const page = await fetchQueuePage("de", queue, 0, 3, true, list);
  expect(page.strings.map((summary) => summary.id)).toStrictEqual([300, 12]);
  expect(page.nextCursor).toBe("3");
  expect(page.total).toBe(4);
  expect(calls[0]).toStrictEqual({ language: "de", ids: [300, 7, 12], limit: 500 });
  expect(queue.ids).toStrictEqual([300, 7, 12, 99]);
});

test("queue refreshes use bounded ID requests and preserve order across batches", async () => {
  const queue = {
    language: "de",
    ids: Array.from({ length: 601 }, (_, index) => 601 - index),
    toDo: 600,
  };
  const calls: { query: StringsQuery; options: ReadOptions }[] = [];
  const list = async (query: StringsQuery, options: ReadOptions = {}): Promise<StringsPage> => {
    calls.push({ query, options });
    return {
      language: "de",
      total: query.ids!.length,
      nextCursor: null,
      strings: query.ids!.toSorted((a, b) => a - b).map((id) => ({ id }) as StringSummary),
    };
  };
  const page = await fetchQueuePage("de", queue, 0, 800, true, list);
  expect(page.strings.map((summary) => summary.id)).toStrictEqual(queue.ids);
  expect(page.nextCursor).toBe(null);
  expect(calls.map((call) => call.query.ids!.length)).toStrictEqual([500, 101]);
  expect(calls.map((call) => call.options.fresh)).toStrictEqual([true, true]);
  const tail = await fetchQueuePage("de", queue, 500, 200, false, list);
  expect(tail.strings.map((summary) => summary.id)).toStrictEqual(queue.ids.slice(500));
  expect(tail.nextCursor).toBe(null);
});

test("an empty queue fetches no details", async () => {
  const api = fakeList(0);
  const page = await fetchQueuePage(
    "de",
    { language: "de", ids: [], toDo: 0 },
    0,
    200,
    false,
    api.list,
  );
  expect(page.strings).toStrictEqual([]);
  expect(page.nextCursor).toBe(null);
  expect(api.calls.length).toBe(0);
});

/** A fake API over `total` strings, paging with numeric cursors, that records its calls. */
function fakeList(total: number) {
  const calls: { query: StringsQuery; options: ReadOptions }[] = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 1 }) as StringSummary);
  const list = (query: StringsQuery, options: ReadOptions = {}): Promise<StringsPage> => {
    calls.push({ query, options });
    const start = query.cursor ? Number(query.cursor) : 0;
    const end = Math.min(total, start + (query.limit ?? 100));
    return Promise.resolve({
      language: query.language,
      strings: all.slice(start, end),
      nextCursor: end < total ? String(end) : null,
      total,
    });
  };
  return { list, calls };
}

test("the first load is one page", async () => {
  const api = fakeList(5_000);
  const page = await fetchLoaded("de", {}, 0, false, api.list);
  expect(page.strings.length).toStrictEqual(PAGE_SIZE);
  expect(page.nextCursor).toStrictEqual(String(PAGE_SIZE));
  expect(api.calls.map((c) => c.query.limit)).toStrictEqual([PAGE_SIZE]);
});

test("fetching the list again fetches every loaded string, not only the first page", async () => {
  // 5,000 strings loaded by scrolling: refetching them keeps all 5,000 in place, 500 at a time.
  const api = fakeList(6_000);
  const page = await fetchLoaded("de", { state: "green", q: "menu" }, 5_000, true, api.list);
  expect(page.strings.length).toBe(5_000);
  expect(page.strings[3_005].id).toBe(3_006);
  expect(page.nextCursor).toBe("5000");
  expect(page.total).toBe(6_000);
  expect(api.calls.length).toBe(10);
  expect(api.calls.every((c) => c.query.limit === 500)).toBe(true);
  expect(api.calls.every((c) => c.options.fresh === true)).toBe(true);
  expect(api.calls.every((c) => c.query.state === "green" && c.query.q === "menu")).toStrictEqual(
    true,
  );

  // Fewer strings than were loaded (some left the filter): all of them, and no cursor.
  const shrunk = fakeList(700);
  const fewer = await fetchLoaded("de", {}, 1_000, false, shrunk.list);
  expect(fewer.strings.length).toBe(700);
  expect(fewer.nextCursor).toBe(null);
  expect(shrunk.calls.map((c) => c.query.limit)).toStrictEqual([500, 500]);
});

test("the next string is beside the current one, or takes its place when it left the list", () => {
  expect(neighbourIndex(1_005, 1_005, 1)).toBe(1_006);
  expect(neighbourIndex(1_005, 1_005, -1)).toBe(1_004);
  // k1005 no longer matches the filter: what is now at 1005 is the next string, 1004 the
  // previous one (not the first string of the list).
  expect(neighbourIndex(-1, 1_005, 1)).toBe(1_005);
  expect(neighbourIndex(-1, 1_005, -1)).toBe(1_004);
  expect(neighbourIndex(-1, 0, -1)).toBe(-1);
});

const UNTRANSLATED = (id: number) => ({ id, translation: null }) as StringSummary;
const OUTDATED = (id: number) => ({ id, translation: { outdated: true } }) as StringSummary;
const FINISHED = (id: number) => ({ id, translation: { outdated: false } }) as StringSummary;
const ROWS = [UNTRANSLATED(1), FINISHED(2), UNTRANSLATED(3), OUTDATED(4), UNTRANSLATED(5)];

test("the upcoming strings are the next ones to do, without the finished ones", () => {
  expect(upcomingToDo(ROWS, 1, 2).map((row) => row.id)).toStrictEqual([3, 4]);
});

test("the open string and those before it aren't upcoming", () => {
  expect(upcomingToDo(ROWS, 3, 5).map((row) => row.id)).toStrictEqual([4, 5]);
});

test("a string that isn't in the list has no upcoming strings", () => {
  expect(upcomingToDo(ROWS, 99, 5)).toStrictEqual([]);
  expect(upcomingToDo(ROWS, null, 5)).toStrictEqual([]);
});

test("queue counters keep the opening total, skip completed states and account for removed rows", () => {
  const fresh = { id: 1, translation: { outdated: false } } as StringSummary;
  const outdated = { id: 2, translation: { outdated: true } } as StringSummary;
  const untranslated = { id: 3, translation: null } as StringSummary;
  expect(queueCounter([1, 2, 3], [fresh, outdated, untranslated], 2)).toBe("2 / 3");
  expect(queueCounter([1, 2, 3], [fresh], 1, 1)).toBe("1 / 3");
  expect(queueCounter([1, 2, 3], [fresh], 1, 3)).toBe("Done");
  expect(queueCounter([], [], null, 0)).toBe("Done");
});
