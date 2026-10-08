// SPDX-License-Identifier: MIT
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname!, "../../..");
const cwd = resolve(root, "packages/cloudflare");
const upload = Deno.args.includes("--upload");
const prefix = `quaso-beta2-${upload ? "upload" : "batch"}-${Date.now()}`;
const name = `${prefix}-contractcontainer`;
const folderRoot = resolve(root, ".quaso");
await mkdir(folderRoot, { recursive: true });
const folder = await mkdtemp(resolve(folderRoot, "batch-smoke-"));
const configPath = resolve(folder, "wrangler.json");
const key = crypto.randomUUID();
let databaseCreated = false;
let deployAttempted = false;
let failure: unknown;
let report: { path: string; data: object } | undefined;
const cleanupFailures: unknown[] = [];

async function wrangler(args: string[], allowMissing = false): Promise<string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "npm:wrangler", ...args],
    cwd,
    stdin: "null",
  }).output();
  const decoder = new TextDecoder();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  if (!output.success) {
    const missing = /does not exist|not found/i.test(stdout + stderr);
    if (allowMissing && missing) return stdout;
    throw new Error(`wrangler ${args[0]}: ${stdout}\n${stderr}`);
  }
  return stdout;
}

try {
  console.log(`Creating ${prefix}`);
  const created = await wrangler(["d1", "create", prefix, "--location", "weur"]);
  databaseCreated = true;
  const id = /"database_id":\s*"([^"]+)"/.exec(created)?.[1];
  if (!id) throw new Error("Wrangler did not return the database ID");
  const entry = resolve(cwd, upload ? "spike/upload_server.ts" : "spike/contract_server.ts");
  const bundle = await new Deno.Command(Deno.execPath(), {
    args: ["bundle", "--platform=deno", "--output", resolve(folder, "server.js"), entry],
  }).output();
  if (!bundle.success) throw new Error(new TextDecoder().decode(bundle.stderr));
  await writeFile(
    resolve(folder, "Dockerfile"),
    'FROM denoland/deno:2.9.6\nWORKDIR /probe\nCOPY server.js .\nEXPOSE 8000\nENTRYPOINT ["deno", "run", "-A", "server.js"]\n',
  );
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: prefix,
        main: resolve(cwd, "spike/contract_worker.ts"),
        compatibility_date: "2026-09-01",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        limits: { subrequests: 1000 },
        containers: [
          {
            class_name: "ContractContainer",
            image: resolve(folder, "Dockerfile"),
            image_build_context: folder,
            max_instances: 1,
            instance_type: "basic",
          },
        ],
        durable_objects: { bindings: [{ name: "CONTROLLER", class_name: "ContractContainer" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ContractContainer"] }],
        d1_databases: [{ binding: "DB", database_name: prefix, database_id: id }],
      },
      null,
      2,
    ),
  );
  const secretPath = resolve(folder, "secrets.json");
  await writeFile(secretPath, JSON.stringify({ TEST_KEY: key }), { mode: 0o600 });
  console.log("Deploying container contract test");
  deployAttempted = true;
  const deployed = await wrangler(["deploy", "--config", configPath, "--secrets-file", secretPath]);
  const url = /https:\/\/[^\s]+\.workers\.dev/.exec(deployed)?.[0];
  if (!url) throw new Error("Wrangler did not return the Worker URL");
  console.log("Waiting for the new workers.dev route");
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const readiness = await fetch(`${url}/ready`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const result = await readiness.json().catch(() => null);
    if (readiness.ok && result?.ready === true) {
      ready = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  if (!ready) throw new Error("The new workers.dev route did not become ready within two minutes");
  console.log("Waiting for container provisioning");
  ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const readiness = await fetch(`${url}/container-ready`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const result = await readiness?.json().catch(() => null);
    if (readiness?.ok && result?.ready === true) {
      ready = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 5000));
  }
  if (!ready) throw new Error("The container did not become ready");
  console.log("Running shared cases from the container");
  const response = await fetch(`${url}/${upload ? "upload" : "contract"}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  let result: { passed: string[] };
  try {
    result = JSON.parse(body);
  } catch {
    const fallback = /id="__bunfallback"[^>]*>(.*?)<\/script>/s.exec(body)?.[1];
    throw new Error(
      `Container returned HTTP ${response.status}: ${fallback ?? body.slice(0, 2000)}`,
    );
  }
  const evidence = resolve(root, ".quaso/beta-2-evidence");
  await mkdir(evidence, { recursive: true });
  const evidencePath = resolve(evidence, upload ? "d1-upload.json" : "d1-contract.json");
  Object.assign(result, {
    resourcePrefix: prefix,
    deployment: {
      databaseLocationHint: "weur",
      containerLocationHint: "weur",
      instanceType: "basic",
      subrequestLimit: 1000,
    },
  });
  report = { path: evidencePath, data: result };
  await writeFile(
    evidencePath,
    JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2) + "\n",
  );
  if (!response.ok) throw new Error(JSON.stringify(result));
  if (upload) {
    console.log("Probing deployed D1 limits");
    const limits = [];
    for (const query of [
      "batch=1000",
      "batch=1001",
      "invocation=1000",
      "invocation=1001",
      "params=100",
      "params=101",
      "length=100000",
      "length=100001",
    ]) {
      const probe = await fetch(`${url}/limits?${query}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await probe.text();
      const detail = JSON.parse(body);
      limits.push({ query, ...detail });
      Object.assign(result, { limits });
      await writeFile(
        evidencePath,
        JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2) + "\n",
      );
    }
    Object.assign(result, { limits });
  }
  await writeFile(
    evidencePath,
    JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  failure = error;
} finally {
  console.log(`Cleaning ${prefix}`);
  // Continue every cleanup step even if one resource could not be removed.
  async function clean(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (deployAttempted) {
    await clean(async () => {
      const containers = await wrangler(["containers", "list"]);
      const line = containers.split("\n").find((line) => line.includes(name));
      const id = line?.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0];
      if (id) await wrangler(["containers", "delete", id]);
    });
    await clean(() => wrangler(["delete", prefix, "--config", configPath], true));
    await clean(async () => {
      const images = await wrangler(["containers", "images", "list"]);
      for (const line of images.split("\n")) {
        const [repository, tag] = line.trim().split(/\s+/);
        if (repository === name && tag)
          await wrangler(["containers", "images", "delete", `${repository}:${tag}`]);
      }
    });
  }
  if (databaseCreated) await clean(() => wrangler(["d1", "delete", prefix, "--skip-confirmation"]));
  await clean(async () => {
    const images = await new Deno.Command("docker", {
      args: ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
    }).output();
    if (!images.success) throw new Error("Could not inspect local probe images");
    const tags = new TextDecoder()
      .decode(images.stdout)
      .split("\n")
      .filter((tag) => tag.includes(name));
    for (const tag of tags) {
      const removed = await new Deno.Command("docker", {
        args: ["image", "rm", tag],
        stdout: "null",
      }).output();
      if (!removed.success) throw new Error(`Could not remove local image ${tag}`);
    }
  });
  await clean(async () => {
    for (const args of [
      ["d1", "list"],
      ["containers", "list"],
      ["containers", "images", "list"],
    ]) {
      if ((await wrangler(args)).includes(prefix))
        throw new Error(`Probe remains in ${args.join(" ")}`);
    }
  });
  await clean(() => rm(folder, { recursive: true, force: true }));
  if (cleanupFailures.length === 0) {
    if (report)
      await writeFile(
        report.path,
        JSON.stringify(
          { testedAt: new Date().toISOString(), ...report.data, cleanupVerified: true },
          null,
          2,
        ) + "\n",
      );
    console.log("Cleanup complete");
  }
}

if (cleanupFailures.length) {
  throw new AggregateError(
    [failure, ...cleanupFailures].filter(Boolean),
    `Cleanup incomplete for ${prefix}`,
  );
}
if (failure !== undefined) throw failure;
