// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "@std/expect";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CloudflareApi,
  connectCloudflare,
  type WranglerRun,
} from "../packages/cloudflare/scripts/cloudflare_api.ts";
import { readInstanceConfig } from "../packages/cloudflare/scripts/instance_config.ts";
import { setup, setupOptions } from "../packages/cloudflare/scripts/setup.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DATABASE = "12345678-1234-1234-1234-123456789abc";
const NAME = "quaso-staging";
const ROOT = `/accounts/${ACCOUNT}`;
const IDENTITY = { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Example account" }] };
const IMAGE = "example/quaso:1.0.0-beta.2";
const envelope = (result: unknown) => Response.json({ success: true, result });

function harness(directory: string) {
  const state = {
    paid: true,
    zones: [{ name: "example.com", status: "active", paused: false }],
    databases: [] as { uuid: string; name: string }[],
    bucket: false,
    worker: false,
    secrets: [] as string[],
    healthy: false,
    deploymentCode: 0,
    uploadSecrets: true,
    bucketStatus: 404,
    users: 0,
    requests: [] as { path: string; method: string; body: any }[],
    commands: [] as string[][],
    messages: [] as string[],
    uploadedSecrets: {} as Record<string, string>,
    configPaths: [] as string[],
  };
  const api = new CloudflareApi({ type: "oauth", token: "test-token-private" }, (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.requests.push({ path, method, body });
    if (path === `${ROOT}/containers/me`)
      return envelope({
        limits: { total_vcpu: state.paid ? 10 : 0, total_memory_mib: state.paid ? 4096 : 0 },
      });
    if (path === "/zones") return envelope(state.zones);
    if (path === `${ROOT}/workers/scripts`) return envelope(state.worker ? [{ id: NAME }] : []);
    if (path === `${ROOT}/workers/scripts/${NAME}/secrets`)
      return envelope(state.secrets.map((name) => ({ name })));
    if (path === `${ROOT}/d1/database` && method === "GET") return envelope(state.databases);
    if (path === `${ROOT}/d1/database` && method === "POST") {
      state.databases.push({ uuid: DATABASE, name: body.name });
      return envelope(state.databases[0]);
    }
    if (path === `${ROOT}/d1/database/${DATABASE}/query`) {
      const count = body.sql.includes("sqlite_master") ? 1 : state.users;
      return envelope([{ results: [{ count }] }]);
    }
    if (path === `${ROOT}/r2/buckets/${NAME}-store`)
      return state.bucket
        ? envelope({ name: `${NAME}-store` })
        : Response.json(
            { success: false, errors: [{ code: 10006 }] },
            { status: state.bucketStatus },
          );
    if (path === `${ROOT}/r2/buckets` && method === "POST") {
      state.bucket = true;
      return envelope({ name: body.name });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  }) as typeof fetch);
  const run: WranglerRun = async (args) => {
    state.commands.push(args);
    const configPath = args[args.indexOf("--config") + 1];
    state.configPaths.push(configPath);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.env.staging.d1_databases[0].database_id).toBe(DATABASE);
    expect(config.env.staging.containers[0].image).toBe(`docker.io/${IMAGE}`);
    if (args[0] === "secret") {
      state.uploadedSecrets = JSON.parse(await fs.readFile(args[2], "utf8"));
      expect((await fs.stat(args[2])).mode & 0o777).toBe(0o600);
      if (state.uploadSecrets) state.secrets.push(...Object.keys(state.uploadedSecrets));
      state.worker = true;
      return { code: 0, stdout: "" };
    }
    expect(args[0]).toBe("deploy");
    state.healthy = state.deploymentCode === 0;
    return { code: state.deploymentCode, stdout: "" };
  };
  const options = setupOptions([
    "--env",
    "staging",
    "--account",
    ACCOUNT,
    "--hostname",
    "translate.example.com",
    "--location",
    "weur",
    "--image",
    IMAGE,
    "--instance-config",
    join(directory, "quaso.cloudflare.jsonc"),
  ]);
  const dependencies = {
    api,
    identity: IDENTITY,
    run,
    ask: async () => {
      throw new Error("Unexpected prompt");
    },
    fetch: async () =>
      Response.json(
        { ok: state.healthy, storage: "cloudflare", busy: false, nextWakeUp: null },
        { status: state.healthy ? 200 : 503 },
      ),
    print: (message: string) => {
      state.messages.push(message);
    },
    wait: async () => {},
  };
  return { state, options, dependencies };
}

