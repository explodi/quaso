// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { Command } from "@quaso/runtime/command";
import { makeTempDir } from "@quaso/runtime/files";
import { test } from "node:test";
/**
 * The `quaso` commands, run as the real program in a temporary data folder: the start
 * checks, `seed-dev`, `serve` with its lock and graceful shutdown, `healthcheck` and
 * `token create`.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@quaso/runtime/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { healthcheck, parseFlags } from "./commands.ts";
import { VERSION } from "./version.ts";

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));
const decoder = new TextDecoder();

function command(args: string[], env: Record<string, string>, cwd: string): Command {
  return new Command(process.execPath, {
    args: ["run", MAIN, ...args],
    env: { LOG_LEVEL: "info", ...env },
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
}

async function run(args: string[], env: Record<string, string>, cwd: string) {
  const { code, stdout, stderr } = await command(args, env, cwd).output();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = { port: listener.port }.port;
  listener.stop();
  return port;
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
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

test("commands: flags", () => {
  assertEquals(parseFlags(["--name", "CI", "--scope=read", "--dry-run"]), {
    name: "CI",
    scope: "read",
    "dry-run": "",
  });
});

test("commands: version, unknown commands and bad settings", () =>
  withTempDir(async (dir) => {
    assertEquals((await run(["version"], {}, dir)).stdout.trim(), VERSION);
    assertEquals((await run(["nope"], {}, dir)).code, 2);
    const bad = await run(["serve"], { PORT: "eighty", LOG_LEVEL: "loud" }, dir);
    assertEquals(bad.code, 1);
    assertStringIncludes(bad.stderr, "Quaso can't start, because of its settings:");
    assertStringIncludes(bad.stderr, 'PORT must be a whole number from 1 to 65535, not "eighty".');
    assertStringIncludes(bad.stderr, "LOG_LEVEL must be one of");
    // Cloudflare storage runs in storage/remote.test.ts; seed-dev only seeds local storage.
    const remote = await run(
      ["seed-dev"],
      {
        QUASO_DEV: "1",
        SERVICES_URL: "https://quaso.example.workers.dev",
        SERVICE_TOKEN: "token",
        SECRET_KEY: "s".repeat(64),
      },
      dir,
    );
    assertEquals(remote.code, 2);
    assertStringIncludes(remote.stderr, "seed-dev only seeds local storage");
    const token = await run(["token", "create", "--scope", "admin"], { DATA_DIR: dir }, dir);
    assertEquals(token.code, 2);
    assertStringIncludes(token.stderr, "--name: is required");
  }));

test(
  "commands: seed-dev, serve, healthcheck and token create, on one data folder",
  { skip: process.platform === "win32" },
  () =>
    withTempDir(async (dir) => {
      const dataDir = join(dir, "data");
      const port = String(freePort());
      const env = { DATA_DIR: dataDir, PORT: port, WEB_DIR: join(dir, "no-website") };

      assertEquals((await run(["seed-dev"], env, dir)).code, 2);
      const seeded = await run(["seed-dev"], { ...env, QUASO_DEV: "1" }, dir);
      assertEquals(seeded.code, 0, seeded.stderr);
      assertStringIncludes(seeded.stderr, "Seeded the demo project");
      const devKey = (await fs.readFile(join(dataDir, "dev-api-key"), "utf8")).trim();
      assertMatch(devKey, /^qso_/);
      const again = await run(["seed-dev"], { ...env, QUASO_DEV: "1" }, dir);
      assertEquals(again.code, 1);
      assertStringIncludes(again.stderr, "already has a project");

      const server = command(["serve"], env, dir).spawn();
      try {
        await waitForServer(port);
        assertEquals(await healthcheck({ PORT: port }), 0);
        const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
          headers: { Authorization: `Bearer ${devKey}` },
        });
        assertEquals(status.status, 200);
        assertEquals((await status.json()).languages.length, 6);

        const busy = await run(["token", "create", "--name", "CI", "--scope", "read"], env, dir);
        assertEquals(busy.code, 1);
        assertStringIncludes(busy.stderr, `Another Quaso server is using ${dataDir}.`);
        assertStringIncludes(busy.stderr, "Stop it first");
      } finally {
        server.kill("SIGTERM");
      }
      const { code, stdout } = await server.output();
      assertEquals(code, 0);
      const logs = decoder
        .decode(stdout)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const messages = logs.map((line) => line.msg);
      assert(messages.includes("Listening"), messages.join(", "));
      assertEquals(messages.slice(-2), ["Shutting down", "Stopped"]);
      assert(logs.some((line) => line.msg === "request" && line.path === "/api/v1/status"));
      assertEquals(await healthcheck({ PORT: port }), 1);

      const created = await run(["token", "create", "--name", "CI", "--scope", "read"], env, dir);
      assertEquals(created.code, 0, created.stderr);
      assertMatch(created.stdout, /^qso_\S+\n$/);
      assertStringIncludes(created.stderr, 'Created the API key "CI" with the read scope.');
    }),
);
