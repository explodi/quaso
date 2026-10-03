// SPDX-License-Identifier: MIT
/** The arguments of `bun run cf:deploy`, checked (see `deploy.ts`). */

export const ENVIRONMENTS = ["staging", "production"] as const;

/** The environment named by `--env <name>`, `--env=<name>` or `-e <name>`, or null. */
export function deployEnvironment(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env" || arg === "-e") return args[i + 1] ?? null;
    if (arg.startsWith("--env=")) return arg.slice("--env=".length);
  }
  return null;
}

/** Why these arguments can't be deployed, or null. */
export function deployProblem(args: readonly string[]): string | null {
  const env = deployEnvironment(args);
  if (env === null) {
    return (
      "Name the environment: bun run cf:deploy --env staging (or --env production). " +
      "The instance is read from quaso.cloudflare.jsonc; wrangler.jsonc is for local runs only."
    );
  }
  if (!(ENVIRONMENTS as readonly string[]).includes(env)) {
    return `Unknown environment "${env}": use --env ${ENVIRONMENTS.join(" or --env ")}.`;
  }
  return null;
}
