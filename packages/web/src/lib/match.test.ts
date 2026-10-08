// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
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
  assertEquals(matchPath("/", "/"), {});
  assertEquals(matchPath("/activity", "/activity"), {});
  assertEquals(matchPath("/activity", "/activity/"), {});
  assertEquals(matchPath("/activity", "/activities"), null);
  assertEquals(matchPath("/languages/:lang", "/languages/pt-BR"), { lang: "pt-BR" });
  assertEquals(matchPath("/languages/:lang", "/languages"), null);
  assertEquals(matchPath("/languages/:lang", "/languages/de/extra"), null);
  assertEquals(matchPath("/", "/languages"), null);
});

test("matchPath decodes parameters and refuses bad encoding", () => {
  assertEquals(matchPath("/languages/:lang", "/languages/zh%2DHans"), { lang: "zh-Hans" });
  assertEquals(matchPath("/languages/:lang", "/languages/%E0%A4%A"), null);
});

test("a splat takes the rest of the path, at least one segment", () => {
  assertEquals(matchPath("/translate/:lang/*file", "/translate/de/menus/main.json"), {
    lang: "de",
    file: "menus/main.json",
  });
  assertEquals(matchPath("/translate/:lang/*file", "/translate/de/a%20b.json"), {
    lang: "de",
    file: "a b.json",
  });
  assertEquals(matchPath("/translate/:lang/*file", "/translate/de"), null);
  assertThrows(() => matchPath("/*rest/more", "/a/more"));
});

test("matchRoutes returns the first route that matches", () => {
  const routes = [
    { path: "/translate/:lang", name: "editor" },
    { path: "/translate/:lang/*file", name: "editor-file" },
    { path: "/languages/:lang", name: "language" },
  ];
  assertEquals(matchRoutes(routes, "/translate/fr")?.route.name, "editor");
  assertEquals(matchRoutes(routes, "/translate/fr/a.json")?.params, { lang: "fr", file: "a.json" });
  assertEquals(matchRoutes(routes, "/nowhere"), null);
});

test("query strings: the last value wins, and empty values are left out", () => {
  assertEquals(parseQuery("?file=a.json&state=green&state=blue"), {
    file: "a.json",
    state: "blue",
  });
  assertEquals(parseQuery(""), {});
  assertEquals(
    buildQuery({ q: "hello world", state: undefined, file: "", id: 5, all: false }),
    "?q=hello+world&id=5",
  );
  assertEquals(buildQuery({}), "");
  assertEquals(
    href("/translate/de", { file: "menus/main.json" }),
    "/translate/de?file=menus%2Fmain.json",
  );
});

test("fillPattern encodes each parameter", () => {
  assertEquals(fillPattern("/languages/:lang", { lang: "pt-BR" }), "/languages/pt-BR");
  assertEquals(
    fillPattern("/translate/:lang/*file", { lang: "de", file: "a b/c.json" }),
    "/translate/de/a%20b/c.json",
  );
  assertThrows(() => fillPattern("/languages/:lang", {}));
});

test("safeNext only allows paths on this site", () => {
  assertEquals(safeNext("/translate/de?id=4"), "/translate/de?id=4");
  assertEquals(safeNext("//evil.example"), "/");
  assertEquals(safeNext("/\\evil.example"), "/");
  assertEquals(safeNext("https://evil.example"), "/");
  assertEquals(safeNext(null), "/");
  assertEquals(safeNext(""), "/");
  assertEquals(safeNext("activity"), "/");
});

test("safeNext refuses what the URL parser turns into another site's address", () => {
  // The parser drops tabs and line breaks: "/\t/evil.example/x" is "//evil.example/x".
  for (const next of ["/\t/evil.example/x", "/\n/evil.example/x", "/\r/evil.example/x"]) {
    assertEquals(safeNext(next), "/", JSON.stringify(next));
    // As they arrive from the address: ?next=/%09/evil.example/x.
    const encoded = `?next=${encodeURIComponent(next)}`;
    assertEquals(safeNext(parseQuery(encoded).next), "/", encoded);
  }
  // Backslashes are slashes, and dot segments go.
  assertEquals(safeNext("/\\/evil.example"), "/");
  assertEquals(safeNext("/.//evil.example"), "/");
  assertEquals(safeNext("/a/..//evil.example"), "/");
  assertEquals(safeNext("/\u0000/evil.example"), "/");
  // Whatever safeNext returns stays on the site it is resolved against.
  const here = "http://127.0.0.1:8000/signin";
  for (const next of [
    "/\t/evil.example/x",
    "/.//evil.example",
    "/%2F/evil.example",
    "/translate/de?q=a%20b#k",
  ]) {
    assertEquals(new URL(safeNext(next), here).origin, "http://127.0.0.1:8000", next);
  }
  // Ordinary paths keep their query and fragment.
  assertEquals(safeNext("/translate/de?q=a%20b&id=4#k"), "/translate/de?q=a%20b&id=4#k");
});
