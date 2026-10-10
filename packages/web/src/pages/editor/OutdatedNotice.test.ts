// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { HistoryEntry } from "@quaso/core";
import { englishWhenTranslated } from "./OutdatedNotice.tsx";

function entry(fields: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 1,
    stringId: 1,
    language: null,
    event: "source_changed",
    before: null,
    after: null,
    beforeColour: null,
    afterColour: null,
    actor: { type: "system", id: null, name: "Upload" },
    detail: null,
    createdAt: 0,
    ...fields,
  } as HistoryEntry;
}

test("the English a translation was made for is the first change after it was written", () => {
  // Newest first, as the history API returns them.
  const entries = [
    entry({ id: 4, before: "Hello, traveller!", after: "Hello, hero!", createdAt: 400 }),
    entry({ id: 3, before: "Hello!", after: "Hello, traveller!", createdAt: 300 }),
    entry({ id: 2, event: "translation_saved", language: "de", after: "Hallo!", createdAt: 200 }),
    entry({ id: 1, before: "Hi!", after: "Hello!", createdAt: 100 }),
  ];
  assertEquals(englishWhenTranslated(entries, 200), "Hello!");
});

test("without a change to the English after the translation, the history doesn't say", () => {
  const entries = [entry({ before: "Hi!", after: "Hello!", createdAt: 100 })];
  assertEquals(englishWhenTranslated(entries, 200), null);
});
