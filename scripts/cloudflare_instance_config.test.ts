// SPDX-License-Identifier: MIT
import { exists } from "@std/fs/exists";
import { describe, test } from "node:test";
import { expect } from "@std/expect";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploy, deployOptions } from "../packages/cloudflare/scripts/deploy.ts";
import {
  configuredInstance,
  deploymentConfig,
  parseInstanceConfig,
  readDeploymentTemplate,
  readInstanceConfig,
} from "../packages/cloudflare/scripts/instance_config.ts";

const instance = {
  accountId: "0123456789abcdef0123456789abcdef",
  hostname: "translate.example.com",
  workerName: "quaso-example",
  databaseId: "12345678-1234-1234-1234-123456789abc",
  databaseName: "quaso-example",
  bucketName: "quaso-example-store",
  locationHint: "weur",
  sleepAfter: "5m",
  image: "example/quaso:1.0.0-beta.2",
};
const settings = { version: 1 as const, environments: { staging: instance } };

describe("Cloudflare instance configuration", () => {
  test("validates named instances and refuses placeholders and incomplete settings", () => {
    const parsed = parseInstanceConfig(settings);
    expect(configuredInstance(parsed, "staging")).toEqual(instance);
    expect(() => configuredInstance(parsed, "production")).toThrow("No production instance");
    expect(() => parseInstanceConfig({ ...settings, version: 2 })).toThrow("version 1");
    expect(() => parseInstanceConfig({ version: 1, environments: { dev: instance } })).toThrow(
      "Unknown environment",
    );
    expect(() => parseInstanceConfig({ version: 1, environments: { staging: {} } })).toThrow(
      "missing or invalid",
    );
    expect(() =>
      parseInstanceConfig({
        version: 1,
        environments: {
          staging: { ...instance, databaseId: "00000000-0000-0000-0000-000000000000" },
        },
      }),
    ).toThrow("placeholder");
    expect(() =>
      parseInstanceConfig({
        version: 1,
        environments: { staging: { ...instance, hostname: "https://example.com/path" } },
      }),
    ).toThrow("hostname");
    expect(() =>
      parseInstanceConfig({
        version: 1,
        environments: { staging: { ...instance, locationHint: "somewhere" } },
      }),
    ).toThrow("locationHint");
    expect(() =>
      parseInstanceConfig({
        version: 1,
        environments: { staging: { ...instance, image: "../../deploy/Dockerfile" } },
      }),
    ).toThrow("image");
  });

  test("generates the selected custom domain, private bindings and release image without changing the template", async () => {
    const template = await readDeploymentTemplate();
    const original = structuredClone(template);
    const config = deploymentConfig(template, instance, "staging");
    const selected = (config.env as Record<string, any>).staging;
    expect(Object.keys(config.env as object)).toEqual(["staging"]);
    expect(config.account_id).toBe(instance.accountId);
    expect(isAbsolute(config.main as string)).toBe(true);
    expect(Object.values(config.alias as object).every(isAbsolute)).toBe(true);
    expect((config.assets as Record<string, string>).directory).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "../packages/web/dist"),
    );
    expect((config.build as Record<string, string>).cwd).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    );
    expect(selected.name).toBe(instance.workerName);
    expect(selected.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(selected.routes).toEqual([{ pattern: instance.hostname, custom_domain: true }]);
    expect(selected.d1_databases).toEqual([
      { binding: "DB", database_name: instance.databaseName, database_id: instance.databaseId },
    ]);
    expect(selected.r2_buckets).toEqual([{ binding: "BACKUPS", bucket_name: instance.bucketName }]);
    expect(selected.containers[0].image).toBe(`docker.io/${instance.image}`);
    expect(selected.containers[0].image_build_context).toBeUndefined();
    expect(selected.vars.PUBLIC_URL).toBe("https://translate.example.com");
    expect(selected.vars.CONTAINER_SLEEP_AFTER).toBe("5m");
    expect(selected.vars.LOCATION_HINT).toBe("weur");
    expect(selected.durable_objects.bindings).toEqual([
      { name: "QUASO_CONTAINER", class_name: "QuasoContainer" },
    ]);
    expect(selected.secrets.required).toEqual(["SECRET_KEY"]);
    expect(config.d1_databases).toBeUndefined();
    expect(config.containers).toBeUndefined();
    expect(template).toEqual(original);
  });

  test("deployment options cannot override the configured account, name or routes", () => {
    expect(deployOptions(["--env=staging", "--dry-run"]).wrangler).toEqual(["--dry-run"]);
    expect(deployOptions(["-e", "production", "--outdir", "/tmp/bundle"]).environment).toBe(
      "production",
    );
    expect(() => deployOptions([])).toThrow("Name the environment");
    expect(() => deployOptions(["--env", "staging", "--env", "production"])).toThrow("once");
    expect(() => deployOptions(["--env", "staging", "--config", "other.jsonc"])).toThrow(
      "Unknown deployment option",
    );
    expect(() => deployOptions(["--env", "staging", "--name", "other"])).toThrow(
      "Unknown deployment option",
    );
    expect(() => deployOptions(["--env", "staging", "--instance-config"])).toThrow(
      "needs a file path",
    );
  });

  test("reads JSONC and removes its generated file when Wrangler succeeds or fails", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "quaso-instance-test-"));
    const path = join(directory, "quaso.cloudflare.jsonc");
    let generatedPath = "";
    try {
      await fs.writeFile(path, "// operator settings\n" + JSON.stringify(settings));
      expect(await readInstanceConfig(path)).toEqual(settings);
      expect(
        await deploy(["--env", "staging", "--instance-config", path, "--dry-run"], async (args) => {
          generatedPath = args[2];
          expect(args.slice(3)).toEqual(["--env", "staging", "--dry-run"]);
          const generated = JSON.parse(await fs.readFile(generatedPath, "utf8"));
          expect(generated.env.staging.name).toBe(instance.workerName);
          expect((await fs.stat(generatedPath)).mode & 0o777).toBe(0o600);
          return 0;
        }),
      ).toBe(0);
      expect(await exists(dirname(generatedPath))).toBe(false);
      await expect(
        deploy(["--env", "staging", "--instance-config", path], async (args) => {
          generatedPath = args[2];
          throw new Error("Wrangler failed");
        }),
      ).rejects.toThrow("Wrangler failed");
      expect(await exists(dirname(generatedPath))).toBe(false);
      expect(
        await deploy(["--env", "staging", "--instance-config", path], async (args) => {
          generatedPath = args[2];
          return 7;
        }),
      ).toBe(7);
      expect(await exists(dirname(generatedPath))).toBe(false);
      await expect(readInstanceConfig(join(directory, "missing.jsonc"))).rejects.toThrow(
        "cf:setup",
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
