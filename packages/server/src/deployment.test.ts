// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import { freePort } from "./http/serve.ts";
/** The actual server starts with a configured setup key, which never appears in logs. */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));
const DOMAIN = "translate.example.com";
const ORIGIN = `https://${DOMAIN}`;

/** The variables Node itself needs (its temporary files), none of Quaso's. */
function runtimeEnv(): Record<string, string> {
  const names = ["HOME", "PATH", "TMPDIR", "USERPROFILE", "SystemRoot"];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

test(
  "deployment: a fresh instance is claimed with the configured key, then used",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
    const port = await freePort();
    const server = spawn(process.execPath, [MAIN, "serve"], {
      // Exactly what .env needs, plus what the Docker image sets (and what Node itself needs).
      env: {
        ...runtimeEnv(),
        QUASO_DOMAIN: DOMAIN,
        SETUP_KEY: "deployment-only-setup-key",
        DATA_DIR: join(dir, "data"),
        PORT: String(port),
      },
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(server, "close");
    const lines: string[] = [];
    const found = Promise.withResolvers<string>();
    let buffer = "";
    server.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const line of parts) {
        lines.push(line);
        if (line.includes('"msg":"Listening"')) found.resolve("ready");
      }
    });
    server.stdout.on("end", () =>
      found.reject(new Error(`Server never started:\n${lines.join("\n")}`)),
    );
    server.stderr.resume();
    try {
      await Promise.race([
        found.promise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000)),
      ]);
      const token = "deployment-only-setup-key";
      assert(
        lines.every((line) => !line.includes(token)),
        "the setup key never appears in logs",
      );
      const base = `http://127.0.0.1:${port}/api/v1`;

      // Claim it: the first administrator, signed in with a Secure cookie.
      const setup = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          token,
          email: "owner@example.com",
          password: "correct horse battery",
          displayName: "Owner",
          projectName: "Quaso Quest",
        }),
      });
      expect(setup.status, await setup.clone().text()).toBe(200);
      expect((await setup.json()).user.role).toBe("administrator");
      const setCookie = setup.headers.getSetCookie()[0];
      expect(setCookie).toMatch(/; Secure$/);
      expect(setup.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
      const cookie = setCookie.split(";")[0];

      // Use it: an API key for the CLI, and an upload with it.
      const created = await fetch(`${base}/api-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({ name: "CI", scope: "upload" }),
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const { secret } = await created.json();
      const upload = await fetch(`${base}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          files: [
            { path: "common.json", repoPath: "common.json", content: '{\n  "play": "Play"\n}\n' },
          ],
          languages: ["fr"],
        }),
      });
      expect(upload.status, await upload.clone().text()).toBe(200);
      expect((await upload.json()).added.map((ref: { key: string }) => ref.key)).toStrictEqual([
        "play",
      ]);
      const exported = await fetch(`${base}/export`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect((await exported.json()).files.length).toBe(1);
      const project = await (await fetch(`${base}/project`)).json();
      expect([project.name, project.details.members]).toStrictEqual(["Quaso Quest", 1]);

      // The link works once only.
      const again = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          token,
          email: "intruder@example.com",
          password: "correct horse battery",
          displayName: "Intruder",
          projectName: "Mine",
        }),
      });
      expect(again.status).toBe(404);
      await again.body?.cancel();
    } finally {
      server.kill("SIGTERM");
      await exited;
      await fs.rm(dir, { recursive: true });
    }
  },
);
