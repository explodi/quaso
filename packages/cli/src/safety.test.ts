// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/**
 * CLI-1 and CLI-5 in the source: the CLI's code (tests and their helpers aside) runs on
 * Node and Deno from one source, so it uses only `node:` built-ins, web APIs and
 * `@quaso/core`, never the Deno namespace, and nothing that starts a process. The build
 * checks the bundle the same way (scripts/build_cli.ts).
 */
import { assertEquals } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join, relative } from "node:path";
import { FORBIDDEN } from "../../../scripts/build_cli.ts";

const CLI = fromFileUrl(new URL("..", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !["e2e", "dist", "node_modules"].includes(entry.name)) {
      files.push(...(await sourceFiles(path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "test_helpers.ts"
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

test("the CLI's code uses only node: built-ins, web APIs and @quaso/core", async () => {
  const problems: string[] = [];
  for (const file of await sourceFiles(CLI)) {
    const name = relative(CLI, file);
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      const where = `${name}:${index + 1}`;
      for (const match of line.matchAll(
        /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g,
      )) {
        const specifier = match[1] ?? match[2];
        if (!/^(node:|\.{1,2}\/|@quaso\/core$)/.test(specifier)) {
          problems.push(`${where} imports ${specifier}`);
        }
      }
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\bDeno\.[A-Za-z]/.test(line)) problems.push(`${where} uses the Deno namespace`);
      for (const word of FORBIDDEN) {
        if (line.includes(word)) problems.push(`${where} contains ${word}`);
      }
    });
  }
  assertEquals(problems, []);
});
