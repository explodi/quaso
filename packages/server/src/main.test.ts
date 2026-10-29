// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import { freePort } from "./http/serve.ts";
/**
 * The `quaso` commands, run as the real program in a temporary data folder: the start
 * checks, `seed-dev`, `serve` with its lock and graceful shutdown, `healthcheck` and
 * `token create`.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { healthcheck, parseFlags } from "./commands.ts";
import { VERSION } from "./version.ts";

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));

function run(args: string[], env: Record<string, string>, cwd: string) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [MAIN, ...args], {
    env: { ...process.env, LOG_LEVEL: "info", ...env },
    cwd,
    encoding: "utf8",
  });
  return { code: status, stdout, stderr };
}

async function waitForServer(port: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/healthz`)).body?.cancel();
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("The server didn't start.");
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

test("commands: flags", () => {
  expect(parseFlags(["--name", "CI", "--scope=read", "--dry-run"])).toStrictEqual({
    name: "CI",
    scope: "read",
    "dry-run": "",
  });
});

test("commands: version, unknown commands and bad settings", () =>
  withTempDir(async (dir) => {
    expect((await run(["version"], {}, dir)).stdout.trim()).toStrictEqual(VERSION);
    expect((await run(["nope"], {}, dir)).code).toBe(2);
    const bad = await run(["serve"], { PORT: "eighty", LOG_LEVEL: "loud" }, dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Quaso can't start, because of its settings:");
    expect(bad.stderr).toContain('PORT must be a whole number from 1 to 65535, not "eighty".');
    expect(bad.stderr).toContain("LOG_LEVEL must be one of");
    const cloudflare = await run(["seed-dev"], { QUASO_DEV: "1", QUASO_CLOUDFLARE: "1" }, dir);
    expect(cloudflare.code).toBe(2);
    expect(cloudflare.stderr).toContain("seed-dev only seeds local storage");
    const token = await run(["token", "create", "--scope", "admin"], { DATA_DIR: dir }, dir);
    expect(token.code).toBe(2);
    expect(token.stderr).toContain("--name: is required");
  }));

test(
  "commands: seed-dev, serve, healthcheck and token create, on one data folder",
  { skip: process.platform === "win32" },
  () =>
    withTempDir(async (dir) => {
      const dataDir = join(dir, "data");
      const port = String(await freePort());
      const env = { DATA_DIR: dataDir, PORT: port, WEB_DIR: join(dir, "no-website") };

      expect((await run(["seed-dev"], env, dir)).code).toBe(2);
      const seeded = await run(["seed-dev"], { ...env, QUASO_DEV: "1" }, dir);
      expect(seeded.code, seeded.stderr).toBe(0);
      expect(seeded.stderr).toContain("Seeded the demo project");
      const devKey = (await fs.readFile(join(dataDir, "dev-api-key"), "utf8")).trim();
      expect(devKey).toMatch(/^qso_/);
      const again = await run(["seed-dev"], { ...env, QUASO_DEV: "1" }, dir);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("already has a project");

      const server = spawn(process.execPath, [MAIN, "serve"], {
        env: { ...process.env, LOG_LEVEL: "info", ...env },
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      server.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      const exited = once(server, "close");
      try {
        await waitForServer(port);
        expect(await healthcheck({ PORT: port })).toBe(0);
        const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
          headers: { Authorization: `Bearer ${devKey}` },
        });
        expect(status.status).toBe(200);
        expect((await status.json()).languages.length).toBe(6);

        const busy = await run(["token", "create", "--name", "CI", "--scope", "read"], env, dir);
        expect(busy.code).toBe(1);
        expect(busy.stderr).toContain(`Another Quaso server is using ${dataDir}.`);
        expect(busy.stderr).toContain("Stop it first");
      } finally {
        server.kill("SIGTERM");
      }
      const [code] = await exited;
      expect(code).toBe(0);
      const logs = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const messages = logs.map((line) => line.msg);
      assert(messages.includes("Listening"), messages.join(", "));
      expect(messages.slice(-2)).toStrictEqual(["Shutting down", "Stopped"]);
      assert(logs.some((line) => line.msg === "request" && line.path === "/api/v1/status"));
      expect(await healthcheck({ PORT: port })).toBe(1);

      const created = await run(["token", "create", "--name", "CI", "--scope", "read"], env, dir);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toMatch(/^qso_\S+\n$/);
      expect(created.stderr).toContain('Created the API key "CI" with the read scope.');
    }),
);
