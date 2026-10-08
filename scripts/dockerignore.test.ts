// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/**
 * `.dockerignore` keeps secrets and local state out of every image build, in every folder:
 * `wrangler deploy` builds from the repository's root, where packages/cloudflare holds
 * `.dev.vars` files. The rules are read as Docker reads them: in order, the last matching
 * rule wins (`!` includes again), and a rule that matches a folder matches what is in it.
 */
import { assertEquals } from "@std/assert";
import { globToRegExp } from "@std/path/glob-to-regexp";

const RULES = (await fs.readFile(new URL("../.dockerignore", import.meta.url), "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const include = line.startsWith("!");
    const pattern = globToRegExp(include ? line.slice(1) : line, { globstar: true });
    return { include, pattern };
  });

/** Whether Docker leaves `path` (relative to the root, with `/`) out of the build. */
function ignored(path: string): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let out = false;
  for (const { include, pattern } of RULES) {
    if (candidates.some((candidate) => pattern.test(candidate))) out = !include;
  }
  return out;
}

test(".dockerignore leaves secrets and local state out, in every folder", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".dev.vars",
    "deploy/.env",
    "packages/cloudflare/.dev.vars",
    "packages/cloudflare/.dev.vars.production",
    "packages/cloudflare/.dev.vars.staging",
    "packages/cloudflare/.wrangler/state/v3/do/db.sqlite",
    ".wrangler/tmp/x.js",
    ".quaso/quaso.db",
    "node_modules/react/index.js",
    "packages/cloudflare/node_modules/wrangler/package.json",
    "packages/web/dist/index.html",
    ".git/HEAD",
    "plans/sprint-plan.md",
  ]) {
    assertEquals(ignored(path), true, path);
  }
});

test(".dockerignore sends the sources and the examples of settings", () => {
  for (const path of [
    "package.json",
    "deno.lock",
    "deploy/Dockerfile",
    "deploy/.env.example",
    "packages/cloudflare/.dev.vars.example",
    "packages/cloudflare/wrangler.jsonc",
    "packages/server/main.ts",
    "packages/web/src/main.tsx",
    "examples/demo-game/quaso.config.json",
  ]) {
    assertEquals(ignored(path), false, path);
  }
});
