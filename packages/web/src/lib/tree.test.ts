// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { FileProgress, SourceFileInfo } from "@quaso/core";
import { buildTree, filterTree, leaves, parentPath, sumProgress, visibleNodes } from "./tree.ts";

let id = 0;
function file(path: string, patch: Partial<FileProgress> = {}): FileProgress {
  return {
    id: ++id,
    path,
    repoPath: path,
    strings: 10,
    words: 100,
    untranslated: 5,
    green: 3,
    blue: 2,
    outdated: 0,
    pending: 0,
    qa: 0,
    wordsLeft: 50,
    translatedPercent: 50,
    proofreadPercent: 20,
    ...patch,
  };
}

test("folders come from the paths, first, sorted by name", () => {
  const tree = buildTree([
    file("store.json"),
    file("menus/main.json"),
    file("common.json"),
    file("menus/pause.json"),
    file("menus/deep/level10.json"),
    file("menus/deep/level2.json"),
  ]);
  assertEquals(
    tree.map((node) => node.path),
    ["menus/", "common.json", "store.json"],
  );
  const menus = tree[0];
  assertEquals(menus.type, "folder");
  if (menus.type !== "folder") return;
  assertEquals(
    menus.children.map((node) => [node.name, node.depth]),
    [
      ["deep", 1],
      ["main.json", 1],
      ["pause.json", 1],
    ],
  );
  const deep = menus.children[0];
  if (deep.type !== "folder") throw new Error("deep is a folder");
  assertEquals(
    deep.children.map((node) => node.name),
    ["level2.json", "level10.json"],
  );
  assertEquals(leaves(tree).length, 6);
  assertEquals(menus.progress.strings, 40);
});

test("progress adds up: translated words exactly, proofread words estimated", () => {
  const total = sumProgress([
    file("a.json", { words: 100, wordsLeft: 0, translatedPercent: 100, proofreadPercent: 100 }),
    file("b.json", { words: 300, wordsLeft: 300, translatedPercent: 0, proofreadPercent: 0 }),
  ]);
  assertEquals(total.words, 400);
  assertEquals(total.wordsLeft, 300);
  assertEquals(total.translatedPercent, 25);
  assertEquals(total.proofreadPercent, 25);
  assertEquals(sumProgress([]).translatedPercent, 0);
});

test("filtering by name and hiding completed files", () => {
  const done = { untranslated: 0, wordsLeft: 0, translatedPercent: 100 };
  const tree = buildTree([
    file("menus/main.json", done),
    file("menus/pause.json"),
    file("common.json", done),
  ]);
  assertEquals(
    leaves(filterTree(tree, "PAUSE", false)).map((f) => f.path),
    ["menus/pause.json"],
  );
  assertEquals(
    leaves(filterTree(tree, "", true)).map((f) => f.path),
    ["menus/pause.json"],
  );
  assertEquals(filterTree(tree, "nothing", false), []);
  assertEquals(leaves(filterTree(tree, "", false)).length, 3);
});

test("visible nodes skip collapsed folders", () => {
  const tree = buildTree([file("menus/main.json"), file("common.json")]);
  assertEquals(
    visibleNodes(tree, new Set()).map((n) => n.path),
    ["menus/", "menus/main.json", "common.json"],
  );
  assertEquals(
    visibleNodes(tree, new Set(["menus/"])).map((n) => n.path),
    ["menus/", "common.json"],
  );
  assertEquals(parentPath("menus/main.json"), "menus/");
  assertEquals(parentPath("menus/deep/"), "menus/");
  assertEquals(parentPath("common.json"), undefined);
});

test("repository paths build displayed folders while leaves retain server identities", () => {
  const tree = buildTree([
    file("common.json", { repoPath: "src/locales/en/common.json" }),
    file("menus/play.json", { repoPath: "packages/game/en/play.json" }),
  ]);
  assertEquals(
    tree.map((node) => node.path),
    ["packages/", "src/"],
  );
  assertEquals(
    leaves(tree).map((leaf) => [leaf.path, leaf.repoPath, leaf.depth]),
    [
      ["menus/play.json", "packages/game/en/play.json", 3],
      ["common.json", "src/locales/en/common.json", 3],
    ],
  );
  assertEquals(
    leaves(filterTree(tree, "packages/game", false)).map((leaf) => leaf.path),
    ["menus/play.json"],
  );
  assertEquals(parentPath(leaves(tree)[0].repoPath), "packages/game/en/");
});

test("source trees sum counts without inventing translation progress", () => {
  const files: SourceFileInfo[] = [
    {
      id: 1,
      path: "a.json",
      repoPath: "src/en/a.json",
      strings: 3,
      words: 8,
      updatedAt: 100,
      revision: 1,
    },
    {
      id: 2,
      path: "b.json",
      repoPath: "src/en/b.json",
      strings: 0,
      words: 0,
      updatedAt: 200,
      revision: 2,
    },
  ];
  const tree = buildTree(files);
  assertEquals(tree[0].progress, { strings: 3, words: 8 });
  assertEquals(
    leaves(tree).map((leaf) => leaf.progress),
    files,
  );
  assertEquals(leaves(filterTree(tree, "", true)).length, 2);
});
