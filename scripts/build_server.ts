// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * `deno task build:server` (design §5.12): compiles the server, with the built website and
 * the snapshot worker inside, into one binary, `dist/quaso`. Pass `--target <triple>` to
 * build for another platform, such as `--target x86_64-unknown-linux-gnu`.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const WEB_DIST = "packages/web/dist";
/** Workers aren't found by `deno compile` on its own. */
const WORKERS = ["packages/server/src/storage/snapshot_worker.ts"];

/**
 * The `deno compile` arguments, with an optional `--target`. The binary gets every
 * permission: it is the whole server, and a container is its sandbox. Without a
 * node_modules folder, compile embeds only the npm packages the server imports (none),
 * instead of the whole workspace's.
 */
export function compileArgs(args: string[]): string[] {
  const includes = [WEB_DIST, ...WORKERS].flatMap((path) => ["--include", path]);
  const npm = ["--node-modules-dir=none", "--exclude-unused-npm"];
  const compile = ["compile", "-A", ...npm, ...includes, "--output", "dist/quaso"];
  const index = args.findIndex((arg) => arg === "--target" || arg.startsWith("--target="));
  if (index !== -1) {
    const target = args[index].includes("=") ? args[index] : `--target=${args[index + 1] ?? ""}`;
    compile.push(target);
  }
  return [...compile, "packages/server/main.ts"];
}

if (import.meta.main) {
  try {
    await fs.stat(join(ROOT, WEB_DIST, "index.html"));
  } catch {
    console.error(`${WEB_DIST} has no index.html. Build the website first: deno task build:web`);
    process.exit(1);
  }
  const args = compileArgs(process.argv.slice(2));
  console.log(`deno ${args.join(" ")}`);
  const { code } = await new Deno.Command(Deno.execPath(), { args, cwd: ROOT }).spawn().status;
  process.exit(code);
}
