// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/**
 * `quaso restore <file>` with local storage, run as the real program: a SQLite snapshot and
 * gzip-compressed JSON into new data folders, and the refusals.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { backupJsonStream, silentLogger, SYSTEM } from "@quaso/service";
import { startLocalService } from "./local_service.ts";
import { testConfig } from "./testing/helpers.ts";
import { backupKey } from "../../service/src/stored_backups.ts";

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));
const decoder = new TextDecoder();
const SECRET_KEY = "r".repeat(64);

async function run(args: string[], env: Record<string, string>, cwd: string) {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    env: { SECRET_KEY, ...env },
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, stderr: decoder.decode(stderr) };
}

/** A local instance with a project, and its export, for comparing. */
async function sourceInstance(dataDir: string) {
  const local = await startLocalService(
    testConfig({ DATA_DIR: dataDir, SECRET_KEY }),
    silentLogger,
  );
  await local.service.upload(SYSTEM, {
    files: [
      {
        path: "common.json",
        repoPath: "common.json",
        content: '{\n  "title": "Wayfarer",\n  "play": "Play"\n}\n',
      },
    ],
    languages: ["de", "pl"],
  });
  await local.service.importTranslations(SYSTEM, {
    language: "de",
    files: [{ path: "common.json", content: '{ "title": "Wanderer" }' }],
    as: "blue",
  });
  await local.service.setSecret(SYSTEM, {
    name: "gemini_api_key",
    value: "test-provider-credential-7132",
  });
  return local;
}

async function exportOf(dataDir: string) {
  const local = await startLocalService(
    testConfig({ DATA_DIR: dataDir, SECRET_KEY }),
    silentLogger,
  );
  try {
    return (await local.service.exportFiles(SYSTEM, {})).files;
  } finally {
    local.storage.close();
  }
}

test(
  "restore: a SQLite snapshot and gzip JSON into new data folders; never over a project",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await fs.realpath(await Deno.makeTempDir());
    try {
      const source = await sourceInstance(join(dir, "source"));
      const snapshot = join(dir, "backup.sqlite");
      const gzip = join(dir, "backup.json.gz");
      let expected;
      try {
        await source.storage.snapshotTo(snapshot);
        const json = await new Response(backupJsonStream(source.service, SYSTEM)).text();
        const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
        await fs.writeFile(gzip, new Uint8Array(await new Response(compressed).arrayBuffer()));
        expected = (await source.service.exportFiles(SYSTEM, {})).files;
      } finally {
        source.storage.close();
      }

      for (const [file, target] of [
        [snapshot, "a"],
        [gzip, "b"],
      ]) {
        const env = { DATA_DIR: join(dir, target) };
        const restored = await run(["restore", file], env, dir);
        assertEquals(restored.code, 0, restored.stderr);
        assertStringIncludes(restored.stderr, "Restored");
        assertStringIncludes(
          restored.stderr,
          "Enter these credentials again in Settings: gemini_api_key.",
        );
        assertEquals(await exportOf(env.DATA_DIR), expected);

        const again = await run(["restore", file], env, dir);
        assertEquals(again.code, 1);
        assertStringIncludes(again.stderr, "only restores into an empty instance");
      }

      assertEquals((await run(["restore"], { DATA_DIR: join(dir, "c") }, dir)).code, 2);
      const missing = await run(
        ["restore", join(dir, "nope.json")],
        {
          DATA_DIR: join(dir, "c"),
        },
        dir,
      );
      assertEquals(missing.code, 1);
      assertStringIncludes(missing.stderr, "There is no backup file");
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  },
);

test("snapshots record the last backup for the admin page", async () => {
  const dir = await fs.realpath(await Deno.makeTempDir());
  try {
    const local = await startLocalService(testConfig({ DATA_DIR: dir, SECRET_KEY }), silentLogger);
    try {
      const [row] = local.storage.sql.query<{ id: number }>(
        "INSERT INTO users (email, display_name, role, created_at) VALUES ('a@b.c', 'A', 'administrator', 1) RETURNING id",
      );
      const admin = { type: "user" as const, userId: row.id };
      assertEquals((await local.service.getAdminInfo(admin, {})).lastBackup, null);
      const file = await local.storage.snapshot();
      const info = await local.service.getAdminInfo(admin, {});
      assertEquals(info.lastBackup?.file, `backups/${file}`);
    } finally {
      local.storage.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("backup extraction works without opening the live database and refuses to overwrite an output", async () => {
  const dir = await Deno.makeTempDir();
  const dataDir = join(dir, "source");
  const source = await sourceInstance(dataDir);
  const expected = (await source.service.exportFiles(SYSTEM, {})).files;
  const storedAt = Date.UTC(2026, 9, 2);
  const key = backupKey(storedAt, "sqlite");
  try {
    const capture = join(dir, "capture.sqlite");
    await source.storage.snapshotTo(capture);
    const bytes = new Uint8Array(await fs.readFile(capture));
    await source.storage.store.write(key, bytes);
    source.storage.close();
    await fs.writeFile(join(dataDir, "quaso.sqlite"), "an unreadable live database");
    const named = join(dir, "named.sqlite");
    assertEquals((await run(["backup", key, named], { DATA_DIR: dataDir }, dir)).code, 0);
    assertEquals(new Uint8Array(await fs.readFile(named)), bytes);
    assertEquals((await run(["backup", key, named], { DATA_DIR: dataDir }, dir)).code, 1);
    assertEquals(new Uint8Array(await fs.readFile(named)), bytes);
    const timed = join(dir, "timed.sqlite");
    assertEquals(
      (
        await run(
          ["backup", "--at", new Date(storedAt + 1000).toISOString(), timed],
          { DATA_DIR: dataDir },
          dir,
        )
      ).code,
      0,
    );
    assertEquals(new Uint8Array(await fs.readFile(timed)), bytes);
    assertEquals((await run(["restore", timed], { DATA_DIR: join(dir, "restored") }, dir)).code, 0);
    assertEquals(await exportOf(join(dir, "restored")), expected);
    assertEquals(
      (
        await run(
          ["backup", "--at", "invalid", join(dir, "bad.sqlite")],
          { DATA_DIR: dataDir },
          dir,
        )
      ).code,
      2,
    );
    assertEquals(
      (
        await run(
          ["backup", "published/de/common.json", join(dir, "bad.sqlite")],
          { DATA_DIR: dataDir },
          dir,
        )
      ).code,
      1,
    );
  } finally {
    source.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});
