// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(tree.map((node) => node.path)).toStrictEqual(["menus/", "common.json", "store.json"]);
  const menus = tree[0];
  expect(menus.type).toBe("folder");
  if (menus.type !== "folder") return;
  expect(menus.children.map((node) => [node.name, node.depth])).toStrictEqual([
    ["deep", 1],
    ["main.json", 1],
    ["pause.json", 1],
  ]);
  const deep = menus.children[0];
  if (deep.type !== "folder") throw new Error("deep is a folder");
  expect(deep.children.map((node) => node.name)).toStrictEqual(["level2.json", "level10.json"]);
  expect(leaves(tree).length).toBe(6);
  expect(menus.progress.strings).toBe(40);
});

test("progress adds up: translated words exactly, proofread words estimated", () => {
  const total = sumProgress([
    file("a.json", { words: 100, wordsLeft: 0, translatedPercent: 100, proofreadPercent: 100 }),
    file("b.json", { words: 300, wordsLeft: 300, translatedPercent: 0, proofreadPercent: 0 }),
  ]);
  expect(total.words).toBe(400);
  expect(total.wordsLeft).toBe(300);
  expect(total.translatedPercent).toBe(25);
  expect(total.proofreadPercent).toBe(25);
  expect(sumProgress([]).translatedPercent).toBe(0);
});

test("filtering by name and hiding completed files", () => {
  const done = { untranslated: 0, wordsLeft: 0, translatedPercent: 100 };
  const tree = buildTree([
    file("menus/main.json", done),
    file("menus/pause.json"),
    file("common.json", done),
  ]);
  expect(leaves(filterTree(tree, "PAUSE", false)).map((f) => f.path)).toStrictEqual([
    "menus/pause.json",
  ]);
  expect(leaves(filterTree(tree, "", true)).map((f) => f.path)).toStrictEqual(["menus/pause.json"]);
  expect(filterTree(tree, "nothing", false)).toStrictEqual([]);
  expect(leaves(filterTree(tree, "", false)).length).toBe(3);
});

test("visible nodes skip collapsed folders", () => {
  const tree = buildTree([file("menus/main.json"), file("common.json")]);
  expect(visibleNodes(tree, new Set()).map((n) => n.path)).toStrictEqual([
    "menus/",
    "menus/main.json",
    "common.json",
  ]);
  expect(visibleNodes(tree, new Set(["menus/"])).map((n) => n.path)).toStrictEqual([
    "menus/",
    "common.json",
  ]);
  expect(parentPath("menus/main.json")).toBe("menus/");
  expect(parentPath("menus/deep/")).toBe("menus/");
  expect(parentPath("common.json")).toBe(undefined);
});

test("repository paths build displayed folders while leaves retain server identities", () => {
  const tree = buildTree([
    file("common.json", { repoPath: "src/locales/en/common.json" }),
    file("menus/play.json", { repoPath: "packages/game/en/play.json" }),
  ]);
  expect(tree.map((node) => node.path)).toStrictEqual(["packages/", "src/"]);
  expect(leaves(tree).map((leaf) => [leaf.path, leaf.repoPath, leaf.depth])).toStrictEqual([
    ["menus/play.json", "packages/game/en/play.json", 3],
    ["common.json", "src/locales/en/common.json", 3],
  ]);
  expect(leaves(filterTree(tree, "packages/game", false)).map((leaf) => leaf.path)).toStrictEqual([
    "menus/play.json",
  ]);
  expect(parentPath(leaves(tree)[0].repoPath)).toBe("packages/game/en/");
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
  expect(tree[0].progress).toStrictEqual({ strings: 3, words: 8 });
  expect(leaves(tree).map((leaf) => leaf.progress)).toStrictEqual(files);
  expect(leaves(filterTree(tree, "", true)).length).toBe(2);
});
