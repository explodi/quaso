// SPDX-License-Identifier: MIT
/**
 * `npm run test:server`: runs the server as the image does, from outside the checkout, and
 * checks the website, the snapshot worker, backup extraction and a graceful stop.
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../packages/server/src/http/serve.ts";
import { createFolderStore } from "../packages/server/src/storage/folder_store.ts";
import { backupKey } from "@quaso/service";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "quaso-server-"));
const main = join(root, "packages/server/main.ts");
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dir,
  QUASO_DEV: "1",
  PORT: String(port),
  PUBLIC_URL: url,
};
let server: ReturnType<typeof spawn> | undefined;
let exited: Promise<{ code: number | null; stderr: string }> | undefined;
try {
  const seed = spawnSync(process.execPath, [main, "seed-dev"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  server = spawn(process.execPath, [main], { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr!.on("data", (chunk) => (stderr += chunk));
  exited = new Promise((done) => server!.once("exit", (code) => done({ code, stderr })));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`${url}/healthz`)).ok;
    } catch {
      /* Still starting. */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert(ready, "The server did not become healthy");
  const html = await (await fetch(url)).text();
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(script, "The server must serve the built website, not the placeholder");
  assert((await fetch(url + script)).ok, "The website's JavaScript must be readable");
  const login = await fetch(`${url}/auth/dev-login`, { redirect: "manual" });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const backup = await fetch(`${url}/api/v1/backup?format=sqlite`, { headers: { Cookie: cookie } });
  const bytes = new Uint8Array(await backup.arrayBuffer());
  assert.equal(backup.status, 200, new TextDecoder().decode(bytes));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 16)), "SQLite format 3\0");
  const key = backupKey(Date.UTC(2026, 9, 2), "sqlite");
  await createFolderStore(join(dir, "store")).write(key, bytes);
  const extracted = join(dir, "extracted.sqlite");
  const result = spawnSync(process.execPath, [main, "backup", key, extracted], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Uint8Array(await readFile(extracted)), bytes);
} finally {
  if (server) {
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server!.kill("SIGKILL"), 5000);
    const result = await exited!;
    clearTimeout(deadline);
    assert.equal(result.code, 0, result.stderr);
  }
  await rm(dir, { recursive: true, force: true });
}
console.log(
  "Server outside the checkout: HTTP, website, snapshot worker, backup extraction and graceful stop passed",
);