describe("Cloudflare setup", () => {
  let directory: string;
  let fixture: ReturnType<typeof harness>;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "quaso-setup-test-"));
    fixture = harness(directory);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("creates storage, uploads keys privately, saves bindings and deploys a healthy instance", async () => {
    const result = await setup(fixture.options, fixture.dependencies);
    expect(result.checked).toBe(false);
    expect(
      fixture.state.requests.find(
        (request) => request.method === "POST" && request.path === `${ROOT}/d1/database`,
      )?.body,
    ).toEqual({ name: NAME, primary_location_hint: "weur" });
    expect(
      fixture.state.requests.find((request) => request.path === `${ROOT}/r2/buckets`)?.body,
    ).toEqual({ name: `${NAME}-store`, locationHint: "weur" });
    expect(fixture.state.commands.map((args) => args[0])).toEqual(["secret", "deploy"]);
    expect(fixture.state.uploadedSecrets.SECRET_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.state.uploadedSecrets.SETUP_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.state.messages.filter((message) => message.includes("Setup key"))).toEqual([
      `Setup key (save it now): ${fixture.state.uploadedSecrets.SETUP_KEY}`,
    ]);
    expect(fixture.state.messages.join("\n")).not.toContain(
      fixture.state.uploadedSecrets.SECRET_KEY,
    );
    const saved = await readInstanceConfig(fixture.options.configPath);
    expect(saved.environments.staging?.databaseId).toBe(DATABASE);
    expect((await fs.stat(fixture.options.configPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(fixture.options.configPath, "utf8")).not.toContain(
      fixture.state.uploadedSecrets.SETUP_KEY,
    );
    await expect(fs.stat(dirname(fixture.state.configPaths[0]))).rejects.toThrow();
  });

  test("healthy repeated setup preserves secrets and the operator file, with no deployment or resource mutation", async () => {
    await setup(fixture.options, fixture.dependencies);
    await fs.appendFile(fixture.options.configPath, "// keep my operator comment\n");
    const original = await fs.readFile(fixture.options.configPath, "utf8");
    fixture.state.requests = [];
    fixture.state.commands = [];
    fixture.state.messages = [];
    const result = await setup(fixture.options, fixture.dependencies);
    expect(result).toMatchObject({ checked: false, changed: false });
    expect(fixture.state.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fixture.state.commands).toEqual([]);
    expect(fixture.state.messages.join("\n")).not.toContain("Setup key");
    expect(await fs.readFile(fixture.options.configPath, "utf8")).toBe(original);
  });

  test("resumes a failed deployment without replacing keys or duplicating resources", async () => {
    fixture.state.deploymentCode = 7;
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow("Deployment failed");
    const key = fixture.state.uploadedSecrets.SETUP_KEY;
    await expect(fs.stat(dirname(fixture.state.configPaths[0]))).rejects.toThrow();
    fixture.state.deploymentCode = 0;
    fixture.state.requests = [];
    fixture.state.commands = [];
    fixture.state.messages = [];
    await setup(fixture.options, fixture.dependencies);
    expect(fixture.state.commands.map((args) => args[0])).toEqual(["deploy"]);
    expect(fixture.state.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fixture.state.uploadedSecrets.SETUP_KEY).toBe(key);
    expect(fixture.state.messages.join("\n")).not.toContain("Setup key");
  });

  test("check mode only reads eligibility and domains, without saving settings", async () => {
    expect(await setup({ ...fixture.options, check: true }, fixture.dependencies)).toEqual({
      checked: true,
    });
    expect(fixture.state.requests.map((request) => request.path)).toEqual([
      `${ROOT}/containers/me`,
      "/zones",
    ]);
    expect(fixture.state.commands).toEqual([]);
    await expect(fs.stat(fixture.options.configPath)).rejects.toThrow();
  });

  test("an aborted secret upload does not proceed to deployment and removes temporary secret files", async () => {
    fixture.state.uploadSecrets = false;
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow("not completed");
    expect(fixture.state.commands.map((args) => args[0])).toEqual(["secret"]);
    await expect(fs.stat(dirname(fixture.state.configPaths[0]))).rejects.toThrow();
    expect(fixture.state.messages.join("\n")).toContain(fixture.state.uploadedSecrets.SETUP_KEY);
  });

  test("rejects an unentitled account or an unrelated hostname before creating anything", async () => {
    fixture.state.paid = false;
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow("Workers Paid");
    expect(fixture.state.requests.every((request) => request.method === "GET")).toBe(true);
    fixture.state.paid = true;
    await expect(
      setup({ ...fixture.options, hostname: "translate.other.example" }, fixture.dependencies),
    ).rejects.toThrow("active domain");
    expect(fixture.state.databases).toEqual([]);
    expect(fixture.state.bucket).toBe(false);
  });

  test("does not hide a bucket permissions failure as a missing resource", async () => {
    fixture.state.bucketStatus = 403;
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow("HTTP 403");
    expect(
      fixture.state.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.path),
    ).toEqual([`${ROOT}/d1/database`]);
    expect(fixture.state.commands).toEqual([]);
    await expect(fs.stat(fixture.options.configPath)).rejects.toThrow();
  });

  test("reuses storage left by an interrupted first run", async () => {
    fixture.state.databases.push({ uuid: DATABASE, name: NAME });
    fixture.state.bucket = true;
    await setup(fixture.options, fixture.dependencies);
    expect(
      fixture.state.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.path),
    ).toEqual([`${ROOT}/d1/database/${DATABASE}/query`, `${ROOT}/d1/database/${DATABASE}/query`]);
    expect(fixture.state.commands.map((args) => args[0])).toEqual(["secret", "deploy"]);
  });

  test("refuses missing configured databases and missing signing keys for existing users", async () => {
    await setup(fixture.options, fixture.dependencies);
    fixture.state.databases = [];
    fixture.state.requests = [];
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow(
      "database is missing",
    );
    expect(fixture.state.requests.every((request) => request.method === "GET")).toBe(true);
    fixture.state.databases = [{ uuid: DATABASE, name: NAME }];
    fixture.state.secrets = ["SETUP_KEY"];
    fixture.state.users = 1;
    await expect(setup(fixture.options, fixture.dependencies)).rejects.toThrow(
      "Restore the existing key",
    );
    expect(fixture.state.commands.map((args) => args[0])).toEqual(["secret", "deploy"]);
  });

  test("validates setup options and refuses unknown targets", () => {
    expect(() => setupOptions(["--env", "dev"])).toThrow("staging or production");
    expect(() => setupOptions(["--env", "staging", "--env", "production"])).toThrow("once");
    expect(() => setupOptions(["--hostname"])).toThrow("needs a value");
    expect(() => setupOptions(["--config", "other.jsonc"])).toThrow("Unknown setup option");
  });

  test("does not provision an instance using the incompatible rc.1 release", async () => {
    await expect(
      setup({ ...fixture.options, image: undefined }, fixture.dependencies),
    ).rejects.toThrow("published image with --image");
    await expect(
      setup({ ...fixture.options, image: "example/quaso:1.0.0-rc.1" }, fixture.dependencies),
    ).rejects.toThrow("incompatible");
    expect(fixture.state.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fixture.state.commands).toEqual([]);
  });

  test("health checks reject a server using local ephemeral storage and still remove secret files", async () => {
    await expect(
      setup(fixture.options, {
        ...fixture.dependencies,
        fetch: async () =>
          Response.json({ ok: true, storage: "local", busy: false, nextWakeUp: null }),
      }),
    ).rejects.toThrow("not healthy");
    await expect(fs.stat(dirname(fixture.state.configPaths[0]))).rejects.toThrow();
    expect(
      (await readInstanceConfig(fixture.options.configPath)).environments.staging?.databaseId,
    ).toBe(DATABASE);
  });
});

