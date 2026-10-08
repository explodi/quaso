// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { expect } from "@std/expect";
import * as fs from "node:fs/promises";
import { withDeploymentConfig } from "../packages/cloudflare/scripts/deploy.ts";
import { parseInstanceConfig } from "../packages/cloudflare/scripts/instance_config.ts";
import { prepareReleaseImage } from "../packages/cloudflare/scripts/release_image.ts";

const instance = {
  accountId: "0123456789abcdef0123456789abcdef",
  hostname: "translate.example.com",
  workerName: "quaso-example",
  databaseId: "12345678-1234-1234-1234-123456789abc",
  databaseName: "quaso-example",
  bucketName: "quaso-example-store",
  locationHint: "weur",
  sleepAfter: "5m",
  image: "explodi/quaso:1.0.0-beta.2",
};
const hash = "a".repeat(64);
const registry = `registry.cloudflare.com/${instance.accountId}/quaso`;
const target = `${registry}:${hash}`;
const pinned = `${registry}@sha256:${hash}`;

function fixture(existing = false, pushCode = 0, digests = JSON.stringify([pinned])) {
  const commands: string[][] = [];
  const docker = async (args: string[]) => {
    commands.push(args);
    if (args.includes("{{.Id}}")) return { code: 0, stdout: `sha256:${hash}` };
    if (args.includes("{{json .RepoDigests}}")) return { code: 0, stdout: digests };
    if (args[1] === "inspect") return { code: existing ? 0 : 1, stdout: "" };
    return { code: 0, stdout: "" };
  };
  const wrangler = async (args: string[]) => {
    commands.push(args);
    return { code: pushCode, stdout: "" };
  };
  return { commands, docker, wrangler };
}

test("transfers the published amd64 image without building and deploys its managed digest", async () => {
  const f = fixture();
  await withDeploymentConfig(instance, "staging", async (path) => {
    await prepareReleaseImage(instance, "staging", path, f.wrangler, f.docker);
    const config = JSON.parse(await fs.readFile(path, "utf8"));
    expect(config.env.staging.containers[0].image).toBe(pinned);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(f.commands).toEqual([
      ["image", "inspect", instance.image],
      ["pull", "--platform", "linux/amd64", instance.image],
      ["image", "inspect", "--format", "{{.Id}}", instance.image],
      ["image", "inspect", target],
      ["tag", instance.image, target],
      ["containers", "push", target, "--config", path, "--env", "staging"],
      ["image", "inspect", "--format", "{{json .RepoDigests}}", target],
      ["image", "rm", target, instance.image],
    ]);
  });
  expect(instance.image).toBe("explodi/quaso:1.0.0-beta.2");
});

test("failed transfer stops deployment and removes newly created local tags", async () => {
  const f = fixture(false, 1);
  await withDeploymentConfig(instance, "staging", async (path) => {
    await expect(
      prepareReleaseImage(instance, "staging", path, f.wrangler, f.docker),
    ).rejects.toThrow("Couldn't push");
    expect(f.commands.at(-1)).toEqual(["image", "rm", target, instance.image]);
    expect(JSON.parse(await fs.readFile(path, "utf8")).env.staging.containers[0].image).toBe(
      instance.image,
    );
  });
});

test("preserves Docker tags that existed before the transfer", async () => {
  const f = fixture(true);
  await withDeploymentConfig(instance, "staging", (path) =>
    prepareReleaseImage(instance, "staging", path, f.wrangler, f.docker),
  );
  expect(f.commands.at(-1)).toEqual([
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    target,
  ]);
});

test("refuses an unverified transfer digest", async () => {
  const f = fixture(false, 0, '["registry.cloudflare.com/other/quaso@sha256:bad"]');
  await withDeploymentConfig(instance, "staging", async (path) => {
    await expect(
      prepareReleaseImage(instance, "staging", path, f.wrangler, f.docker),
    ).rejects.toThrow("verify");
    expect(f.commands.at(-1)).toEqual(["image", "rm", target, instance.image]);
  });
});

test("a managed digest needs no Docker transfer and must belong to the configured account", async () => {
  const managed = { ...instance, image: pinned };
  expect(
    parseInstanceConfig({ version: 1, environments: { staging: managed } }).environments.staging,
  ).toEqual(managed);
  const f = fixture();
  await prepareReleaseImage(managed, "staging", "unused", f.wrangler, f.docker);
  expect(f.commands).toEqual([]);
  expect(() =>
    parseInstanceConfig({
      version: 1,
      environments: { staging: { ...managed, accountId: "b".repeat(32) } },
    }),
  ).toThrow("different Cloudflare account");
});
