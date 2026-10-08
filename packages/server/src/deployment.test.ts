// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/** The actual server starts with a configured setup key, which never appears in logs. */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));
const DOMAIN = "translate.example.com";
const ORIGIN = `https://${DOMAIN}`;

/** The variables Deno itself needs (its cache, temporary files), none of Quaso's. */
function runtimeEnv(): Record<string, string> {
  const names = [
    "HOME",
    "PATH",
    "BUN_INSTALL",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "USERPROFILE",
    "SystemRoot",
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  return port;
}

test(
  "deployment: a fresh instance is claimed with the configured key, then used",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await Deno.makeTempDir();
    const port = freePort();
    const server = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--deny-net=generativelanguage.googleapis.com", MAIN, "serve"],
      // Exactly what .env needs, plus what the Docker image sets (and what Deno itself needs).
      env: {
        ...runtimeEnv(),
        QUASO_DOMAIN: DOMAIN,
        SETUP_KEY: "deployment-only-setup-key",
        DATA_DIR: join(dir, "data"),
        PORT: String(port),
      },
      clearEnv: true,
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const lines: string[] = [];
    const found = Promise.withResolvers<string>();
    const reading = (async () => {
      let buffer = "";
      for await (const chunk of server.stdout.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop()!;
        for (const line of parts) {
          lines.push(line);
          if (line.includes('"msg":"Listening"')) found.resolve("ready");
        }
      }
      found.reject(new Error(`Server never started:\n${lines.join("\n")}`));
    })();
    const errors = new Response(server.stderr).text();
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
      assertEquals(setup.status, 200, await setup.clone().text());
      assertEquals((await setup.json()).user.role, "administrator");
      const setCookie = setup.headers.getSetCookie()[0];
      assertMatch(setCookie, /; Secure$/);
      assertEquals(setup.headers.get("Strict-Transport-Security"), "max-age=31536000");
      const cookie = setCookie.split(";")[0];

      // Use it: an API key for the CLI, and an upload with it.
      const created = await fetch(`${base}/api-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({ name: "CI", scope: "upload" }),
      });
      assertEquals(created.status, 201, await created.clone().text());
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
      assertEquals(upload.status, 200, await upload.clone().text());
      assertEquals(
        (await upload.json()).added.map((ref: { key: string }) => ref.key),
        ["play"],
      );
      const exported = await fetch(`${base}/export`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      assertEquals((await exported.json()).files.length, 1);
      const project = await (await fetch(`${base}/project`)).json();
      assertEquals([project.name, project.details.members], ["Quaso Quest", 1]);

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
      assertEquals(again.status, 404);
      await again.body?.cancel();
    } finally {
      server.kill("SIGTERM");
      await server.status;
      await reading.catch(() => {});
      await errors;
      await fs.rm(dir, { recursive: true });
    }
  },
);
