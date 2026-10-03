// SPDX-License-Identifier: MIT
/** Exercises embedded assets and the snapshot worker without the checkout as cwd. */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "@quaso/runtime/command";
import { createFolderStore } from "../packages/server/src/storage/folder_store.ts";
import { backupKey } from "@quaso/service";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "quaso-binary-"));
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = listener.port;
listener.stop();
const url = `http://127.0.0.1:${port}`;
const env = {
  DATA_DIR: dir,
  QUASO_DEV: "1",
  PORT: String(port),
  PUBLIC_URL: url,
};
let server: ReturnType<Command["spawn"]> | undefined;
let output: ReturnType<ReturnType<Command["spawn"]>["output"]> | undefined;
try {
  const seed = await new Command(process.execPath, {
    args: [join(root, "packages/server/main.ts"), "seed-dev"],
    cwd: dir,
    env,
  }).output();
  assert.equal(seed.code, 0, new TextDecoder().decode(seed.stderr));
  const executable = process.platform === "win32" ? "quaso.exe" : "quaso";
  const binary = process.argv[2] ?? join(root, "dist", executable);
  server = new Command(binary, {
    cwd: dir,
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  output = server.output();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`${url}/healthz`)).ok;
    } catch {
      /* Still starting. */
    }
    if (ready) break;
    await Bun.sleep(50);
  }
  assert(ready, "The compiled server did not become healthy");
  const html = await (await fetch(url)).text();
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(script, "The binary must serve the embedded website, not the placeholder");
  assert((await fetch(url + script)).ok, "The embedded JavaScript must be readable");
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
  const result = await new Command(binary, {
    args: ["backup", key, extracted],
    cwd: dir,
    env,
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  assert.deepEqual(new Uint8Array(await readFile(extracted)), bytes);
} finally {
  if (server) {
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server!.kill("SIGKILL"), 5000);
    const result = await output!;
    clearTimeout(deadline);
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  }
  await rm(dir, { recursive: true, force: true });
}
console.log(
  "Compiled server: HTTP, embedded website, snapshot worker, backup extraction and graceful stop passed",
);
