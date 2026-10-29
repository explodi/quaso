// SPDX-License-Identifier: MIT
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
/**
 * `npm run dev` (design §5.13): the development server with the demo project.
 *
 * 1. Creates `.quaso/` (with `--reset`, deletes it first) and seeds the demo project on the
 *    first run (`quaso seed-dev`).
 * 2. Starts the server with `--watch`, which restarts it when server code changes, and
 *    Vite's dev server, which proxies `/api`, `/auth`, `/healthz` and `/schema` to
 *    it.
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
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
/** The server's port; `QUASO_SERVER_PORT` moves it when something else already has 8000. */
const PORT = Number(process.env["QUASO_SERVER_PORT"] ?? 8000);
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

/** How a child ended: its exit code, or the signal that stopped it. */
type Exit = { code: number | null; signal: NodeJS.Signals | null };

function node(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  return spawn(process.execPath, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function exited(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 1, signal: null }));
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
    console.error(".quaso/ has a database but no development key. Run: npm run dev:reset");
    return true;
  }
  console.log("Seeding the demo project into .quaso/ …");
  const { code } = await exited(node([SERVER, "seed-dev"], { env }));
  const success = code === 0;
  if (!success) console.error("Seeding failed. To start again: npm run dev:reset");
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

  const server = node(["--watch", SERVER, "serve"], { env });
  const web = node([VITE, "--strictPort"], {
    cwd: join(ROOT, "packages", "web"),
    env: { QUASO_DEV_SERVER: SERVER_URL },
  });
  const children = [server, web];
  const exits = children.map(exited);

  /** Why we stop: Ctrl-C, or the first child that exited. */
  let reason: "signal" | Exit | null = null;
  const stop = (why: "signal" | Exit) => {
    if (reason !== null) return;
    reason = why;
    // SIGINT, as Ctrl-C in a terminal: what `node --watch` and Vite expect.
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
  for (const exit of exits) exit.then(stop);

  waitForServer(60_000).then(async (ready) => {
    if (reason !== null) return;
    if (!ready) return console.error("The server didn't answer /healthz within a minute.");
    const key = await readKey();
    console.log(`\n  Quaso is running: ${WEBSITE}/auth/dev-login\n`);
    console.log("  That address signs the browser in as the developer (an administrator).\n");
    if (key) {
      console.log("  The development API key (upload scope), for the CLI:");
      console.log(
        `    QUASO_HOSTNAME=http://localhost:${PORT} QUASO_API_KEY=${key} npm run cli status\n`,
      );
    }
  });

  await Promise.all(exits);
  const why = reason as "signal" | Exit | null;
  process.exit(why === "signal" || why?.code === 0 ? 0 : why?.code || 1);
}
