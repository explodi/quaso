// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * `deno task dev` (design §5.13): the development server with the demo project.
 *
 * 1. Creates `.quaso/` (with `--reset`, deletes it first) and seeds the demo project on the
 *    first run (`quaso seed-dev`).
 * 2. Starts the server with `--watch`, which restarts it when server code changes, and
 *    Vite's dev server, which proxies `/api`, `/auth`, `/config.json`, `/healthz` and
 *    `/schema` to it.
 * 3. Waits for `/healthz`, then prints the one address to open, which signs the browser in
 *    as the developer account (`/auth/dev-login`), and the development API key.
 *
 * Ctrl-C stops both; if either stops, so does the other.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const DATA_DIR = join(ROOT, ".quaso");
const SERVER = "packages/server/main.ts";
const PORT = 8000;
const WEBSITE = `http://localhost:${process.env["QUASO_WEB_PORT"] ?? 5173}`;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

/**
 * `PUBLIC_URL` is Vite's address: links (email, OAuth callbacks, the dev sign-in's
 * redirect) lead to the website, which proxies `/api` and `/auth` to the server.
 */
const env = { QUASO_DEV: "1", DATA_DIR, PORT: String(PORT), PUBLIC_URL: WEBSITE };

async function exists(path: string): Promise<boolean> {
  return await fs.stat(path).then(
    () => true,
    () => false,
  );
}

function deno(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: options.cwd ?? ROOT,
    env: options.env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
}

/** Seeds `.quaso/` if it has no project yet. Returns false if that failed. */
async function prepare(reset: boolean): Promise<boolean> {
  if (reset && (await exists(DATA_DIR))) {
    await fs.rm(DATA_DIR, { recursive: true });
    console.log("Deleted .quaso/");
  }
  if (await exists(join(DATA_DIR, "dev-api-key"))) return true;
  if (await exists(join(DATA_DIR, "quaso.sqlite"))) {
    console.error(".quaso/ has a database but no development key. Run: deno task dev:reset");
    return true;
  }
  console.log("Seeding the demo project into .quaso/ …");
  const { success } = await deno(["run", "-A", SERVER, "seed-dev"], { env }).spawn().status;
  if (!success) console.error("Seeding failed. To start again: deno task dev:reset");
  return success;
}

/** Waits until the server answers `/healthz`, or the timeout passes. */
async function waitForServer(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${SERVER_URL}/healthz`);
      await response.body?.cancel();
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

async function readKey(): Promise<string | null> {
  try {
    return (await fs.readFile(join(DATA_DIR, "dev-api-key"), "utf8")).trim();
  } catch {
    return null;
  }
}

if (import.meta.main) {
  if (!(await prepare(process.argv.slice(2).includes("--reset")))) process.exit(1);

  const server = deno(["run", "-A", "--watch", SERVER, "serve"], { env }).spawn();
  const web = deno(["run", "-A", "npm:vite", "--strictPort"], {
    cwd: join(ROOT, "packages", "web"),
    env: { QUASO_DEV_SERVER: SERVER_URL },
  }).spawn();
  const children = [server, web];

  /** Why we stop: Ctrl-C, or the first child that exited. */
  let reason: "signal" | Deno.CommandStatus | null = null;
  const stop = (why: "signal" | Deno.CommandStatus) => {
    if (reason !== null) return;
    reason = why;
    // SIGINT, as Ctrl-C in a terminal: what `deno run --watch` and Vite expect.
    for (const child of children) {
      try {
        child.kill("SIGINT");
      } catch {
        // Already gone.
      }
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      process.on(signal, () => stop("signal"));
    } catch {
      // Windows has no SIGTERM.
    }
  }
  for (const child of children) child.status.then(stop);

  waitForServer(60_000).then(async (ready) => {
    if (reason !== null) return;
    if (!ready) return console.error("The server didn't answer /healthz within a minute.");
    const key = await readKey();
    console.log(`\n  Quaso is running: ${WEBSITE}/auth/dev-login\n`);
    console.log("  That address signs the browser in as the developer (an administrator).\n");
    if (key) {
      console.log("  The development API key (upload scope), for the CLI:");
      console.log(
        `    QUASO_HOSTNAME=http://localhost:${PORT} QUASO_API_KEY=${key} deno task cli status\n`,
      );
    }
  });

  await Promise.all(children.map((child) => child.status));
  const why = reason as "signal" | Deno.CommandStatus | null;
  process.exit(why === "signal" || why?.success ? 0 : why?.code || 1);
}
