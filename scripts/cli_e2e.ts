// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The CLI's end-to-end test for CI's matrix (S4.1, S4.11): starts a server in this process,
 * copies the translation fixture to a temporary folder, and runs the built bundle
 * (`npm run build:cli`) through the scenario. The bundle runs on the Node that runs this
 * script, or on `--node`, so CI can test the oldest Node the npm package supports:
 *
 *   node scripts/cli_e2e.ts [--bundle packages/cli/dist/quaso.mjs] [--node /path/to/node]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join, resolve } from "node:path";
import { bundled } from "../packages/cli/e2e/harness.ts";
import { runScenario } from "../packages/cli/e2e/scenario.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** `--bundle <path>`, by default the one `npm run build:cli` writes, and `--node <path>`. */
export function parseOptions(args: string[]): { bundle: string; node: string } {
  let bundle = join(ROOT, "packages", "cli", "dist", "quaso.mjs");
  let node = process.execPath;
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split(/=(.*)/s, 2);
    const value = inline ?? args[++index];
    if (name !== "--bundle" && name !== "--node") throw new Error(`Unknown argument ${name}`);
    if (!value) throw new Error(`${name} needs a path`);
    if (name === "--bundle") bundle = resolve(value);
    else node = value;
  }
  return { bundle, node };
}

if (import.meta.main) {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error("Usage: node scripts/cli_e2e.ts [--bundle <path>] [--node <path>]");
    process.exit(2);
  }
  try {
    await fs.stat(options.bundle);
  } catch {
    console.error(`${options.bundle} doesn't exist. Build it first: npm run build:cli`);
    process.exit(1);
  }
  const version = spawnSync(options.node, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(`The CLI bundle under Node ${version}:`);
  const started = performance.now();
  await runScenario(bundled(options.bundle, options.node), (step) => console.log(`  ${step}`));
  console.log(`ok (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}