test("Wrangler authentication logs in only when needed and keeps token output private", async () => {
  const calls: string[][] = [];
  const run: WranglerRun = async (args) => {
    calls.push(args);
    if (args[0] === "whoami")
      return {
        code: calls.length === 1 ? 1 : 0,
        stdout: JSON.stringify(calls.length === 1 ? { loggedIn: false } : IDENTITY),
      };
    if (args[0] === "login") return { code: 0, stdout: "" };
    return { code: 0, stdout: JSON.stringify({ type: "oauth", token: "private-test-token" }) };
  };
  const connection = await connectCloudflare(run);
  expect(connection.identity).toEqual(IDENTITY);
  expect(calls).toEqual([
    ["whoami", "--json"],
    ["login"],
    ["whoami", "--json"],
    ["auth", "token", "--json"],
  ]);
  await expect(
    connectCloudflare(async () => ({ code: 1, stdout: "network error" })),
  ).rejects.toThrow("network access");
});

test("Cloudflare API paginates lists and omits secret-bearing error text", async () => {
  const paths: string[] = [];
  const api = new CloudflareApi({ type: "api_token", token: "private-token" }, (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    paths.push(String(input));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
    if (new URL(String(input)).searchParams.get("page") === "1")
      return Response.json({
        success: true,
        result: [{ id: "first" }],
        result_info: { total_pages: 2 },
      });
    if (new URL(String(input)).searchParams.get("page") === "2")
      return Response.json({
        success: true,
        result: [{ id: "second" }],
        result_info: { total_pages: 2 },
      });
    return Response.json(
      { success: false, errors: [{ code: 10000, message: "private-token rejected" }] },
      { status: 403 },
    );
  }) as typeof fetch);
  expect(await api.list("/zones")).toEqual([{ id: "first" }, { id: "second" }]);
  expect(paths).toHaveLength(2);
  await expect(api.get("/error")).rejects.toThrow("HTTP 403; codes 10000");
  await expect(api.get("/error")).rejects.not.toThrow("private-token");
});
