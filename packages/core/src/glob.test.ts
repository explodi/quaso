// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { expandBraces, globBase, globProblem, globToRegExp } from "./glob.ts";

test("globBase: the folder where the glob starts", () => {
  expect(globBase("src/locales/en/**/*.json")).toBe("src/locales/en");
  expect(globBase("src/locales/en/*.json")).toBe("src/locales/en");
  expect(globBase("locales/en.json")).toBe("locales");
  expect(globBase("common.json")).toBe("");
  expect(globBase("**/*.json")).toBe("");
  expect(globBase("{src,lib}/en/*.json")).toBe("");
  expect(globBase("i18n/en/[ab]*.json")).toBe("i18n/en");
});

test("expandBraces expands groups, nested ones too, and keeps others literal", () => {
  expect(expandBraces("a/{b,c}/d")).toStrictEqual(["a/b/d", "a/c/d"]);
  expect(expandBraces("{a,b{c,d}}.json")).toStrictEqual(["a.json", "bc.json", "bd.json"]);
  expect(expandBraces("{a}{b,c}")).toStrictEqual(["{a}b", "{a}c"]);
  expect(expandBraces("a{b,c")).toStrictEqual(["a{b,c"]);
  expect(expandBraces("[{]x")).toStrictEqual(["[{]x"]);
  expect(() => expandBraces("{a,b}".repeat(11))).toThrow();
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
  expect(globToRegExp("posts.*", ".").test("posts.welcome.title")).toBeFalsy();
  expect(globToRegExp("posts.*", ".").test("postsXwelcome")).toBeFalsy();
  assert(globToRegExp("posts.**", ".").test("posts.welcome.title"));
  assert(globToRegExp("{posts,replies}.*", ".").test("replies.first"));
  assert(globToRegExp("menu/*", ".").test("menu/play"));
});

test("globProblem names a pattern that can't be used", () => {
  expect(globProblem("posts.*", ".")).toBe(null);
  expect(globProblem("a/[z-a].json")).toStrictEqual(
    "isn't a valid glob: Invalid regular expression: /^(?:a\\/[z-a]\\.json)$/: Range out of order in character class",
  );
});
