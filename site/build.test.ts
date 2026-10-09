// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  brokenOutputLinks,
  type LinkContext,
  navigationGroups,
  type PathKind,
  renderTabs,
  rewriteHref,
} from "./build.ts";
import { docPagePath, relativeHref } from "./src/paths.ts";
import { renderDoc, renderLanding, renderNotFound } from "./src/prerender.tsx";

test("docPagePath maps Markdown files in docs/ to pages", () => {
  assertEquals(docPagePath("README.md"), "docs/index.html");
  assertEquals(docPagePath("cli.md"), "docs/cli.html");
  assertEquals(docPagePath("contributing/architecture.md"), "docs/contributing/architecture.html");
  assertEquals(docPagePath("contributing/README.md"), "docs/contributing/index.html");
});

test("relativeHref links pages relatively, and index pages as folders", () => {
  assertEquals(relativeHref("index.html", "index.html"), "./");
  assertEquals(relativeHref("index.html", "docs/index.html"), "docs/");
  assertEquals(relativeHref("docs/index.html", "index.html"), "../");
  assertEquals(relativeHref("docs/index.html", "docs/index.html"), "./");
  assertEquals(relativeHref("docs/index.html", "assets/site.css"), "../assets/site.css");
  assertEquals(relativeHref("docs/contributing/architecture.html", "docs/cli.html"), "../cli.html");
  assertEquals(
    relativeHref("docs/cli.html", "docs/contributing/architecture.html"),
    "contributing/architecture.html",
  );
});

const FILES: Record<string, PathKind> = {
  docs: "folder",
  "docs/README.md": "file",
  "docs/cli.md": "file",
  "docs/contributing": "folder",
  "docs/images/upload.png": "file",
  "CONTRIBUTING.md": "file",
  examples: "folder",
};

function context(warnings: string[], repositoryUrl?: string): LinkContext {
  return {
    repositoryUrl,
    kind: (path) => FILES[path],
    warn: (message) => warnings.push(message),
  };
}

test("rewriteHref points Markdown links in docs/ to pages", () => {
  const warnings: string[] = [];
  const from = {
    source: "contributing/architecture.md",
    page: "docs/contributing/architecture.html",
  };
  const ctx = context(warnings, "https://github.com/org/quaso");
  assertEquals(rewriteHref("../cli.md#upload", from, ctx), {
    href: "../cli.html#upload",
    page: "docs/cli.html",
  });
  assertEquals(rewriteHref("../README.md", from, ctx), { href: "../", page: "docs/index.html" });
  assertEquals(rewriteHref("/docs/cli.md", from, ctx), {
    href: "../cli.html",
    page: "docs/cli.html",
  });
  assertEquals(rewriteHref("../images/upload.png", from, ctx), { href: "../images/upload.png" });
  assertEquals(warnings, []);
});

test("rewriteHref points links outside docs/ to GitHub", () => {
  const warnings: string[] = [];
  const from = { source: "README.md", page: "docs/index.html" };
  const ctx = context(warnings, "https://github.com/org/quaso");
  assertEquals(rewriteHref("../CONTRIBUTING.md#tests", from, ctx), {
    href: "https://github.com/org/quaso/blob/main/CONTRIBUTING.md#tests",
  });
  assertEquals(rewriteHref("../examples/", from, ctx), {
    href: "https://github.com/org/quaso/tree/main/examples",
  });
  assertEquals(warnings, []);
});

test("rewriteHref keeps absolute links and fragments, and warns about missing files", () => {
  const warnings: string[] = [];
  const from = { source: "README.md", page: "docs/index.html" };
  const ctx = context(warnings);
  for (const href of ["https://example.com/a.md", "mailto:a@example.com", "#usage", "//cdn/x.md"]) {
    assertEquals(rewriteHref(href, from, ctx), { href });
  }
  assertEquals(rewriteHref("missing.md", from, ctx), {
    href: "missing.html",
    page: "docs/missing.html",
  });
  assertEquals(rewriteHref("../CONTRIBUTING.md", from, ctx), { href: "../CONTRIBUTING.md" });
  assertEquals(warnings.length, 2);
});

test("rendered site checks page links, fragments and screenshots", () => {
  const pages = new Map([
    ["index.html", '<a href="docs/">Docs</a><img src="screenshots/editor.png" alt="Editor">'],
    ["docs/index.html", '<h1 id="docs">Docs</h1><a href="#docs">Top</a><a href="../">Home</a>'],
  ]);
  const files = new Set([...pages.keys(), "screenshots/editor.png"]);
  assertEquals(brokenOutputLinks(pages, files), []);
  pages.set(
    "docs/bad.html",
    '<a href="absent.html">Missing</a><a href="./#unknown">Bad anchor</a><img src="absent.png"><link rel="stylesheet" href="absent.css">',
  );
  files.add("docs/bad.html");
  assertEquals(brokenOutputLinks(pages, files).length, 4);
});

