// SPDX-License-Identifier: MIT
/** Run the Beta 2 workflow against the production image with Gemini isolated on a private network. */
import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { openBrowser } from "../e2e/_setup.ts";
import { freePort } from "../packages/server/src/http/serve.ts";
import { runWorkflow } from "../acceptance/workflow.ts";
import { expect } from "vitest";

const execFile = promisify(execFileCallback);

const image = process.argv[2] ?? "quaso:dev";
const name = `quaso-workflow-${crypto.randomUUID()}`;
const certs = await mkdtemp(join(tmpdir(), name));
const setupKey = "workflow-only-setup-key";
const email = "workflow@example.com";
const password = "workflow-only-password";
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
async function run(command: string[]) {
  try {
    const { stdout } = await execFile(command[0], command.slice(1), { timeout: 120_000 });
    return stdout.trim();
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(`${command[0]} ${command[1]} failed: ${stderr ?? error}`, { cause: error });
  }
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
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("Workflow container did not become healthy");
}
try {
  // A CA that signs the stub's certificate, as on the real host: some TLS stacks refuse a
  // self-signed certificate that is its own CA.
  const stubHost = "generativelanguage.googleapis.com";
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
    "/CN=Quaso workflow CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    join(certs, "ca-key.pem"),
    "-out",
    join(certs, "ca.pem"),
  ]);
  await run([
    "openssl",
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${stubHost}`,
    "-keyout",
    join(certs, "key.pem"),
    "-out",
    join(certs, "stub.csr"),
  ]);
  await writeFile(
    join(certs, "stub.ext"),
    `subjectAltName=DNS:${stubHost}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  await run([
    "openssl",
    "x509",
    "-req",
    "-in",
    join(certs, "stub.csr"),
    "-CA",
    join(certs, "ca.pem"),
    "-CAkey",
    join(certs, "ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    join(certs, "stub.ext"),
    "-out",
    join(certs, "cert.pem"),
  ]);
  await chmod(certs, 0o755);
  // The stub runs as a non-root user and reads its key from the mount.
  await chmod(join(certs, "key.pem"), 0o644);
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
    "--user",
    "node",
    "node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39",
    "node",
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
    `${join(certs, "ca.pem")}:/ca.pem:ro`,
    "-e",
    "NODE_EXTRA_CA_CERTS=/ca.pem",
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
  expect(setup.status).toBe(200);
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
  expect(key.status).toBe(200);
  const browser = await openBrowser();
  try {
    const result = await runWorkflow({ url, browser, email, password, step: console.log });
    expect(result.job.progress.translated).toBe(54);
    const stats = await (await fetch(await origin(`${name}-stub`, 8080))).json();
    expect(stats.requests).toBe(45);
    expect(stats.missingReferences).toBe(0);
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
