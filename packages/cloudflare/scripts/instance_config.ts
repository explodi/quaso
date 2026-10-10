// SPDX-License-Identifier: MIT
import { parse as parseJsonc } from "@std/jsonc";
/** Operator-owned instance settings generate deployment bindings without editing the checkout. */
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENVIRONMENTS } from "./deploy_args.ts";

export type Environment = (typeof ENVIRONMENTS)[number];
export interface Instance {
  accountId: string;
  hostname: string;
  workerName: string;
  databaseId: string;
  databaseName: string;
  bucketName: string;
  locationHint: string;
  sleepAfter: string;
  image: string;
}
export interface InstanceConfig {
  version: 1;
  environments: Partial<Record<Environment, Instance>>;
}
export const DEFAULT_INSTANCE_CONFIG = fileURLToPath(
  new URL("../../../quaso.cloudflare.jsonc", import.meta.url),
);
const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const LOCATIONS = ["", "wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`${name} is missing or invalid.`);
  return value;
}

export function parseInstanceConfig(value: unknown): InstanceConfig {
  const config = object(value, "Instance configuration");
  if (config.version !== 1) throw new Error("Instance configuration must have version 1.");
  const environments = object(config.environments, "environments");
  const parsed: InstanceConfig = { version: 1, environments: {} };
  for (const [name, value] of Object.entries(environments)) {
    if (!(ENVIRONMENTS as readonly string[]).includes(name))
      throw new Error(`Unknown environment "${name}"; use staging or production.`);
    const fields = object(value, name);
    const id = `${name}.`;
    const locationHint = string(fields.locationHint, `${id}locationHint`, /^[a-z]*$/);
    if (!LOCATIONS.includes(locationHint)) throw new Error(`${id}locationHint is invalid.`);
    parsed.environments[name as Environment] = {
      accountId: string(fields.accountId, `${id}accountId`, /^[a-f0-9]{32}$/),
      hostname: string(
        fields.hostname,
        `${id}hostname`,
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      ),
      workerName: string(fields.workerName, `${id}workerName`, /^[a-z0-9][a-z0-9_-]{0,62}$/),
      databaseId: string(
        fields.databaseId,
        `${id}databaseId`,
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      ),
      databaseName: string(fields.databaseName, `${id}databaseName`, /^[a-z0-9][a-z0-9_-]{0,62}$/),
      bucketName: string(fields.bucketName, `${id}bucketName`, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
      locationHint,
      sleepAfter: string(fields.sleepAfter, `${id}sleepAfter`, /^[1-9]\d*[smh]$/),
      // A published release on Docker Hub (such as <namespace>/quaso:1), or one already
      // transferred to the account's managed registry.
      image: string(
        fields.image,
        `${id}image`,
        /^(?:(?:docker\.io\/)?[a-z0-9_.-]+\/quaso(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})|registry\.cloudflare\.com\/[a-f0-9]{32}\/quaso@sha256:[a-f0-9]{64})$/,
      ),
    };
    if (
      parsed.environments[name as Environment]!.databaseId ===
      "00000000-0000-0000-0000-000000000000"
    )
      throw new Error(`${id}databaseId is still a placeholder; run cf:setup.`);
    if (parsed.environments[name as Environment]!.image.endsWith(":1.0.0-rc.1"))
      throw new Error(`${id}image must use Beta 2 storage; the rc.1 image is incompatible.`);
    const instance = parsed.environments[name as Environment]!;
    const managedImage = instance.image.startsWith("registry.cloudflare.com/");
    if (
      managedImage &&
      !instance.image.startsWith(`registry.cloudflare.com/${instance.accountId}/`)
    )
      throw new Error(`${id}image belongs to a different Cloudflare account.`);
  }
  return parsed;
}

export async function readInstanceConfig(path = DEFAULT_INSTANCE_CONFIG): Promise<InstanceConfig> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No instance configuration at ${path}. Run deno task cf:setup first.`, {
        cause: error,
      });
    throw error;
  }
  return parseInstanceConfig(parseJsonc(text));
}

export async function saveInstanceConfig(path: string, config: InstanceConfig): Promise<void> {
  const validated = parseInstanceConfig(config);
  const directory = await fs.mkdtemp(join(dirname(path), `.${basename(path)}-`));
  const temporary = join(directory, "settings.jsonc");
  try {
    await fs.writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function configuredInstance(config: InstanceConfig, environment: Environment): Instance {
  const instance = config.environments[environment];
  if (instance === undefined)
    throw new Error(`No ${environment} instance is configured. Run deno task cf:setup first.`);
  return instance;
}

/** Paths remain rooted in the package when Wrangler reads its generated file elsewhere. */
export function deploymentConfig(
  template: Record<string, unknown>,
  instance: Instance,
  environment: Environment,
): Record<string, unknown> {
  const {
    env,
    containers: _containers,
    durable_objects: _objects,
    migrations: _migrations,
    d1_databases: _databases,
    r2_buckets: _buckets,
    vars: _vars,
    secrets: _secrets,
    ...base
  } = template;
  const selected = object(object(env, "template.env")[environment], `template.env.${environment}`);
  const aliases = object(template.alias, "template.alias");
  const assets = object(template.assets, "template.assets");
  const build = object(template.build, "template.build");
  const vars = object(selected.vars, "template.vars");
  const containers = selected.containers as Record<string, unknown>[];
  return {
    ...base,
    account_id: instance.accountId,
    main: resolve(PACKAGE_DIR, String(template.main)),
    alias: Object.fromEntries(
      Object.entries(aliases).map(([name, path]) => [name, resolve(PACKAGE_DIR, String(path))]),
    ),
    assets: { ...assets, directory: resolve(PACKAGE_DIR, String(assets.directory)) },
    build: { ...build, cwd: resolve(PACKAGE_DIR, String(build.cwd)) },
    env: {
      [environment]: {
        ...selected,
        name: instance.workerName,
        routes: [{ pattern: instance.hostname, custom_domain: true }],
        workers_dev: false,
        preview_urls: false,
        containers: containers.map(({ image_build_context: _context, ...container }) => ({
          ...container,
          image: deploymentImage(instance.image),
        })),
        d1_databases: [
          { binding: "DB", database_name: instance.databaseName, database_id: instance.databaseId },
        ],
        r2_buckets: [{ binding: "BACKUPS", bucket_name: instance.bucketName }],
        vars: {
          ...vars,
          PUBLIC_URL: `https://${instance.hostname}`,
          LOCATION_HINT: instance.locationHint,
          CONTAINER_SLEEP_AFTER: instance.sleepAfter,
        },
      },
    },
  };
}

/**
 * The image as Wrangler deploys it. Cloudflare pulls a release published on Docker Hub
 * itself (`docker.io/<namespace>/quaso:<tag>`), so a deployment needs no local Docker; an
 * image already in the account's managed registry stays as it is.
 */
export function deploymentImage(image: string): string {
  const fullReference =
    image.startsWith("registry.cloudflare.com/") || image.startsWith("docker.io/");
  return fullReference ? image : `docker.io/${image}`;
}

export async function readDeploymentTemplate(): Promise<Record<string, unknown>> {
  return object(
    parseJsonc(await fs.readFile(resolve(PACKAGE_DIR, "wrangler.jsonc"), "utf8")),
    "Wrangler template",
  );
}
