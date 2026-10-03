// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { Command } from "@quaso/runtime/command";
/**
 * `bun run build:server` (design §5.12): compiles the server, with the built website and
 * the snapshot worker inside, into one binary, `dist/quaso`. Pass `--target <triple>` to
 * build for another platform, such as `--target bun-linux-x64`.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const WEB_DIST = "packages/web/dist";
/** Workers aren't found by `bun build --compile` on its own. */
const WORKERS = ["packages/server/src/storage/snapshot_worker.ts"];

/** The `bun build --compile` arguments, with an optional `--target`. */
export function compileArgs(args: string[]): string[] {
  const compile = ["build", "--compile", "--asset", WEB_DIST, "--outfile", "dist/quaso"];
  const index = args.findIndex((arg) => arg === "--target" || arg.startsWith("--target="));
  if (index !== -1) {
    const target = args[index].includes("=") ? args[index] : `--target=${args[index + 1] ?? ""}`;
    compile.push(target);
  }
  return [...compile, "packages/server/main.ts", ...WORKERS];
}

if (import.meta.main) {
  try {
    await fs.stat(join(ROOT, WEB_DIST, "index.html"));
  } catch {
    console.error(`${WEB_DIST} has no index.html. Build the website first: bun run build:web`);
    process.exit(1);
  }
  const args = compileArgs(process.argv.slice(2));
  console.log(`bun ${args.join(" ")}`);
  const { code } = await new Command(process.execPath, { args, cwd: ROOT }).spawn().status;
  process.exit(code);
}
