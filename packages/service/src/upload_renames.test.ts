// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { type RenameCandidate, type RenameKey, suggestUploadRenames } from "./upload_renames.ts";

const OLD: RenameCandidate = {
  id: 1,
  fileId: 1,
  file: "menu.json",
  position: 0,
  kind: "text",
  sourceHash: "same",
};
const NEW = { ...OLD, id: 2, position: 1 };
const OLD_KEY: RenameKey = {
  id: 1,
  file_id: 1,
  display_key: "old",
  key_path: '["old"]',
  kind: "text",
};
const NEW_KEY = { ...OLD_KEY, id: 2, display_key: "new", key_path: '["new"]' };

test("rename suggestions need a translation on the removed string", () => {
  assertEquals(suggestUploadRenames([OLD], [NEW], new Set(), [OLD_KEY, NEW_KEY]), []);
  assertEquals(suggestUploadRenames([OLD], [NEW], new Set([1]), [OLD_KEY, NEW_KEY]), [
    { file: "menu.json", from: "old", to: "new" },
  ]);
});

test("rename suggestions require the same file, kind and source", () => {
  assertEquals(
    suggestUploadRenames(
      [OLD],
      [
        { ...NEW, fileId: 2, file: "other.json" },
        { ...NEW, kind: "plural" },
        { ...NEW, sourceHash: "different" },
      ],
      new Set([1]),
      [OLD_KEY, NEW_KEY],
    ),
    [],
  );
});

test("rename suggestions pair several matching keys in file order", () => {
  const old2 = { ...OLD, id: 3, position: 2 };
  const new2 = { ...NEW, id: 4, position: 3 };
  const oldKey2 = { ...OLD_KEY, id: 3, display_key: "old2", key_path: '["old2"]' };
  const newKey2 = { ...NEW_KEY, id: 4, display_key: "new2", key_path: '["new2"]' };
  assertEquals(
    suggestUploadRenames([old2, OLD], [new2, NEW], new Set([1, 3]), [
      OLD_KEY,
      NEW_KEY,
      oldKey2,
      newKey2,
    ]),
    [
      { file: "menu.json", from: "old", to: "new" },
      { file: "menu.json", from: "old2", to: "new2" },
    ],
  );
});

test("rename suggestions preserve one-to-many and many-to-one choices", () => {
  const old2 = { ...OLD, id: 3, position: 2 };
  const new2 = { ...NEW, id: 4, position: 3 };
  const keys = [
    OLD_KEY,
    NEW_KEY,
    { ...OLD_KEY, id: 3, display_key: "old2", key_path: '["old2"]' },
    { ...NEW_KEY, id: 4, display_key: "new2", key_path: '["new2"]' },
  ];
  assertEquals(suggestUploadRenames([OLD], [new2, NEW], new Set([1]), keys), [
    { file: "menu.json", from: "old", to: "new" },
    { file: "menu.json", from: "old", to: "new2" },
  ]);
  assertEquals(suggestUploadRenames([old2, OLD], [NEW], new Set([1, 3]), keys), [
    { file: "menu.json", from: "old", to: "new" },
    { file: "menu.json", from: "old2", to: "new" },
  ]);
});

test("rename suggestions use exact paths for ambiguous dotted keys", () => {
  const dotted = { ...OLD_KEY, display_key: "a.b", key_path: '["a.b"]' };
  const nested = { ...dotted, id: 3, key_path: '["a","b"]' };
  assertEquals(suggestUploadRenames([OLD], [NEW], new Set([1]), [dotted, nested, NEW_KEY]), [
    { file: "menu.json", from: '["a.b"]', to: "new" },
  ]);
});

test("rename suggestions use kind suffixes when hidden and active keys share a name", () => {
  const text = { ...OLD_KEY, display_key: "coins", key_path: '["coins"]' };
  const plural = { ...text, id: 3, kind: "plural" };
  assertEquals(suggestUploadRenames([OLD], [NEW], new Set([1]), [text, plural, NEW_KEY]), [
    { file: "menu.json", from: "coins#text", to: "new" },
  ]);
});
