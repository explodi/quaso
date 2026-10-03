// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { makeTempDir } from "@quaso/runtime/files";
import * as fs from "node:fs/promises";
/** The service with local storage: who runs LLM jobs. */
import { assertEquals } from "@quaso/runtime/assert";
import { silentLogger, SYSTEM } from "@quaso/service";
import { startLocalService } from "./local_service.ts";
import { testConfig } from "./testing/helpers.ts";
import { backupKey } from "../../service/src/stored_backups.ts";
import { DAY_MS } from "../../service/src/file_retention.ts";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("local host keeps its stored signing key across restarts and ignores the environment key", async () => {
  const dataDir = await makeTempDir({ prefix: "quaso-instance-key-" });
  try {
    const first = await startLocalService(
      testConfig({ DATA_DIR: dataDir, SECRET_KEY: "x".repeat(32) }),
      silentLogger,
    );
    const key = first.secretKey;
    assertEquals(/^[a-f0-9]{64}$/.test(key), true);
    assertEquals(
      first.storage.sql.query("SELECT value FROM secrets WHERE name = 'instance_key'")[0].value,
      key,
    );
    first.storage.close();
    const second = await startLocalService(
      testConfig({ DATA_DIR: dataDir, SECRET_KEY: "y".repeat(32) }),
      silentLogger,
    );
    try {
      assertEquals(second.secretKey, key);
    } finally {
      second.storage.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true });
  }
});

test("local backups apply changed retention without restarting", async () => {
  const dataDir = await makeTempDir({ prefix: "quaso-retention-" });
  const local = await startLocalService(testConfig({ DATA_DIR: dataDir }), silentLogger);
  try {
    const old = backupKey(Date.now() - 10 * DAY_MS, "sqlite");
    const recent = backupKey(Date.now() - DAY_MS, "sqlite");
    await local.storage.store.write(old, new Uint8Array([1]));
    await local.storage.store.write(recent, new Uint8Array([2]));
    await local.storage.snapshot();
    assertEquals(await local.storage.store.read(old), new Uint8Array([1]));
    await local.service.updateSettings(SYSTEM, { backupRetentionDays: 1 });
    await local.storage.snapshot();
    assertEquals(await local.storage.store.read(old), null);
    assertEquals(await local.storage.store.read(recent), new Uint8Array([2]));
  } finally {
    local.storage.close();
    await fs.rm(dataDir, { recursive: true });
  }
});

test("local service: health reports its scheduled backup deadline", async () => {
  const dataDir = await makeTempDir({ prefix: "quaso-backup-health-" });
  const local = await startLocalService(testConfig({ DATA_DIR: dataDir }), silentLogger, {
    backups: true,
  });
  try {
    const health = await local.service.getHealth(SYSTEM, {});
    assertEquals(health.busy, false);
    assertEquals(health.nextWakeUp, local.storage.backupStatus.nextWakeUp());
    assertEquals(health.nextWakeUp !== null, true);
  } finally {
    local.storage.close();
    await fs.rm(dataDir, { recursive: true });
  }
});

test("local service: one-off commands leave LLM jobs to the server", async () => {
  const dataDir = await makeTempDir({ prefix: "quaso-local-service-" });
  const config = testConfig({ QUASO_DEV: "1", DATA_DIR: dataDir });
  try {
    // A queued job and its due wake-up, as a server that stopped leaves them.
    let local = await startLocalService(config, silentLogger);
    await local.service.upload(SYSTEM, {
      files: [{ path: "common.json", repoPath: "common.json", content: '{ "title": "Wayfarer" }' }],
      languages: ["de"],
    });
    local.storage.sql.run(
      `INSERT INTO jobs (status, priority, source, scope, actor_type, created_at, updated_at)
       VALUES ('queued', 2, 'cli', '{}', 'system', 0, 0)`,
    );
    local.storage.sql.run(
      "INSERT INTO meta (key, value) VALUES ('next_alarm', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(Date.now()),
    );
    local.storage.close();

    // A one-off command (seed-dev, token create, restore): no provider, and no job runs,
    // nor is paused for want of a provider.
    local = await startLocalService(config, silentLogger);
    await wait(100);
    const status = () =>
      local.storage.sql.query<{ status: string }>("SELECT status FROM jobs")[0].status;
    assertEquals(status(), "queued");
    local.storage.close();

    // The server runs it (the fake translator, in development).
    local = await startLocalService(config, silentLogger, { llm: true });
    for (let i = 0; i < 100 && status() !== "done"; i++) await wait(50);
    assertEquals(status(), "done");
    const page = await local.service.listStrings(SYSTEM, { language: "de" });
    assertEquals(page.strings[0].translation?.colour, "green");
    local.storage.close();
  } finally {
    await fs.rm(dataDir, { recursive: true });
  }
});
