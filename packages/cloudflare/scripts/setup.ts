// SPDX-License-Identifier: MIT
/** Provision missing instance resources, preserve secrets and settings, then check the deployed server. */
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Fetch } from "../../core/mod.ts";
import {
  CloudflareApi,
  CloudflareApiError,
  connectCloudflare,
  type Identity,
  runWrangler,
  type WranglerRun,
} from "./cloudflare_api.ts";
import { withDeploymentConfig } from "./deploy.ts";
import { prepareReleaseImage } from "./release_image.ts";
import {
  DEFAULT_INSTANCE_CONFIG,
  type Environment,
  type Instance,
  type InstanceConfig,
  parseInstanceConfig,
  readInstanceConfig,
  saveInstanceConfig,
} from "./instance_config.ts";

const D1_LOCATIONS = ["", "wnam", "enam", "weur", "eeur", "apac", "oc"];
export interface SetupOptions {
  environment?: Environment;
  accountId?: string;
  hostname?: string;
  location?: string;
  name?: string;
  image?: string;
  configPath: string;
  check: boolean;
}
interface Zone {
  name: string;
  status: string;
  paused: boolean;
}
interface Database {
  uuid: string;
  name: string;
}
interface Dependencies {
  api: CloudflareApi;
  identity: Identity;
  ask: (question: string, defaultValue?: string) => Promise<string>;
  run?: WranglerRun;
  fetch?: Fetch;
  print?: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
  prepareImage?: typeof prepareReleaseImage;
}

