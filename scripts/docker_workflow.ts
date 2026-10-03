// SPDX-License-Identifier: MIT
/** Run the Beta 2 workflow against the production image with Gemini isolated on a private network. */
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertEquals } from "@quaso/runtime/assert";
import { openBrowser } from "../e2e/_setup.ts";
import { runWorkflow } from "../acceptance/workflow.ts";

const image = process.argv[2] ?? "quaso:dev";
const name = `quaso-workflow-${crypto.randomUUID()}`;
const certs = await mkdtemp(join(tmpdir(), name));
const setupKey = "workflow-only-setup-key";
const email = "workflow@example.com";
const password = "workflow-only-password";
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const port = reservation.port;
await reservation.stop(true);
const url = `http://127.0.0.1:${port}`;
async function run(command: string[]) {
  const process = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(120_000),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed: ${stderr}`);
  return stdout.trim();
}
async function origin(container: string, port: number) {
  return `http://${await run(["docker", "port", container, String(port)])}`;
}
async function ready(url: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      /* Container is starting. */
    }
    await Bun.sleep(500);
  }
  throw new Error("Workflow container did not become healthy");
}
try {
  await run([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=generativelanguage.googleapis.com",
    "-addext",
    "subjectAltName=DNS:generativelanguage.googleapis.com",
    "-keyout",
    join(certs, "key.pem"),
    "-out",
    join(certs, "cert.pem"),
  ]);
  await chmod(certs, 0o755);
  await run(["docker", "network", "create", name]);
  await run([
    "docker",
    "run",
    "-d",
    "--name",
    `${name}-stub`,
    "--network",
    name,
    "--network-alias",
    "generativelanguage.googleapis.com",
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${certs}:/certs:ro`,
    "-v",
    `${resolve("scripts/workflow_gemini_stub.ts")}:/stub.ts:ro`,
    "oven/bun:1.4.2",
    "bun",
    "/stub.ts",
  ]);
  await run([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--network",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/data:uid=65532,gid=65532",
    "-p",
    `127.0.0.1:${port}:8000`,
    "-v",
    `${join(certs, "cert.pem")}:/cert.pem:ro`,
    "-e",
    "NODE_EXTRA_CA_CERTS=/cert.pem",
    "-e",
    "TRUST_PROXY=false",
    "-e",
    `PUBLIC_URL=${url}`,
    "--dns",
    "127.0.0.1",
    "-e",
    `SETUP_KEY=${setupKey}`,
    image,
  ]);
  await ready(url);
  const setup = await fetch(`${url}/api/v1/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({
      token: setupKey,
      email,
      password,
      displayName: "Workflow Owner",
      projectName: "Workflow",
    }),
  });
  assertEquals(setup.status, 200);
  const cookie = setup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const key = await fetch(`${url}/api/v1/settings/secrets/gemini_api_key`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: url,
      Cookie: cookie,
    },
    body: JSON.stringify({ value: "workflow-only-key" }),
  });
  assertEquals(key.status, 200);
  const browser = await openBrowser();
  try {
    const result = await runWorkflow({ url, browser, email, password, step: console.log });
    assertEquals(result.job.progress.translated, 54);
    const stats = await (await fetch(await origin(`${name}-stub`, 8080))).json();
    assertEquals(stats.requests, 45);
    assertEquals(stats.missingReferences, 0);
    console.log(
      `Production Docker workflow passed; ${stats.requests} Gemini requests included proofread Spanish.`,
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(
    (await run(["docker", "logs", name]).catch(() => ""))
      .split("\n")
      .filter((line) => !line.includes('"msg":"request"'))
      .join("\n"),
  );
  console.error(
    await fetch(await origin(`${name}-stub`, 8080))
      .then((response) => response.text())
      .catch(() => ""),
  );
  console.error(await run(["docker", "logs", `${name}-stub`]).catch(() => ""));
  throw error;
} finally {
  await run(["docker", "rm", "-f", name, `${name}-stub`]).catch(() => {});
  await run(["docker", "network", "rm", name]).catch(() => {});
  await rm(certs, { recursive: true, force: true });
}
