// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import {
  buildQuery,
  fillPattern,
  href,
  matchPath,
  matchRoutes,
  parseQuery,
  safeNext,
} from "./match.ts";

test("matchPath matches static paths and parameters", () => {
  expect(matchPath("/", "/")).toStrictEqual({});
  expect(matchPath("/activity", "/activity")).toStrictEqual({});
  expect(matchPath("/activity", "/activity/")).toStrictEqual({});
  expect(matchPath("/activity", "/activities")).toBe(null);
  expect(matchPath("/languages/:lang", "/languages/pt-BR")).toStrictEqual({ lang: "pt-BR" });
  expect(matchPath("/languages/:lang", "/languages")).toBe(null);
  expect(matchPath("/languages/:lang", "/languages/de/extra")).toBe(null);
  expect(matchPath("/", "/languages")).toBe(null);
});

test("matchPath decodes parameters and refuses bad encoding", () => {
  expect(matchPath("/languages/:lang", "/languages/zh%2DHans")).toStrictEqual({ lang: "zh-Hans" });
  expect(matchPath("/languages/:lang", "/languages/%E0%A4%A")).toBe(null);
});

test("a splat takes the rest of the path, at least one segment", () => {
  expect(matchPath("/translate/:lang/*file", "/translate/de/menus/main.json")).toStrictEqual({
    lang: "de",
    file: "menus/main.json",
  });
  expect(matchPath("/translate/:lang/*file", "/translate/de/a%20b.json")).toStrictEqual({
    lang: "de",
    file: "a b.json",
  });
  expect(matchPath("/translate/:lang/*file", "/translate/de")).toBe(null);
  expect(() => matchPath("/*rest/more", "/a/more")).toThrow();
});

test("matchRoutes returns the first route that matches", () => {
  const routes = [
    { path: "/translate/:lang", name: "editor" },
    { path: "/translate/:lang/*file", name: "editor-file" },
    { path: "/languages/:lang", name: "language" },
  ];
  expect(matchRoutes(routes, "/translate/fr")?.route.name).toBe("editor");
  expect(matchRoutes(routes, "/translate/fr/a.json")?.params).toStrictEqual({
    lang: "fr",
    file: "a.json",
  });
  expect(matchRoutes(routes, "/nowhere")).toBe(null);
});

test("query strings: the last value wins, and empty values are left out", () => {
  expect(parseQuery("?file=a.json&state=green&state=blue")).toStrictEqual({
    file: "a.json",
    state: "blue",
  });
  expect(parseQuery("")).toStrictEqual({});
  expect(buildQuery({ q: "hello world", state: undefined, file: "", id: 5, all: false })).toBe(
    "?q=hello+world&id=5",
  );
  expect(buildQuery({})).toBe("");
  expect(href("/translate/de", { file: "menus/main.json" })).toStrictEqual(
    "/translate/de?file=menus%2Fmain.json",
  );
});

test("fillPattern encodes each parameter", () => {
  expect(fillPattern("/languages/:lang", { lang: "pt-BR" })).toBe("/languages/pt-BR");
  expect(fillPattern("/translate/:lang/*file", { lang: "de", file: "a b/c.json" })).toStrictEqual(
    "/translate/de/a%20b/c.json",
  );
  expect(() => fillPattern("/languages/:lang", {})).toThrow();
});

test("safeNext only allows paths on this site", () => {
  expect(safeNext("/translate/de?id=4")).toBe("/translate/de?id=4");
  expect(safeNext("//evil.example")).toBe("/");
  expect(safeNext("/\\evil.example")).toBe("/");
  expect(safeNext("https://evil.example")).toBe("/");
  expect(safeNext(null)).toBe("/");
  expect(safeNext("")).toBe("/");
  expect(safeNext("activity")).toBe("/");
});

test("safeNext refuses what the URL parser turns into another site's address", () => {
  // The parser drops tabs and line breaks: "/\t/evil.example/x" is "//evil.example/x".
  for (const next of ["/\t/evil.example/x", "/\n/evil.example/x", "/\r/evil.example/x"]) {
    expect(safeNext(next), JSON.stringify(next)).toBe("/");
    // As they arrive from the address: ?next=/%09/evil.example/x.
    const encoded = `?next=${encodeURIComponent(next)}`;
    expect(safeNext(parseQuery(encoded).next), encoded).toBe("/");
  }
  // Backslashes are slashes, and dot segments go.
  expect(safeNext("/\\/evil.example")).toBe("/");
  expect(safeNext("/.//evil.example")).toBe("/");
  expect(safeNext("/a/..//evil.example")).toBe("/");
  expect(safeNext("/\u0000/evil.example")).toBe("/");
  // Whatever safeNext returns stays on the site it is resolved against.
  const here = "http://127.0.0.1:8000/signin";
  for (const next of [
    "/\t/evil.example/x",
    "/.//evil.example",
    "/%2F/evil.example",
    "/translate/de?q=a%20b#k",
  ]) {
    expect(new URL(safeNext(next), here).origin, next).toBe("http://127.0.0.1:8000");
  }
  // Ordinary paths keep their query and fragment.
  expect(safeNext("/translate/de?q=a%20b&id=4#k")).toBe("/translate/de?q=a%20b&id=4#k");
});
