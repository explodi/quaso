// SPDX-License-Identifier: MIT
import { makeTempDir } from "@quaso/runtime/files";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import * as fsSync from "node:fs";
/**
 * Backup files: each download is the instance at one moment (a snapshot with local
 * storage; with Cloudflare storage, rows read at one state, started again after a write),
 * snapshots are single files, and SQLite backups restore from read-only folders.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@quaso/runtime/assert";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { BackupDocument } from "@quaso/core";
import {
  type Actor,
  createService,
  documentSource,
  restoreBackup,
  type Service,
  type ServiceApi,
  ServiceError,
  silentLogger,
  type SyncSql,
  SYSTEM,
} from "@quaso/service";
import { openNodeSqlite } from "@quaso/service/node-sqlite";
import { startLocalService } from "../local_service.ts";
import { testConfig } from "../testing/helpers.ts";
import { jsonBackupResponse, restoreFile, sqliteBackupResponse } from "./backup_files.ts";

const SECRET_KEY = "b".repeat(64);

test("downloaded snapshots erase credentials while the operator database retains them", async () => {
  const dir = await tempDir();
  const local = await startLocalService(
    testConfig({ DATA_DIR: join(dir, "data"), SECRET_KEY }),
    silentLogger,
  );
  const credential = "provider-key-only-in-operator-storage-8d0b";
  const target = await memoryService();
  try {
    const admin = await project(local.service, local.storage.sql);
    await local.service.setSecret(admin, { name: "gemini_api_key", value: credential });
    const options = { snapshotTo: local.storage.snapshotTo, tempDir: local.storage.tempDir };
    const response = await sqliteBackupResponse(local.service, admin, options);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertEquals(Buffer.from(bytes).includes(Buffer.from(credential)), false);
    const path = join(dir, "download.sqlite");
    await fs.writeFile(path, bytes);
    const download = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(Number(download.prepare("SELECT COUNT(*) AS n FROM secrets").get()!.n), 0);
    } finally {
      download.close();
    }
    const result = await restoreFile(target.service, path, { tempDir: dir });
    assertEquals(result.missingSecrets, ["gemini_api_key"]);
    assertEquals(
      (await target.service.listSecrets(SYSTEM, {})).missingSecrets,
      result.missingSecrets,
    );
    const json = await jsonBackupResponse(local.service, admin, options);
    const document = await json.text();
    assertEquals(document.includes(credential), false);
    assertEquals(Object.hasOwn(JSON.parse(document).tables, "secrets"), false);
    assertEquals(
      local.storage.sql.query("SELECT value FROM secrets WHERE name = 'gemini_api_key'")[0].value,
      credential,
    );
    assertEquals(fsSync.readdirSync(local.storage.tempDir), []);
  } finally {
    target.close();
    local.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});

interface Instance {
  service: Service;
  sql: SyncSql;
  close(): void;
}

async function memoryService(): Promise<Instance> {
  const database = openNodeSqlite(":memory:");
  const service = createService({
    sql: database.sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: SECRET_KEY,
    logger: silentLogger,
  });
  await service.start();
  return { service, sql: database.sql, close: () => database.close() };
}

/** A project with a German translation, and its administrator. */
async function project(service: ServiceApi, sql: SyncSql): Promise<Actor> {
  await service.upload(SYSTEM, {
    files: [
      {
        path: "common.json",
        repoPath: "common.json",
        content: '{\n  "title": "Wayfarer",\n  "play": "Play"\n}\n',
      },
    ],
    languages: ["de"],
  });
  await translate(service, "title", "Wanderer");
  const [row] = sql.query<{ id: number }>(
    `INSERT INTO users (email, display_name, role, created_at)
     VALUES ('ada@example.com', 'Ada', 'administrator', 1) RETURNING id`,
  );
  return { type: "user", userId: row.id };
}

/** A German translation, with its history row: one write. */
async function translate(service: ServiceApi, key: string, value: string): Promise<void> {
  await service.importTranslations(SYSTEM, {
    language: "de",
    files: [{ path: "common.json", content: JSON.stringify({ [key]: value }) }],
    as: "blue",
  });
}

/**
 * The service as the server reaches Cloudflare storage: separate calls, and another
 * request (a translator saving) between two of them, the first time only.
 */
function writeBetweenCalls(service: ServiceApi) {
  const counts = { backups: 0, wrote: false };
  return {
    counts,
    service: {
      backupInfo(actor: Actor, input: Record<string, never>) {
        counts.backups++;
        return service.backupInfo(actor, input);
      },
      async backupTables(actor: Actor, input: Parameters<ServiceApi["backupTables"]>[1]) {
        if (!counts.wrote && input.table === "translations") {
          counts.wrote = true;
          await translate(service, "play", "Spielen");
        }
        return await service.backupTables(actor, input);
      },
    },
  };
}

type Row = Record<string, unknown>;

