// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * `deno task cli <command>` (design §5.13): the CLI from source, against the development
 * server of `deno task dev`. It sets `QUASO_HOSTNAME=http://localhost:8000` and
 * `QUASO_API_KEY` from `.quaso/dev-api-key` when they aren't set, and runs the CLI in this
 * process with the remaining arguments.
 *
 * Tasks run in the repository's root, so the CLI runs where `deno task` was started
 * (`INIT_CWD`). Without a `quaso.config.json` there or in a parent folder, and without
 * `--cwd` or `--config`, it uses `examples/demo-game/`: `deno task cli status` works from the
 * repository's root.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join, relative } from "node:path";
import { run } from "../packages/cli/src/run.ts";
import { findConfig } from "../packages/cli/src/config.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const DEMO = join(ROOT, "examples", "demo-game");
export const DEV_URL = "http://localhost:8000";

/** The environment for the CLI: the development server and key, unless already set. */
export async function devEnv(
  env: Record<string, string>,
  readKey: () => Promise<string | null>,
): Promise<Record<string, string>> {
  const result = { ...env };
  if (!result.QUASO_HOSTNAME) result.QUASO_HOSTNAME = DEV_URL;
  if (!result.QUASO_API_KEY) {
    const key = await readKey();
    if (key) result.QUASO_API_KEY = key;
  }
  return result;
}

/** The arguments, with `--cwd examples/demo-game` when no project is chosen or found. */
export async function devArgs(args: string[], cwd: string): Promise<string[]> {
  const chosen = args.some(
    (arg) =>
      arg === "--cwd" ||
      arg.startsWith("--cwd=") ||
      arg === "--config" ||
      arg.startsWith("--config="),
  );
  const init = args.find((arg) => !arg.startsWith("-")) === "init";
  if (chosen || init || (await findConfig(cwd)) !== null) return args;
  return ["--cwd", DEMO, ...args];
}

async function readDevKey(): Promise<string | null> {
  try {
    return (await fs.readFile(join(ROOT, ".quaso", "dev-api-key"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const cwd = process.env["INIT_CWD"] ?? process.cwd();
  const originalArgs = process.argv.slice(2);
  const args = await devArgs(originalArgs, cwd);
  if (args !== originalArgs) {
    console.error(`(using ${relative(cwd, DEMO) || "."}: no quaso.config.json here)`);
  }
  const env = await devEnv(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    readDevKey,
  );
  process.exitCode = await run(args, { cwd, env });
}
