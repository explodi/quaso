// SPDX-License-Identifier: MIT
/** Pause the running host before D1 recovery; leave failed recovery paused for inspection. */
import * as fs from "node:fs/promises";
import type { Fetch } from "../../core/mod.ts";
import { connectCloudflare, runWrangler, type WranglerRun } from "./cloudflare_api.ts";
import { withDeploymentConfig } from "./deploy.ts";
import type { Environment, Instance } from "./instance_config.ts";

export type TimeTravelTarget = ({ timestamp: string } | { bookmark: string } | { resume: true }) & {
  takeover?: boolean;
};
export const BOOKMARK = /^(?:[a-f0-9]{8}-){3}[a-f0-9]{32}$/;

export async function restoreTimeTravel(
  instance: Instance,
  environment: Environment,
  target: TimeTravelTarget,
  dependencies: {
    connect?: typeof connectCloudflare;
    run?: WranglerRun;
    fetch?: Fetch;
    print?: (message: string) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const { api, identity } = await (dependencies.connect ?? connectCloudflare)();
  if (!identity.accounts.some((account) => account.id === instance.accountId))
    throw new Error("The configured Cloudflare account is not available to this login.");
  const run = dependencies.run ?? runWrangler;
  const request = dependencies.fetch ?? fetch;
  const print = dependencies.print ?? console.log;
  const workerPath = `/accounts/${instance.accountId}/workers/scripts/${instance.workerName}`;
  const databasePath = `/accounts/${instance.accountId}/d1/database/${instance.databaseId}/time_travel`;
  const settings = await api.get<{ bindings: Record<string, unknown>[] }>(`${workerPath}/settings`);
  const database = settings.bindings?.find(
    (binding) => binding.name === "DB" && binding.type === "d1",
  );
  const bucket = settings.bindings?.find(
    (binding) => binding.name === "BACKUPS" && binding.type === "r2_bucket",
  );
  if (
    (database?.database_id ?? database?.id) !== instance.databaseId ||
    bucket?.bucket_name !== instance.bucketName
  )
    throw new Error(
      "The deployed Worker has different D1 or R2 bindings. Correct the instance settings before restoring.",
    );
  const domains = await api.list<{ hostname: string; service: string }>(
    `/accounts/${instance.accountId}/workers/domains?hostname=${encodeURIComponent(instance.hostname)}`,
  );
  if (
    !domains.some(
      (domain) => domain.hostname === instance.hostname && domain.service === instance.workerName,
    )
  )
    throw new Error(
      "The configured hostname does not route to this Worker. Correct the instance settings before restoring.",
    );
  let bookmark: string | undefined;
  if ("timestamp" in target) {
    const result = await api.get<{ bookmark: string }>(
      `${databasePath}/bookmark?timestamp=${encodeURIComponent(target.timestamp)}`,
    );
    bookmark = result.bookmark;
  } else if ("bookmark" in target) bookmark = target.bookmark;
  const restoring = !("resume" in target);
  if (restoring && (typeof bookmark !== "string" || !BOOKMARK.test(bookmark)))
    throw new Error("Cloudflare did not return a valid restore bookmark.");
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  let paused = false;
  let restored: { bookmark?: string; previous_bookmark?: string } | undefined;
  let failure: unknown;
  try {
    await api.put(`${workerPath}/secrets`, {
      name: "QUASO_RESTORE_KEY",
      type: "secret_text",
      text: key,
    });
    await withDeploymentConfig(instance, environment, async (path) => {
      const config = JSON.parse(await fs.readFile(path, "utf8"));
      config.env[environment].vars.QUASO_RESTORE_PAUSED = "true";
      await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n");
      print(`Pausing ${environment} at https://${instance.hostname}…`);
      paused = true;
      const deployed = await run(
        ["deploy", "--config", path, "--env", environment, "--containers-rollout", "none"],
        true,
      );
      if (deployed.code !== 0) throw new Error("Couldn't deploy restoration maintenance mode.");
      const control = async (operation: "pause" | "resume") => {
        const force = operation === "pause" ? target.takeover === true : "resume" in target;
        const response = await request(`https://${instance.hostname}/api/v1/restore/${operation}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
          redirect: "error",
          signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Restore ${operation} failed (HTTP ${response.status}).`);
        }
        const result = await response.json();
        if (result.ok !== true)
          throw new Error(`The controller did not confirm restore ${operation}.`);
      };
      if (!("resume" in target)) await control("pause");
      if (bookmark !== undefined) {
        const previous = await api.get<{ bookmark: string }>(`${databasePath}/bookmark`);
        if (!BOOKMARK.test(previous.bookmark))
          throw new Error("Couldn't record the current bookmark before restoration.");
        print(`Previous bookmark (save to undo): ${previous.bookmark}`);
        print(`Restoring D1 to ${bookmark}…`);
        restored = await api.post(
          `${databasePath}/restore?bookmark=${encodeURIComponent(bookmark)}`,
          {},
        );
        if (!restored || !BOOKMARK.test(restored.bookmark ?? ""))
          throw new Error("Cloudflare did not confirm the restored bookmark.");
        if (restored.previous_bookmark && BOOKMARK.test(restored.previous_bookmark))
          print(`Undo bookmark: ${restored.previous_bookmark}`);
      }
      delete config.env[environment].vars.QUASO_RESTORE_PAUSED;
      await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n");
      const resumed = await run(
        ["deploy", "--config", path, "--env", environment, "--containers-rollout", "none"],
        true,
      );
      if (resumed.code !== 0) throw new Error("Couldn't remove restoration maintenance mode.");
      await control("resume");
      paused = false;
    });
  } catch (error) {
    if (paused)
      print(
        "Maintenance mode may remain enabled. Inspect the database, then retry with --takeover or use cf:restore --resume.",
      );
    failure = error;
  }
  try {
    await api.delete(`${workerPath}/secrets/QUASO_RESTORE_KEY`);
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Restoration failed and the temporary key could not be removed.",
        )
      : new Error("The temporary restoration key could not be removed.", { cause: error });
  }
  if (failure) throw failure;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 30; attempt++) {
    let healthy = false;
    try {
      const response = await request(`https://${instance.hostname}/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const health = await response.json();
        healthy = health.ok === true && health.storage === "cloudflare";
      } else await response.body?.cancel();
    } catch {
      /* Container startup can outlast a health probe. */
    }
    if (healthy) {
      print(`Ready: https://${instance.hostname}`);
      return restored ?? { resumed: true };
    }
    await wait(5000);
  }
  throw new Error(
    "Maintenance mode is removed, but the restored server is not healthy. Check the server logs.",
  );
}