/** A translation's rows and the history rows of translations, from any database. */
function translationFacts(query: (sql: string) => Row[]) {
  return {
    translations: query("SELECT string_id, language, value FROM translations ORDER BY rowid").map(
      (row) => ({ ...row }),
    ),
    history: query(
      "SELECT string_id, language, event FROM history WHERE language IS NOT NULL ORDER BY id",
    ).map((row) => ({ ...row })),
  };
}

async function tempDir(): Promise<string> {
  return await fs.realpath(await makeTempDir({ prefix: "quaso-backup-test-" }));
}

test("the SQLite file built from rows is one moment's copy: a write between two calls starts it again", async () => {
  const dir = await tempDir();
  const instance = await memoryService();
  try {
    const admin = await project(instance.service, instance.sql);
    const credential = "remote-provider-secret-should-never-download-7132";
    await instance.service.setSecret(admin, { name: "email_api_key", value: credential });
    const remote = writeBetweenCalls(instance.service);
    const response = await sqliteBackupResponse(remote.service, admin, { tempDir: dir });
    const path = join(dir, "download.sqlite");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertEquals(Buffer.from(bytes).includes(Buffer.from(credential)), false);
    await fs.writeFile(path, bytes);
    // Once for the permission, then twice: the write made the first read start again.
    assertEquals(remote.counts.backups, 3);
    const file = new DatabaseSync(path, { readOnly: true });
    try {
      const facts = translationFacts((sql) => file.prepare(sql).all() as Row[]);
      // The translation made meanwhile is there with its history, as in the database.
      assertEquals(
        facts,
        translationFacts((sql) => instance.sql.query(sql)),
      );
      assertEquals(facts.translations.length, 2);
    } finally {
      file.close();
    }
    assertEquals(
      [...fsSync.readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
      ["download.sqlite"],
    );
  } finally {
    instance.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("the JSON document with Cloudflare storage is one moment's copy too, and restores", async () => {
  const dir = await tempDir();
  const instance = await memoryService();
  const target = await memoryService();
  try {
    const admin = await project(instance.service, instance.sql);
    const credential = "remote-provider-secret-should-never-download-7132";
    await instance.service.setSecret(admin, { name: "email_api_key", value: credential });
    const remote = writeBetweenCalls(instance.service);
    const response = await jsonBackupResponse(remote.service, admin, { tempDir: dir });
    const document: BackupDocument = await response.json();
    assertEquals(JSON.stringify(document).includes(credential), false);
    assertEquals(Object.hasOwn(document.tables, "secrets"), false);
    assertEquals(remote.counts.backups, 3);
    assertEquals(document.tables.translations.length, 2);
    assertEquals(
      document.tables.history.filter((row) => row.language !== null).length,
      translationFacts((sql) => instance.sql.query(sql)).history.length,
    );
    const result = await restoreBackup(target.service, documentSource(document));
    assertEquals(result.missingSecrets, ["email_api_key"]);
    assertEquals(
      (await target.service.exportFiles(SYSTEM, {})).files,
      (await instance.service.exportFiles(SYSTEM, {})).files,
    );
    assertEquals(
      [...fsSync.readdirSync(dir, { withFileTypes: true })],
      [],
      "the temporary file is gone",
    );

    // Writes that never stop: the download fails, loudly, instead of being inconsistent.
    const busy = {
      backupInfo: (actor: Actor, input: Record<string, never>) =>
        instance.service.backupInfo(actor, input),
      async backupTables(actor: Actor, input: Parameters<ServiceApi["backupTables"]>[1]) {
        if (input.table === "translations") {
          await instance.service.createApiToken(SYSTEM, { name: "CI", scope: "read" });
        }
        return await instance.service.backupTables(actor, input);
      },
    };
    const error = await assertRejects(
      () => jsonBackupResponse(busy, admin, { tempDir: dir }),
      ServiceError,
    );
    assertEquals(error.code, "unavailable");
    assertEquals([...fsSync.readdirSync(dir, { withFileTypes: true })], []);
  } finally {
    instance.close();
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("with local storage the JSON document is read from a snapshot: later writes aren't in it", async () => {
  const dir = await tempDir();
  const local = await startLocalService(
    testConfig({ DATA_DIR: join(dir, "data"), SECRET_KEY }),
    silentLogger,
  );
  const target = await memoryService();
  try {
    const admin = await project(local.service, local.storage.sql);
    const before = translationFacts((sql) => local.storage.sql.query(sql));
    const response = await jsonBackupResponse(local.service, admin, {
      snapshotTo: local.storage.snapshotTo,
      tempDir: local.storage.tempDir,
    });
    // A translator saves while the document is on its way.
    await translate(local.service, "play", "Spielen");
    const document: BackupDocument = await response.json();
    assertEquals(
      document.tables.translations.map((row) => row.value),
      ['"Wanderer"'],
    );
    assertEquals(
      document.tables.history.filter((row) => row.language !== null).length,
      before.history.length,
    );
    assertEquals(
      [...fsSync.readdirSync(local.storage.tempDir, { withFileTypes: true })],
      [],
      "the snapshot is gone",
    );
    await restoreBackup(target.service, documentSource(document));
    assertEquals(
      translationFacts((sql) => target.sql.query(sql)),
      before,
    );

    // Only administrators, checked before any snapshot is taken.
    const denied = await assertRejects(
      () =>
        jsonBackupResponse(
          local.service,
          { type: "anonymous" },
          {
            snapshotTo: local.storage.snapshotTo,
            tempDir: local.storage.tempDir,
          },
        ),
      ServiceError,
    );
    assertEquals(denied.code, "unauthorized");
    assertEquals([...fsSync.readdirSync(local.storage.tempDir, { withFileTypes: true })], []);
  } finally {
    local.storage.close();
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});

/** Header bytes 18 and 19: 2 and 2 for WAL mode, 1 and 1 for a rollback journal. */
async function journalBytes(path: string): Promise<number[]> {
  return [...(await fs.readFile(path)).subarray(18, 20)];
}

async function readOnly(dir: string, on: boolean): Promise<void> {
  if (process.platform !== "win32") await fs.chmod(dir, on ? 0o555 : 0o755);
}

test("SQLite backups restore from a read-only folder, and leave nothing beside them", async () => {
  const dir = await tempDir();
  const local = await startLocalService(
    testConfig({ DATA_DIR: join(dir, "data"), SECRET_KEY }),
    silentLogger,
  );
  const mount = join(dir, "backups");
  await fs.mkdir(mount);
  try {
    await project(local.service, local.storage.sql);
    const expected = (await local.service.exportFiles(SYSTEM, {})).files;
    // A snapshot (the SQLite download with local storage) is one file, not in WAL mode.
    await local.storage.snapshotTo(join(mount, "snapshot.sqlite"));
    assertEquals(await journalBytes(join(mount, "snapshot.sqlite")), [1, 1]);
    // One from before this release: in WAL mode, as the database is.
    await backup(local.storage.db, join(mount, "old.sqlite"));
    assertEquals(await journalBytes(join(mount, "old.sqlite")), [2, 2]);
    await readOnly(mount, true);

    for (const name of ["snapshot.sqlite", "old.sqlite"]) {
      const target = await memoryService();
      const temp = await makeTempDir({ dir });
      try {
        const result = await restoreFile(target.service, join(mount, name), { tempDir: temp });
        assertEquals(result.tables.revision_guard, undefined);
        assertEquals(result.tables.strings, 2, name);
        assertEquals((await target.service.exportFiles(SYSTEM, {})).files, expected, name);
        assertEquals(
          [...fsSync.readdirSync(temp, { withFileTypes: true })],
          [],
          `${name}: the copy is gone`,
        );
      } finally {
        target.close();
      }
    }
    assertEquals(
      [...fsSync.readdirSync(mount, { withFileTypes: true })].map((entry) => entry.name).sort(),
      ["old.sqlite", "snapshot.sqlite"],
      "no -wal or -shm files beside the backups",
    );
  } finally {
    await readOnly(mount, false);
    local.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("a SQLite file that isn't Quaso's is refused as such", async () => {
  const dir = await tempDir();
  const target = await memoryService();
  try {
    const path = join(dir, "other.sqlite");
    const other = new DatabaseSync(path);
    other.exec("CREATE TABLE notes (text TEXT)");
    other.close();
    const error = await assertRejects(() => restoreFile(target.service, path), ServiceError);
    assertEquals(error.code, "bad_request");
    assertStringIncludes(error.message, "isn't a Quaso database");
    assert((await target.service.getProject(SYSTEM, {})).details.strings === 0);
  } finally {
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("Beta 1 SQLite and JSON backups are rejected before the destination changes", async () => {
  const dir = await tempDir();
  const target = await memoryService();
  try {
    const path = join(dir, "beta-1.sqlite");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '4')",
    );
    old.close();
    const before = await target.service.backupInfo(SYSTEM, {});
    const sqliteError = await assertRejects(() => restoreFile(target.service, path), ServiceError);
    assertStringIncludes(sqliteError.message, "Beta 1 (1.0.0-rc.1) backups are not supported");
    const jsonPath = join(dir, "beta-1.json");
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        format: "quaso-backup",
        version: 1,
        schemaVersion: 4,
        tables: { meta: [{ key: "schema_version", value: "4" }] },
      }),
    );
    const jsonError = await assertRejects(
      () => restoreFile(target.service, jsonPath),
      ServiceError,
    );
    assertStringIncludes(jsonError.message, "Beta 1 (1.0.0-rc.1) backups are not supported");
    const gzipPath = join(dir, "beta-1.json.gz");
    await fs.writeFile(gzipPath, Bun.gzipSync(await fs.readFile(jsonPath)));
    const gzipError = await assertRejects(
      () => restoreFile(target.service, gzipPath),
      ServiceError,
    );
    assertStringIncludes(gzipError.message, "Beta 1 (1.0.0-rc.1) backups are not supported");
    const after = await target.service.backupInfo(SYSTEM, {});
    assertEquals(after.state, before.state);
    assertEquals(after.tables, before.tables);
  } finally {
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});
