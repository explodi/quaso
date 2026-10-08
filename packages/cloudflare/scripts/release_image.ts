// SPDX-License-Identifier: MIT
/** Transfer a published release unchanged into the account's managed registry. */
import * as fs from "node:fs/promises";
import { runWrangler, type WranglerRun } from "./cloudflare_api.ts";
import type { Environment, Instance } from "./instance_config.ts";

type DockerRun = (args: string[]) => Promise<{ code: number; stdout: string }>;

async function runDocker(args: string[]) {
  const result = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout).trim() };
}

export async function prepareReleaseImage(
  instance: Instance,
  environment: Environment,
  path: string,
  wrangler: WranglerRun = runWrangler,
  docker: DockerRun = runDocker,
): Promise<void> {
  if (instance.image.startsWith("registry.cloudflare.com/")) return;
  const source = instance.image;
  const sourceExisted = (await docker(["image", "inspect", source])).code === 0;
  let target = "";
  let targetExisted = false;
  let pulled = false;
  let failure: unknown;
  try {
    if ((await docker(["pull", "--platform", "linux/amd64", source])).code !== 0)
      throw new Error(
        "Couldn't pull the published release. Check Docker and access to its registry.",
      );
    pulled = true;
    const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", source]);
    const imageId = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error("Docker did not return a valid release image ID.");
    target = `registry.cloudflare.com/${instance.accountId}/quaso:${imageId.slice(7)}`;
    targetExisted = (await docker(["image", "inspect", target])).code === 0;
    if ((await docker(["tag", source, target])).code !== 0)
      throw new Error("Couldn't tag the published release for Cloudflare.");
    const pushed = await wrangler([
      "containers",
      "push",
      target,
      "--config",
      path,
      "--env",
      environment,
    ]);
    if (pushed.code !== 0) throw new Error("Couldn't push the published release to Cloudflare.");
    const digests = await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", target]);
    let pinned: string | undefined;
    try {
      const values = JSON.parse(digests.stdout) as string[];
      pinned = values.find((value) =>
        value.startsWith(`registry.cloudflare.com/${instance.accountId}/quaso@sha256:`),
      );
    } catch {
      /* Invalid output is handled below. */
    }
    if (digests.code !== 0 || !pinned || !/@sha256:[a-f0-9]{64}$/.test(pinned))
      throw new Error("Couldn't verify the transferred release digest; deployment stopped.");
    const config = JSON.parse(await fs.readFile(path, "utf8"));
    for (const container of config.env[environment].containers) container.image = pinned;
    await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n");
  } catch (error) {
    failure = error;
  }
  const removals: string[] = [];
  if (target && !targetExisted) removals.push(target);
  if (pulled && !sourceExisted) removals.push(source);
  if (removals.length) {
    try {
      if ((await docker(["image", "rm", ...removals])).code !== 0)
        throw new Error(`Couldn't remove temporary Docker tags: ${removals.join(", ")}.`);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Transfer and cleanup failed.")
        : error;
    }
  }
  if (failure) throw failure;
}
