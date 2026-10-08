// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "node:path";
import { expandBraces, glob, globBase, globToRegExp } from "./glob.ts";
import { withProject } from "./test_helpers.ts";

test("globBase: the folder where the glob starts", () => {
  assertEquals(globBase("src/locales/en/**/*.json"), "src/locales/en");
  assertEquals(globBase("src/locales/en/*.json"), "src/locales/en");
  assertEquals(globBase("locales/en.json"), "locales");
  assertEquals(globBase("common.json"), "");
  assertEquals(globBase("**/*.json"), "");
  assertEquals(globBase("{src,lib}/en/*.json"), "");
  assertEquals(globBase("i18n/en/[ab]*.json"), "i18n/en");
});

test("expandBraces expands groups, nested ones too, and keeps others literal", () => {
  assertEquals(expandBraces("a/{b,c}/d"), ["a/b/d", "a/c/d"]);
  assertEquals(expandBraces("{a,b{c,d}}.json"), ["a.json", "bc.json", "bd.json"]);
  assertEquals(expandBraces("{a}{b,c}"), ["{a}b", "{a}c"]);
  assertEquals(expandBraces("a{b,c"), ["a{b,c"]);
  assertEquals(expandBraces("[{]x"), ["[{]x"]);
  assertThrows(() => expandBraces("{a,b}".repeat(11)));
});

test("globToRegExp: *, **, ?, classes and braces", () => {
  const cases: [string, string[], string[]][] = [
    ["src/*.json", ["src/a.json", "src/.json"], ["src/a/b.json", "src/a.jsonx", "a.json"]],
    ["src/**/*.json", ["src/a.json", "src/a/b/c.json"], ["src/a.txt", "other/a.json"]],
    ["**/*.json", ["a.json", "a/b.json"], ["a.txt"]],
    ["src/**", ["src/a", "src/a/b"], ["other/a"]],
    ["a/?.json", ["a/b.json"], ["a/bc.json", "a//.json"]],
    ["a/[bc].json", ["a/b.json", "a/c.json"], ["a/d.json"]],
    ["a/[a-c]x.json", ["a/bx.json"], ["a/dx.json"]],
    ["a/[!b].json", ["a/c.json"], ["a/b.json", "a//.json"]],
    ["a/{en,de}/*.json", ["a/en/x.json", "a/de/x.json"], ["a/fr/x.json"]],
    ["a.b+(c)/$x.json", ["a.b+(c)/$x.json"], ["aXb+(c)/$x.json"]],
  ];
  for (const [pattern, yes, no] of cases) {
    const regex = globToRegExp(pattern);
    for (const path of yes) assert(regex.test(path), `${pattern} matches ${path}`);
    for (const path of no) assert(!regex.test(path), `${pattern} doesn't match ${path}`);
  }
});

test("glob walks folders, skipping node_modules and dot folders, sorted", async () => {
  await withProject(
    {
      "src/locales/en/b.json": "{}",
      "src/locales/en/a.json": "{}",
      "src/locales/en/menus/main.json": "{}",
      "src/locales/en/notes.txt": "",
      "src/locales/en/node_modules/x.json": "{}",
      "src/locales/en/.cache/y.json": "{}",
      "src/locales/de/a.json": "{}",
    },
    async (dir) => {
      assertEquals(await glob(dir, "src/locales/en/**/*.json"), [
        "src/locales/en/a.json",
        "src/locales/en/b.json",
        "src/locales/en/menus/main.json",
      ]);
      assertEquals(await glob(dir, "src/locales/en/*.json"), [
        "src/locales/en/a.json",
        "src/locales/en/b.json",
      ]);
      assertEquals(await glob(dir, "src/locales/*/a.json"), [
        "src/locales/de/a.json",
        "src/locales/en/a.json",
      ]);
      assertEquals(
        await glob(dir, "src/locales/en/**/*.json", {
          exclude: ["**/menus/**", "src/locales/en/b.*"],
        }),
        ["src/locales/en/a.json"],
      );
      assertEquals(await glob(dir, "src/locales/en/a.json"), ["src/locales/en/a.json"]);
      assertEquals(await glob(dir, "missing/**/*.json"), []);
      assertEquals(await glob(dir, "src/locales/en/a.json/*.json"), []);
    },
  );
});

test("glob doesn't follow linked folders, but does linked files", async () => {
  if (process.platform === "win32") return;
  await withProject({ "src/en/a.json": "{}", "elsewhere/b.json": "{}" }, async (dir) => {
    await fs.symlink(join(dir, "elsewhere"), join(dir, "src", "en", "linked"));
    await fs.symlink(join(dir, "elsewhere", "b.json"), join(dir, "src", "en", "b.json"));
    await fs.symlink(join(dir, "src"), join(dir, "src", "en", "loop"));
    assertEquals(await glob(dir, "src/en/**/*.json"), ["src/en/a.json", "src/en/b.json"]);
  });
});