export function setupOptions(args: readonly string[]): SetupOptions {
  const options: SetupOptions = { configPath: DEFAULT_INSTANCE_CONFIG, check: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Use ${flag} once.`);
    seen.add(flag);
    if (flag === "--check") {
      options.check = true;
      continue;
    }
    const supported = [
      "--env",
      "--account",
      "--hostname",
      "--location",
      "--name",
      "--image",
      "--instance-config",
    ].includes(flag);
    if (!supported) throw new Error(`Unknown setup option ${flag}. See deno task cf:setup --help.`);
    const value = args[++index];
    if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
    switch (flag) {
      case "--env":
        if (value !== "staging" && value !== "production")
          throw new Error("Use --env staging or production.");
        options.environment = value;
        break;
      case "--account":
        options.accountId = value;
        break;
      case "--hostname":
        options.hostname = value;
        break;
      case "--location":
        options.location = value;
        break;
      case "--name":
        options.name = value;
        break;
      case "--image":
        options.image = value;
        break;
      case "--instance-config":
        options.configPath = resolve(value);
        break;
    }
  }
  return options;
}

/** The Containers entitlement is readable with Wrangler OAuth, unlike billing subscriptions. */
export async function checkAccount(api: CloudflareApi, accountId: string) {
  let account: { limits?: { total_vcpu?: number; total_memory_mib?: number } };
  try {
    account = await api.get(`/accounts/${accountId}/containers/me`);
  } catch (error) {
    if (error instanceof CloudflareApiError && [401, 403].includes(error.status))
      throw new Error(
        "Cloudflare Containers is unavailable. Enable Workers Paid and check this account's Containers permissions.",
      );
    throw error;
  }
  const eligible =
    (account.limits?.total_vcpu ?? 0) > 0 && (account.limits?.total_memory_mib ?? 0) > 0;
  if (!eligible)
    throw new Error("This account has no Container capacity. Enable Workers Paid before setup.");
  return (await api.list<Zone>(`/zones?account.id=${accountId}`)).filter(
    (zone) => zone.status === "active" && !zone.paused,
  );
}

async function savedConfig(path: string): Promise<InstanceConfig> {
  try {
    return await readInstanceConfig(path);
  } catch (error) {
    if (((error as Error).cause as NodeJS.ErrnoException)?.code === "ENOENT")
      return { version: 1, environments: {} };
    throw error;
  }
}

export async function setup(options: SetupOptions, dependencies: Dependencies) {
  const { api, identity, ask } = dependencies;
  const print = dependencies.print ?? console.log;
  const run = dependencies.run ?? runWrangler;
  const request = dependencies.fetch ?? fetch;
  const config = await savedConfig(options.configPath);
  const environment =
    options.environment ?? (await ask("Environment (staging or production)", "production"));
  if (environment !== "staging" && environment !== "production")
    throw new Error("Choose staging or production.");
  const existing = config.environments[environment];
  const requestedAccount = options.accountId ?? existing?.accountId;
  const accountId =
    requestedAccount ??
    (identity.accounts.length === 1
      ? identity.accounts[0].id
      : await ask(
          `Account ID (${identity.accounts.map((account) => `${account.name}: ${account.id}`).join(", ")})`,
        ));
  if (!identity.accounts.some((account) => account.id === accountId))
    throw new Error("That account is not available to this Wrangler login.");
  const zones = await checkAccount(api, accountId);
  print("Workers Paid Container access verified.");
  if (zones.length === 0)
    throw new Error("Add an active domain to this Cloudflare account before setup.");
  print(`Available domains: ${zones.map((zone) => zone.name).join(", ")}`);
  if (options.check) return { checked: true as const };
  const hostname =
    options.hostname ?? existing?.hostname ?? (await ask("Hostname", `translate.${zones[0].name}`));
  const locationHint =
    options.location ??
    existing?.locationHint ??
    (await ask("D1 location (wnam, enam, weur, eeur, apac or oc; empty for automatic)", "weur"));
  if (!D1_LOCATIONS.includes(locationHint)) throw new Error("Choose a supported D1 location.");
  if (!zones.some((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`)))
    throw new Error("Choose a hostname in an active domain listed above.");
  const name = options.name ?? existing?.workerName ?? `quaso-${environment}`;
  const image = options.image ?? existing?.image;
  if (image === undefined)
    throw new Error("Select a published image with --image, such as <namespace>/quaso:<version>.");
  const candidate: Instance = {
    accountId,
    hostname,
    workerName: name,
    databaseName: existing?.databaseName ?? name,
    databaseId: existing?.databaseId ?? "11111111-1111-1111-1111-111111111111",
    bucketName: existing?.bucketName ?? `${name}-store`,
    locationHint,
    sleepAfter: existing?.sleepAfter ?? (environment === "staging" ? "5m" : "10m"),
    image,
  };
  const instance = parseInstanceConfig({ version: 1, environments: { [environment]: candidate } })
    .environments[environment]!;
  if (existing && JSON.stringify(instance) !== JSON.stringify(existing))
    throw new Error(
      "This instance is already configured. Edit its operator settings and use cf:deploy to change it.",
    );
  const accountPath = `/accounts/${accountId}`;
  const workers = await api.list<{ id: string }>(`${accountPath}/workers/scripts`);
  const workerExists = workers.some((worker) => worker.id === name);
  if (workerExists && !existing)
    throw new Error(
      `Worker ${name} already exists without saved instance settings. Choose another --name.`,
    );
  const databases = await api.list<Database>(
    `${accountPath}/d1/database?name=${encodeURIComponent(instance.databaseName)}`,
  );
  const database = databases.find((database) =>
    existing ? database.uuid === existing.databaseId : database.name === instance.databaseName,
  );
  if (existing && database === undefined)
    throw new Error(
      "The configured D1 database is missing. Recover it before running setup again.",
    );
  if (database !== undefined && database.name !== instance.databaseName)
    throw new Error("The configured D1 database has a different name.");
  const createdDatabase = database === undefined;
  instance.databaseId =
    database?.uuid ??
    (
      await api.post<Database>(`${accountPath}/d1/database`, {
        name: instance.databaseName,
        ...(locationHint ? { primary_location_hint: locationHint } : {}),
      })
    ).uuid;
  parseInstanceConfig({ version: 1, environments: { [environment]: instance } });
  const bucketPath = `${accountPath}/r2/buckets/${instance.bucketName}`;
  let createdBucket = false;
  try {
    await api.get(bucketPath);
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    await api.post(`${accountPath}/r2/buckets`, {
      name: instance.bucketName,
      ...(locationHint ? { locationHint } : {}),
    });
    createdBucket = true;
  }
  const secretNames = workerExists
    ? (await api.get<{ name: string }[]>(`${accountPath}/workers/scripts/${name}/secrets`)).map(
        (secret) => secret.name,
      )
    : [];
  const secrets: Record<string, string> = {};
  if (!secretNames.includes("SECRET_KEY")) {
    if (!createdDatabase && (await hasUsers(api, accountPath, instance.databaseId)))
      throw new Error(
        "This database has users but SECRET_KEY is missing. Restore the existing key before setup.",
      );
    secrets.SECRET_KEY = randomKey();
  }
  if (!secretNames.includes("SETUP_KEY")) secrets.SETUP_KEY = randomKey();
  if (!existing) {
    config.environments[environment] = instance;
    await saveInstanceConfig(options.configPath, config);
  }
  print(`D1: ${instance.databaseName}; R2: ${instance.bucketName}.`);
  const alreadyHealthy =
    workerExists &&
    Object.keys(secrets).length === 0 &&
    !createdBucket &&
    !createdDatabase &&
    (await healthy(request, hostname));
  if (alreadyHealthy) {
    print(`Already running: https://${hostname}`);
    return { checked: false as const, instance, changed: false };
  }
  await withDeploymentConfig(instance, environment, async (path) => {
    await (dependencies.prepareImage ?? prepareReleaseImage)(instance, environment, path, run);
    if (Object.keys(secrets).length > 0) {
      const secretFile = join(dirname(path), "initial-secrets.json");
      await fs.writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
      // Preserve the setup key even if the upload succeeds but its acknowledgement is lost.
      if (secrets.SETUP_KEY) print(`Setup key (save it now): ${secrets.SETUP_KEY}`);
      const result = await run(
        ["secret", "bulk", secretFile, "--config", path, "--env", environment],
        true,
      );
      if (result.code !== 0)
        throw new Error("Cloudflare secret upload failed. Run cf:setup again to resume.");
      const uploaded = await api.get<{ name: string }[]>(
        `${accountPath}/workers/scripts/${name}/secrets`,
      );
      const complete = Object.keys(secrets).every((key) =>
        uploaded.some((secret) => secret.name === key),
      );
      if (!complete)
        throw new Error("Secret upload was not completed. Run cf:setup again to resume.");
    }
    print("Deploying the release image…");
    const result = await run(["deploy", "--config", path, "--env", environment], true);
    if (result.code !== 0)
      throw new Error(
        "Deployment failed. Instance settings are saved; run cf:setup again to resume.",
      );
  });
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await healthy(request, hostname)) {
      print(
        `Ready: https://${hostname}\nOpen the address and enter the setup key to create the first administrator.`,
      );
      return { checked: false as const, instance, changed: true };
    }
    if (attempt % 6 === 0) print("Waiting for /healthz and the first container start…");
    await wait(5000);
  }
  throw new Error(
    `The server is not healthy at https://${hostname}/healthz. Settings are saved; check Wrangler logs and run cf:setup again.`,
  );
}

function randomKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}
async function hasUsers(api: CloudflareApi, accountPath: string, databaseId: string) {
  const path = `${accountPath}/d1/database/${databaseId}/query`;
  const tables = await api.post<{ results: { count: number }[] }[]>(path, {
    sql: "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  });
  if (tables[0].results[0].count === 0) return false;
  const users = await api.post<{ results: { count: number }[] }[]>(path, {
    sql: "SELECT COUNT(*) AS count FROM users",
  });
  return users[0].results[0].count > 0;
}
async function healthy(request: Fetch, hostname: string): Promise<boolean> {
  try {
    const response = await request(`https://${hostname}/healthz`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const health = (await response.json()) as {
      ok?: unknown;
      storage?: unknown;
      busy?: unknown;
      nextWakeUp?: unknown;
    };
    const validWake =
      health.nextWakeUp === null ||
      (typeof health.nextWakeUp === "number" &&
        Number.isSafeInteger(health.nextWakeUp) &&
        health.nextWakeUp >= 0);
    return (
      health.ok === true &&
      health.storage === "cloudflare" &&
      typeof health.busy === "boolean" &&
      validWake
    );
  } catch {
    return false;
  }
}

const HELP = `Usage: deno task cf:setup [options]

Choose an account, environment, domain and D1 location interactively.
  --env staging|production   Select the environment.
  --account <id>             Select a Wrangler account.
  --hostname <hostname>      Use a hostname in an active account domain.
  --location <hint>          D1 region (wnam, enam, weur, eeur, apac or oc).
  --name <worker-name>       Name the Worker, database and store bucket.
  --image <release-image>    Use a tagged or digest-pinned Quaso image on Docker Hub.
  --instance-config <file>   Save settings elsewhere.
  --check                   Only check account access and domains; create nothing.
`;
if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) console.log(HELP);
  else {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const options = setupOptions(process.argv.slice(2));
      const connected = await connectCloudflare();
      await setup(options, {
        ...connected,
        ask: async (question, defaultValue = "") => {
          if (!process.stdin.isTTY)
            throw new Error(`Supply an option for ${question} when setup is not interactive.`);
          return (
            (
              await prompt.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `)
            ).trim() || defaultValue
          );
        },
      });
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    } finally {
      prompt.close();
    }
  }
}
