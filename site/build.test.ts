// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(docPagePath("README.md")).toBe("docs/index.html");
  expect(docPagePath("cli.md")).toBe("docs/cli.html");
  expect(docPagePath("contributing/architecture.md")).toStrictEqual(
    "docs/contributing/architecture.html",
  );
  expect(docPagePath("contributing/README.md")).toBe("docs/contributing/index.html");
});

test("relativeHref links pages relatively, and index pages as folders", () => {
  expect(relativeHref("index.html", "index.html")).toBe("./");
  expect(relativeHref("index.html", "docs/index.html")).toBe("docs/");
  expect(relativeHref("docs/index.html", "index.html")).toBe("../");
  expect(relativeHref("docs/index.html", "docs/index.html")).toBe("./");
  expect(relativeHref("docs/index.html", "assets/site.css")).toBe("../assets/site.css");
  expect(relativeHref("docs/contributing/architecture.html", "docs/cli.html")).toStrictEqual(
    "../cli.html",
  );
  expect(relativeHref("docs/cli.html", "docs/contributing/architecture.html")).toStrictEqual(
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
  expect(rewriteHref("../cli.md#upload", from, ctx)).toStrictEqual({
    href: "../cli.html#upload",
    page: "docs/cli.html",
  });
  expect(rewriteHref("../README.md", from, ctx)).toStrictEqual({
    href: "../",
    page: "docs/index.html",
  });
  expect(rewriteHref("/docs/cli.md", from, ctx)).toStrictEqual({
    href: "../cli.html",
    page: "docs/cli.html",
  });
  expect(rewriteHref("../images/upload.png", from, ctx)).toStrictEqual({
    href: "../images/upload.png",
  });
  expect(warnings).toStrictEqual([]);
});

test("rewriteHref points links outside docs/ to GitHub", () => {
  const warnings: string[] = [];
  const from = { source: "README.md", page: "docs/index.html" };
  const ctx = context(warnings, "https://github.com/org/quaso");
  expect(rewriteHref("../CONTRIBUTING.md#tests", from, ctx)).toStrictEqual({
    href: "https://github.com/org/quaso/blob/main/CONTRIBUTING.md#tests",
  });
  expect(rewriteHref("../examples/", from, ctx)).toStrictEqual({
    href: "https://github.com/org/quaso/tree/main/examples",
  });
  expect(warnings).toStrictEqual([]);
});

test("rewriteHref keeps absolute links and fragments, and warns about missing files", () => {
  const warnings: string[] = [];
  const from = { source: "README.md", page: "docs/index.html" };
  const ctx = context(warnings);
  for (const href of ["https://example.com/a.md", "mailto:a@example.com", "#usage", "//cdn/x.md"]) {
    expect(rewriteHref(href, from, ctx)).toStrictEqual({ href });
  }
  expect(rewriteHref("missing.md", from, ctx)).toStrictEqual({
    href: "missing.html",
    page: "docs/missing.html",
  });
  expect(rewriteHref("../CONTRIBUTING.md", from, ctx)).toStrictEqual({
    href: "../CONTRIBUTING.md",
  });
  expect(warnings.length).toBe(2);
});

test("rendered site checks page links, fragments and screenshots", () => {
  const pages = new Map([
    ["index.html", '<a href="docs/">Docs</a><img src="screenshots/editor.png" alt="Editor">'],
    ["docs/index.html", '<h1 id="docs">Docs</h1><a href="#docs">Top</a><a href="../">Home</a>'],
  ]);
  const files = new Set([...pages.keys(), "screenshots/editor.png"]);
  expect(brokenOutputLinks(pages, files)).toStrictEqual([]);
  pages.set(
    "docs/bad.html",
    '<a href="absent.html">Missing</a><a href="./#unknown">Bad anchor</a><img src="absent.png"><link rel="stylesheet" href="absent.css">',
  );
  files.add("docs/bad.html");
  expect(brokenOutputLinks(pages, files).length).toBe(4);
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
    expect(html).toContain('class="skip-link" href="#site-content"');
    expect(html).toContain('id="site-content" tabindex="-1"');
    expect(html).toContain('class="wordmark ');
  }
  expect(doc).toContain('href="../../assets/site.css"');
  expect(doc).toContain('href="../../assets/gfm.css"');
  expect(doc).toContain('href="../"');
  expect(missing).toContain('<base href="/quaso/"');
  for (const colour of ["red", "green", "blue"]) {
    expect(landing).toContain(`colour-label colour-${colour}`);
    expect(landing).toContain(`state-icon state-${colour}`);
  }
  expect(landing).toContain("Translated by the LLM");
});

test("renderTabs makes a tab of each heading in a tabs region", () => {
  const html =
    "<p>Pick one:</p>\n<!-- tabs -->\n" +
    '<h3 id="docker-compose">Docker Compose</h3>\n<p>On a VM.</p>\n' +
    '<h3 id="cloudflare">Cloudflare</h3>\n<p>On Workers.</p>\n<h4 id="details">Details</h4>\n' +
    "<!-- /tabs -->\n<p>Then sign in.</p>";
  expect(renderTabs(html)).toStrictEqual(
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
  expect(twice).toContain('name="tabs-1"');
  expect(twice).toContain('name="tabs-2"');
  expect(() => renderTabs("<!-- tabs -->\n<p>Stray</p>\n<h3>One</h3>\n<!-- /tabs -->")).toThrow();
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
  expect(navigationGroups(groups, titles)).toStrictEqual([
    { title: "Get started", links: [{ page: "docs/index.html", title: "Quick start" }] },
    { title: "Contribute", links: [{ page: "docs/contributing/testing.html", title: "Testing" }] },
  ]);
});

test("navigationGroups refuses pages missing from the sidebar, and entries without a page", async () => {
  const titles = new Map([
    ["README.md", "Quick start"],
    ["cli.md", "The CLI"],
  ]);
  const groups = [{ title: "Get started", sources: ["README.md", "README.md", "gone.md"] }];
  const error = await Promise.try(() => navigationGroups(groups, titles)).catch(
    (error: unknown) => error,
  );
  assert(error instanceof Error);
  expect(error.message).toContain("navigation.ts lists docs/gone.md, which is missing");
  expect(error.message).toContain("navigation.ts lists docs/README.md more than once");
  expect(error.message).toContain("docs/cli.md is missing from navigation.ts");
});
