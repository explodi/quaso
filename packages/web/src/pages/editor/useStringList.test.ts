// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { StringsPage, StringsQuery, StringSummary } from "@quaso/core";
import type { ReadOptions } from "../../lib/api.ts";
import {
  fetchLoaded,
  fetchQueuePage,
  neighbourIndex,
  PAGE_SIZE,
  queueCounter,
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
  assertEquals(
    page.strings.map((summary) => summary.id),
    [300, 12],
  );
  assertEquals(page.nextCursor, "3");
  assertEquals(page.total, 4);
  assertEquals(calls[0], { language: "de", ids: [300, 7, 12], limit: 500 });
  assertEquals(queue.ids, [300, 7, 12, 99]);
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
  assertEquals(
    page.strings.map((summary) => summary.id),
    queue.ids,
  );
  assertEquals(page.nextCursor, null);
  assertEquals(
    calls.map((call) => call.query.ids!.length),
    [500, 101],
  );
  assertEquals(
    calls.map((call) => call.options.fresh),
    [true, true],
  );
  const tail = await fetchQueuePage("de", queue, 500, 200, false, list);
  assertEquals(
    tail.strings.map((summary) => summary.id),
    queue.ids.slice(500),
  );
  assertEquals(tail.nextCursor, null);
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
  assertEquals(page.strings, []);
  assertEquals(page.nextCursor, null);
  assertEquals(api.calls.length, 0);
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
  assertEquals(page.strings.length, PAGE_SIZE);
  assertEquals(page.nextCursor, String(PAGE_SIZE));
  assertEquals(
    api.calls.map((c) => c.query.limit),
    [PAGE_SIZE],
  );
});

test("fetching the list again fetches every loaded string, not only the first page", async () => {
  // 5,000 strings loaded by scrolling: refetching them keeps all 5,000 in place, 500 at a time.
  const api = fakeList(6_000);
  const page = await fetchLoaded("de", { state: "green", q: "menu" }, 5_000, true, api.list);
  assertEquals(page.strings.length, 5_000);
  assertEquals(page.strings[3_005].id, 3_006);
  assertEquals(page.nextCursor, "5000");
  assertEquals(page.total, 6_000);
  assertEquals(api.calls.length, 10);
  assertEquals(
    api.calls.every((c) => c.query.limit === 500),
    true,
  );
  assertEquals(
    api.calls.every((c) => c.options.fresh === true),
    true,
  );
  assertEquals(
    api.calls.every((c) => c.query.state === "green" && c.query.q === "menu"),
    true,
  );

  // Fewer strings than were loaded (some left the filter): all of them, and no cursor.
  const shrunk = fakeList(700);
  const fewer = await fetchLoaded("de", {}, 1_000, false, shrunk.list);
  assertEquals(fewer.strings.length, 700);
  assertEquals(fewer.nextCursor, null);
  assertEquals(
    shrunk.calls.map((c) => c.query.limit),
    [500, 500],
  );
});

test("the next string is beside the current one, or takes its place when it left the list", () => {
  assertEquals(neighbourIndex(1_005, 1_005, 1), 1_006);
  assertEquals(neighbourIndex(1_005, 1_005, -1), 1_004);
  // k1005 no longer matches the filter: what is now at 1005 is the next string, 1004 the
  // previous one (not the first string of the list).
  assertEquals(neighbourIndex(-1, 1_005, 1), 1_005);
  assertEquals(neighbourIndex(-1, 1_005, -1), 1_004);
  assertEquals(neighbourIndex(-1, 0, -1), -1);
});

test("queue counters keep the opening total, skip completed states and account for removed rows", () => {
  const fresh = { id: 1, translation: { outdated: false } } as StringSummary;
  const outdated = { id: 2, translation: { outdated: true } } as StringSummary;
  const untranslated = { id: 3, translation: null } as StringSummary;
  assertEquals(queueCounter([1, 2, 3], [fresh, outdated, untranslated], 2), "2 / 3");
  assertEquals(queueCounter([1, 2, 3], [fresh], 1, 1), "1 / 3");
  assertEquals(queueCounter([1, 2, 3], [fresh], 1, 3), "Done");
  assertEquals(queueCounter([], [], null, 0), "Done");
});
