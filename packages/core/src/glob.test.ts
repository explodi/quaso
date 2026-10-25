// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { expandBraces, globBase, globProblem, globToRegExp } from "./glob.ts";

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

test("globToRegExp over key paths: * stays within a key, ** spans keys", () => {
  assert(globToRegExp("posts.*", ".").test("posts.welcome"));
  assertFalse(globToRegExp("posts.*", ".").test("posts.welcome.title"));
  assertFalse(globToRegExp("posts.*", ".").test("postsXwelcome"));
  assert(globToRegExp("posts.**", ".").test("posts.welcome.title"));
  assert(globToRegExp("{posts,replies}.*", ".").test("replies.first"));
  assert(globToRegExp("menu/*", ".").test("menu/play"));
});

test("globProblem names a pattern that can't be used", () => {
  assertEquals(globProblem("posts.*", "."), null);
  assertEquals(
    globProblem("a/[z-a].json"),
    "isn't a valid glob: Invalid regular expression: /^(?:a\\/[z-a]\\.json)$/: Range out of order in character class",
  );
});
