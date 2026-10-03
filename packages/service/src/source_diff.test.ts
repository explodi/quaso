// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import type { EntryColumns } from "./entries.ts";
import { diffSourceStrings, type ExistingSourceString } from "./source_diff.ts";

const ENTRY: EntryColumns = {
  key: "text:title",
  keyPath: '["title"]',
  displayKey: "title",
  kind: "text",
  source: '"Hello"',
  sourceHash: "hello-hash",
  words: 1,
  searchText: "title hello",
};
const ROW: ExistingSourceString = {
  id: 7,
  key: ENTRY.key,
  display_key: "title",
  kind: "text",
  source: ENTRY.source,
  source_hash: ENTRY.sourceHash,
  position: 0,
  active: 1,
};

test("source diff adds new entries in source order", () => {
  const diff = diffSourceStrings([ENTRY], []);
  assertEquals(diff.changes, [{ type: "added", entry: ENTRY, position: 0 }]);
  assertEquals(diff.counts, {
    added: 1,
    changed: 0,
    removed: 0,
    restored: 0,
    moved: 0,
    unchanged: 0,
  });
});

test("source diff leaves identical sources unchanged", () => {
  const diff = diffSourceStrings([ENTRY], [ROW]);
  assertEquals(diff.changes[0].type, "unchanged");
  assertEquals(diff.counts, {
    added: 0,
    changed: 0,
    removed: 0,
    restored: 0,
    moved: 0,
    unchanged: 1,
  });
});

test("source diff counts a changed and moved entry in both totals", () => {
  const old = { ...ROW, position: 2, source_hash: "older-hash" };
  const diff = diffSourceStrings([ENTRY], [old]);
  assertEquals(diff.changes[0], {
    type: "changed",
    entry: ENTRY,
    position: 0,
    previous: old,
    sourceChanged: true,
  });
  assertEquals(diff.counts, {
    added: 0,
    changed: 1,
    removed: 0,
    restored: 0,
    moved: 1,
    unchanged: 0,
  });
});

test("source diff restores hidden identity without counting a move", () => {
  const old = { ...ROW, active: 0, position: 2, source_hash: "older-hash" };
  const diff = diffSourceStrings([ENTRY], [old]);
  assertEquals(diff.changes[0], {
    type: "restored",
    entry: ENTRY,
    position: 0,
    previous: old,
    sourceChanged: true,
  });
  assertEquals(diff.counts, {
    added: 0,
    changed: 0,
    removed: 0,
    restored: 1,
    moved: 0,
    unchanged: 0,
  });
});

test("source diff removes only missing active entries", () => {
  const hidden = { ...ROW, id: 8, key: "hidden", active: 0 };
  const diff = diffSourceStrings([], [ROW, hidden]);
  assertEquals(diff.removed, [ROW]);
  assertEquals(diff.counts, {
    added: 0,
    changed: 0,
    removed: 1,
    restored: 0,
    moved: 0,
    unchanged: 0,
  });
});

test("source diff changes kind even if the hash stays the same", () => {
  const diff = diffSourceStrings([ENTRY], [{ ...ROW, kind: "plural" }]);
  assertEquals(diff.changes[0].type, "changed");
  assertEquals(diff.counts.changed, 1);
});

test("source diff does not mutate the supplied entries or rows", () => {
  const entry = Object.freeze({ ...ENTRY });
  const row = Object.freeze({ ...ROW, position: 1 });
  const diff = diffSourceStrings([entry], [row]);
  assertEquals(diff.changes[0].type, "moved");
  assertEquals(row.position, 1);
  assertEquals(entry, ENTRY);
});
