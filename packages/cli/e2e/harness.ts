// SPDX-License-Identifier: MIT
/**
 * The CLI's end-to-end harness (S4.10, S4.11): a real server in this process (the server's
 * app and the real service on an in-memory database, on a random port), temporary copies of
 * the translation fixture, and the CLI run in-process or as the built bundle under Node.
 * Test code: it may start processes; the CLI never does.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeTranslator, type Service, SYSTEM, TimerScheduler } from "@quaso/service";
import { createApp } from "../../server/src/app.ts";
import { freePort, serve } from "../../server/src/http/serve.ts";
import { createLogger } from "../../server/src/log.ts";
import { demoDir } from "../../server/src/dev_seed.ts";
import { testConfig } from "../../server/src/testing/helpers.ts";
import { realService } from "../../server/src/testing/real_service.ts";
import { run } from "../src/run.ts";

export const DEMO_DIR = demoDir();
/** The demo's languages, as its config lists them. */
export const DEMO_LANGUAGES = ["de", "fr", "pl", "ja", "ar", "pt-BR"];
export const DEMO_FILES = ["common.json", "menus.json", "store.json"];

export interface TestServer {
  url: string;
  /** A key with the upload scope. */
  uploadKey: string;
  /** A key with the read scope. */
  readKey: string;
  close(): Promise<void>;
}

/**
 * Starts the server with a new in-memory database on a random port of 127.0.0.1. With
 * `llm`, the service has the fake translator and runs its jobs on timers, as a server does.
 */
export async function startServer(options: { llm?: boolean } = {}): Promise<TestServer> {
  let service: Service | null = null;
  /** The alarm run in progress, so that closing waits for it. */
  let running: Promise<void> = Promise.resolve();
  const scheduler = new TimerScheduler(() => {
    running = service?.alarm() ?? Promise.resolve();
    return running;
  });
  const real = await realService(
    options.llm ? { provider: createFakeTranslator(), scheduler } : {},
  );
  service = real.service;
  const upload = await real.service.createApiToken(SYSTEM, { name: "CLI e2e", scope: "upload" });
  const read = await real.service.createApiToken(SYSTEM, { name: "CLI e2e read", scope: "read" });
  const app = createApp({
    config: testConfig(),
    service: real.service,
    log: createLogger({ level: "error", write: () => {} }),
    version: "e2e",
  });
  const server = await serve({ hostname: "127.0.0.1", port: 0 }, (request, info) =>
    app(request, info),
  );
  return {
    url: `http://127.0.0.1:${server.port}`,
    uploadKey: upload.secret,
    readKey: read.secret,
    async close() {
      scheduler.stop();
      await server.shutdown();
      await running.catch(() => {});
      real.close();
    },
  };
}

/** An address where nothing listens: a port that was just free. */
export async function closedAddress(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}`;
}

/** A temporary folder, and a function that removes it. */
export async function tempDir(
  prefix = "quaso-cli-",
): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  return { dir, remove: () => fs.rm(dir, { recursive: true }).catch(() => {}) };
}

/** Copies the translation fixture into `parent` and returns the copy's folder. */
export async function copyDemo(parent: string, name = "demo-game"): Promise<string> {
  const target = join(parent, name);
  await fs.cp(DEMO_DIR, target, { recursive: true });
  return target;
}

/** SHA-256 of every file below a folder, by relative path. */
export async function hashFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const visit = async (folder: string, prefix: string) => {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        const digest = await crypto.subtle.digest("SHA-256", await fs.readFile(path));
        hashes.set(
          `${prefix}${entry.name}`,
          Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
        );
      }
    }
  };
  await visit(dir, "");
  return hashes;
}

/** What a CLI run printed and returned. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with arguments, in a folder, with only the given environment variables. */
export type Runner = (
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<CliRun>;

/** The CLI in this process, through `run()`; retries don't wait. */
export function inProcess(): Runner {
  return async (args, options) => {
    let stdout = "";
    let stderr = "";
    const code = await run(args, {
      cwd: options.cwd,
      env: { NO_COLOR: "1", ...options.env },
      stdout: { write: (text: string) => (stdout += text), isTTY: false },
      stderr: { write: (text: string) => (stderr += text), isTTY: false },
      sleep: () => Promise.resolve(),
    });
    return { code, stdout, stderr };
  };
}

/**
 * The built bundle, under `node` (by default the one that runs the tests). Asynchronous: the
 * CLI talks to the server in this process, which a blocked event loop couldn't answer.
 */
export function bundled(bundle: string, node = process.execPath): Runner {
  return (args, options) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("QUASO_") || name === "FORCE_COLOR") delete env[name];
    }
    const child = spawn(node, [bundle, ...args], {
      cwd: options.cwd,
      env: { ...env, NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  };
}

/** Parses the one JSON document of a `--json` run. */
export function jsonOf(result: CliRun): any {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `stdout isn't one JSON document (exit ${result.code}):\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