test("static documents use shared primitives without shipping JavaScript at nested paths", () => {
  const landing = renderLanding({ hasDoc: () => true });
  const doc = renderDoc({
    page: "docs/contributing/design-system.html",
    title: "Design system",
    html: '<h1 id="design-system">Design system</h1>',
    navigation: [
      { title: "Get started", links: [{ page: "docs/index.html", title: "Quick start" }] },
    ],
  });
  const missing = renderNotFound({ baseHref: "/quaso/" });
  for (const html of [landing, doc, missing]) {
    assert(!html.includes("<script"), "The published site works without JavaScript");
    assertStringIncludes(html, 'class="skip-link" href="#site-content"');
    assertStringIncludes(html, 'id="site-content" tabindex="-1"');
    assertStringIncludes(html, 'class="wordmark ');
  }
  assertStringIncludes(doc, 'href="../../assets/site.css"');
  assertStringIncludes(doc, 'href="../../assets/gfm.css"');
  assertStringIncludes(doc, 'href="../"');
  assertStringIncludes(missing, '<base href="/quaso/"');
  for (const colour of ["red", "green", "blue"]) {
    assertStringIncludes(landing, `colour-label colour-${colour}`);
    assertStringIncludes(landing, `state-icon state-${colour}`);
  }
  assertStringIncludes(landing, "Translated by the LLM");
});

test("renderTabs makes a tab of each heading in a tabs region", () => {
  const html =
    "<p>Pick one:</p>\n<!-- tabs -->\n" +
    '<h3 id="docker-compose">Docker Compose</h3>\n<p>On a VM.</p>\n' +
    '<h3 id="cloudflare">Cloudflare</h3>\n<p>On Workers.</p>\n<h4 id="details">Details</h4>\n' +
    "<!-- /tabs -->\n<p>Then sign in.</p>";
  assertEquals(
    renderTabs(html),
    "<p>Pick one:</p>\n" +
      '<div class="doc-tabs">' +
      '<input type="radio" class="doc-tab-input" name="tabs-1" id="tabs-1-1" checked>' +
      '<label class="tab doc-tab" for="tabs-1-1">Docker Compose</label>' +
      '<div class="doc-tab-panel" id="docker-compose">\n<p>On a VM.</p>\n</div>' +
      '<input type="radio" class="doc-tab-input" name="tabs-1" id="tabs-1-2">' +
      '<label class="tab doc-tab" for="tabs-1-2">Cloudflare</label>' +
      '<div class="doc-tab-panel" id="cloudflare">\n<p>On Workers.</p>\n<h4 id="details">Details</h4>\n</div>' +
      "</div>\n<p>Then sign in.</p>",
  );
});

test("renderTabs numbers the regions of a page, and refuses text before the first tab", () => {
  const region = "<!-- tabs -->\n<h3>One</h3>\n<p>1</p>\n<!-- /tabs -->\n";
  const twice = renderTabs(region + region);
  assertStringIncludes(twice, 'name="tabs-1"');
  assertStringIncludes(twice, 'name="tabs-2"');
  assertThrows(() => renderTabs("<!-- tabs -->\n<p>Stray</p>\n<h3>One</h3>\n<!-- /tabs -->"));
});

test("navigationGroups titles the sidebar's pages", () => {
  const titles = new Map([
    ["README.md", "Quick start"],
    ["contributing/testing.md", "Testing"],
  ]);
  const groups = [
    { title: "Get started", sources: ["README.md"] },
    { title: "Contribute", sources: ["contributing/testing.md"] },
  ];
  assertEquals(navigationGroups(groups, titles), [
    { title: "Get started", links: [{ page: "docs/index.html", title: "Quick start" }] },
    { title: "Contribute", links: [{ page: "docs/contributing/testing.html", title: "Testing" }] },
  ]);
});

test("navigationGroups refuses pages missing from the sidebar, and entries without a page", () => {
  const titles = new Map([
    ["README.md", "Quick start"],
    ["cli.md", "The CLI"],
  ]);
  const groups = [{ title: "Get started", sources: ["README.md", "README.md", "gone.md"] }];
  const error = assertThrows(() => navigationGroups(groups, titles), Error);
  assertStringIncludes(error.message, "navigation.ts lists docs/gone.md, which is missing");
  assertStringIncludes(error.message, "navigation.ts lists docs/README.md more than once");
  assertStringIncludes(error.message, "docs/cli.md is missing from navigation.ts");
});
