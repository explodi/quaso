// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The CLI's end-to-end test for CI's matrix (S4.1, S4.11): starts a server in this process
 * (Deno), copies `examples/demo-game/` to a temporary folder, and runs the built bundle
 * (`deno task build:cli`) through the scenario with the runtime given:
 *
 *   deno run -A scripts/cli_e2e.ts --runtime node
 *   deno run -A scripts/cli_e2e.ts --runtime deno [--bundle packages/cli/dist/quaso.mjs]
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join, resolve } from "node:path";
import { bundled, nodeVersion } from "../packages/cli/e2e/harness.ts";
import { runScenario } from "../packages/cli/e2e/scenario.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** `--runtime node|deno` and `--bundle <path>`. */
export function parseOptions(args: string[]): { runtime: "node" | "deno"; bundle: string } {
  let runtime: string | undefined;
  let bundle = join(ROOT, "packages", "cli", "dist", "quaso.mjs");
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split(/=(.*)/s, 2);
    const value = () => inline ?? args[++index];
    if (name === "--runtime") runtime = value();
    else if (name === "--bundle") bundle = resolve(value() ?? "");
    else throw new Error(`Unknown argument ${args[index]}`);
  }
  if (runtime !== "node" && runtime !== "deno") {
    throw new Error("Usage: deno run -A scripts/cli_e2e.ts --runtime node|deno [--bundle <path>]");
  }
  return { runtime, bundle };
}

if (import.meta.main) {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  try {
    await fs.stat(options.bundle);
  } catch {
    console.error(`${options.bundle} doesn't exist. Build it first: deno task build:cli`);
    process.exit(1);
  }
  const version = options.runtime === "node" ? await nodeVersion() : Deno.version.deno;
  if (version === null) {
    console.error("node isn't installed.");
    process.exit(1);
  }
  console.log(`The CLI bundle under ${options.runtime} ${version}:`);
  const started = performance.now();
  await runScenario(bundled(options.runtime, options.bundle), (step) => console.log(`  ${step}`));
  console.log(`ok (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}
