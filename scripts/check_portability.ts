// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Keeps `core` and `service` portable (design §3): they run in Bun, in `workerd` inside a
 * Durable Object, and (`core`) in browsers and Node. Their code, tests excepted, may only
 * use web-standard APIs and their ports: no `Deno.*`, no `node:`, `jsr:`, `npm:` or `@std/`
 * imports, and nothing from the server.
 */
import { repositoryFiles } from "./_files.ts";

const PORTABLE = /^packages\/(core|service)\/.*\.ts$/;
const TEST = /(\.test\.ts|\/testdata\/|\/test_helpers?\.ts$|\/testing\/|\/adapters\/node_)/;
const RULES: [RegExp, string][] = [
  [/\b(?:Deno|Bun)\.[a-zA-Z]/, "uses a runtime namespace"],
  [/from\s+["'](bun:|node:|jsr:|npm:|@std\/|https?:)/, "imports a runtime-specific module"],
  [/import\(\s*["'](bun:|node:|jsr:|npm:|@std\/)/, "imports a runtime-specific module"],
  [/from\s+["']@quaso\/(server|cli|web|runtime)/, "imports a package that isn't portable"],
];

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of await repositoryFiles()) {
    if (!PORTABLE.test(file) || TEST.test(file)) continue;
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [pattern, message] of RULES) {
        if (pattern.test(line)) problems.push(`${file}:${index + 1}: ${message}: ${line.trim()}`);
      }
    });
  }
  if (problems.length > 0) {
    console.error("core and service must stay portable (design §3):");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("Portability: ok");
}
