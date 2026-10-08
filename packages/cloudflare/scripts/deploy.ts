// SPDX-License-Identifier: MIT
/** Deploy a named instance using temporary Wrangler configuration from operator settings. */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployEnvironment, deployProblem } from "./deploy_args.ts";
import {
  configuredInstance,
  DEFAULT_INSTANCE_CONFIG,
  deploymentConfig,
  type Environment,
  type Instance,
  readDeploymentTemplate,
  readInstanceConfig,
} from "./instance_config.ts";

export function deployOptions(args: readonly string[]) {
  const problem = deployProblem(args);
  if (problem !== null) throw new Error(problem);
  const environment = deployEnvironment(args) as Environment;
  let configPath = DEFAULT_INSTANCE_CONFIG;
  let namedEnvironment = false;
  const wrangler: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--env" || arg === "-e" || arg.startsWith("--env=")) {
      if (namedEnvironment) throw new Error("Name the environment once.");
      namedEnvironment = true;
      if (!arg.startsWith("--env=")) index++;
      continue;
    }
    if (arg === "--instance-config") {
      const path = args[++index];
      if (!path || path.startsWith("-")) throw new Error("--instance-config needs a file path.");
      configPath = resolve(path);
      continue;
    }
    if (arg === "--dry-run" || arg === "--minify") {
      wrangler.push(arg);
      continue;
    }
    if (arg === "--outdir" || arg === "--containers-rollout" || arg === "--secrets-file") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value.`);
      wrangler.push(arg, value);
      continue;
    }
    throw new Error(`Unknown deployment option ${arg}. See deno task cf:deploy --help.`);
  }
  return { environment, configPath, wrangler };
}

/** Cleanup covers Wrangler failures as well as successful deployments. */
export async function deploy(
  args: readonly string[],
  run: (args: string[]) => Promise<number> = runWrangler,
): Promise<number> {
  const options = deployOptions(args);
  const config = await readInstanceConfig(options.configPath);
  const instance = configuredInstance(config, options.environment);
  return await withDeploymentConfig(instance, options.environment, async (path) => {
    return await run([
      "deploy",
      "--config",
      path,
      "--env",
      options.environment,
      ...options.wrangler,
    ]);
  });
}

export async function withDeploymentConfig<T>(
  instance: Instance,
  environment: Environment,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const generated = deploymentConfig(await readDeploymentTemplate(), instance, environment);
  const directory = await fs.mkdtemp(join(tmpdir(), "quaso-deploy-"));
  const path = join(directory, "wrangler.jsonc");
  try {
    await fs.writeFile(path, JSON.stringify(generated, null, 2) + "\n", { mode: 0o600 });
    return await run(path);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runWrangler(args: string[]): Promise<number> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "npm:wrangler", ...args],
    cwd: new URL("../", import.meta.url),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return code;
}

const HELP = `Usage: deno task cf:deploy --env staging|production [options]

Reads quaso.cloudflare.jsonc at the repository root.
  --instance-config <file>     Use another operator configuration file.
  --dry-run                   Bundle without deploying.
  --minify                    Minify the Worker bundle.
  --outdir <directory>         Save Wrangler's bundle output.
  --containers-rollout <mode>  Select Wrangler's container rollout mode.
  --secrets-file <file>        Supply secrets for the initial deployment.
`;

if (import.meta.main && process.argv.slice(2).includes("--help")) {
  console.log(HELP);
} else if (import.meta.main) {
  try {
    process.exitCode = await deploy(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
