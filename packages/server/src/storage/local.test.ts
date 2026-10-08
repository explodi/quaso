// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { silentLogger } from "@quaso/service";
import { LockBusyError } from "./lock.ts";
import { DATABASE_FILE, openLocalStorage } from "./local.ts";
import { listStoredBackups } from "../../../service/src/stored_backups.ts";

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(join(dir, "data"));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

test("local storage: creates the folder and keeps a second server off", {}, () =>
  withDataDir(async (dataDir) => {
    const storage = await openLocalStorage({ dataDir, log: silentLogger });
    try {
      assert((await fs.stat(join(dataDir, "store"))).isDirectory());
      assert((await fs.stat(join(dataDir, DATABASE_FILE))).isFile());
      const error = await assertRejects(
        () => openLocalStorage({ dataDir, log: silentLogger, lockTimeoutMs: 100 }),
        LockBusyError,
      );
      assertEquals(error.message, `Another Quaso server is using ${dataDir}.`);
    } finally {
      storage.close();
    }
    const again = await openLocalStorage({ dataDir, log: silentLogger, lockTimeoutMs: 1000 });
    again.close();
  }),
);

test("local storage: a snapshot before migrating, and on demand", () =>
  withDataDir(async (dataDir) => {
    let time = Date.UTC(2026, 8, 24, 3, 15, 0);
    const storage = await openLocalStorage({ dataDir, log: silentLogger, now: () => time });
    try {
      storage.sql.script("CREATE TABLE strings (value TEXT); INSERT INTO strings VALUES ('Play')");
      await storage.beforeMigrate(1, 2);
      const before = join(dataDir, "tmp", "before.sqlite");
      await fs.writeFile(
        before,
        (await storage.store.read("backups/pre-migration-v1-to-v2-20260924T031500Z.sqlite"))!,
      );
      const copy = new DatabaseSync(before);
      assertEquals(
        copy
          .prepare("SELECT value FROM strings")
          .all()
          .map((r) => r.value),
        ["Play"],
      );
      copy.close();

      time += 60_000;
      assertEquals(await storage.snapshot(), "quaso-20260924T031600Z.sqlite");
      assertEquals(storage.lastBackup()?.file, "quaso-20260924T031600Z.sqlite");
      assertEquals((await listStoredBackups(storage.store)).length, 1);
    } finally {
      storage.close();
    }
  }));

test("local storage: closing checkpoints the write-ahead log", () =>
  withDataDir(async (dataDir) => {
    const storage = await openLocalStorage({ dataDir, log: silentLogger });
    storage.sql.script("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    const wal = join(dataDir, `${DATABASE_FILE}-wal`);
    assert((await fs.stat(wal)).size > 0);
    storage.close();
    storage.close();
    const size = await fs.stat(wal).then(
      (info) => info.size,
      () => 0,
    );
    assertEquals(size, 0);
  }));

test("local storage: the scheduler wakes up whoever the host names", () =>
  withDataDir(async (dataDir) => {
    const storage = await openLocalStorage({ dataDir, log: silentLogger });
    try {
      const woken = Promise.withResolvers<void>();
      storage.onAlarm = () => {
        woken.resolve();
        return Promise.resolve();
      };
      storage.scheduler.schedule(Date.now());
      await woken.promise;
    } finally {
      storage.close();
    }
  }));
