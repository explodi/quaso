// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import * as fsSync from "node:fs";
/**
 * Backup files: each download is the instance at one moment (a snapshot with local
 * storage; with Cloudflare storage, rows read at one state, started again after a write),
 * snapshots are single files, and SQLite backups restore from read-only folders.
 */
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
    expect(Buffer.from(bytes).includes(Buffer.from(credential))).toBe(false);
    const path = join(dir, "download.sqlite");
    await fs.writeFile(path, bytes);
    const download = new DatabaseSync(path, { readOnly: true });
    try {
      expect(Number(download.prepare("SELECT COUNT(*) AS n FROM secrets").get()!.n)).toStrictEqual(
        0,
      );
    } finally {
      download.close();
    }
    const result = await restoreFile(target.service, path, { tempDir: dir });
    expect(result.missingSecrets).toStrictEqual(["gemini_api_key"]);
    expect((await target.service.listSecrets(SYSTEM, {})).missingSecrets).toStrictEqual(
      result.missingSecrets,
    );
    const json = await jsonBackupResponse(local.service, admin, options);
    const document = await json.text();
    expect(document.includes(credential)).toBe(false);
    expect(Object.hasOwn(JSON.parse(document).tables, "secrets")).toBe(false);
    expect(
      local.storage.sql.query("SELECT value FROM secrets WHERE name = 'gemini_api_key'")[0].value,
    ).toStrictEqual(credential);
    expect(fsSync.readdirSync(local.storage.tempDir)).toStrictEqual([]);
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
  return await fs.realpath(await fs.mkdtemp(join(tmpdir(), "quaso-backup-test-")));
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
    expect(Buffer.from(bytes).includes(Buffer.from(credential))).toBe(false);
    await fs.writeFile(path, bytes);
    // Once for the permission, then twice: the write made the first read start again.
    expect(remote.counts.backups).toBe(3);
    const file = new DatabaseSync(path, { readOnly: true });
    try {
      const facts = translationFacts((sql) => file.prepare(sql).all() as Row[]);
      // The translation made meanwhile is there with its history, as in the database.
      expect(facts).toStrictEqual(translationFacts((sql) => instance.sql.query(sql)));
      expect(facts.translations.length).toBe(2);
    } finally {
      file.close();
    }
    expect(
      [...fsSync.readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
    ).toStrictEqual(["download.sqlite"]);
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
    expect(JSON.stringify(document).includes(credential)).toBe(false);
    expect(Object.hasOwn(document.tables, "secrets")).toBe(false);
    expect(remote.counts.backups).toBe(3);
    expect(document.tables.translations.length).toBe(2);
    expect(document.tables.history.filter((row) => row.language !== null).length).toStrictEqual(
      translationFacts((sql) => instance.sql.query(sql)).history.length,
    );
    const result = await restoreBackup(target.service, documentSource(document));
    expect(result.missingSecrets).toStrictEqual(["email_api_key"]);
    expect((await target.service.exportFiles(SYSTEM, {})).files).toStrictEqual(
      (await instance.service.exportFiles(SYSTEM, {})).files,
    );
    expect(
      [...fsSync.readdirSync(dir, { withFileTypes: true })],
      "the temporary file is gone",
    ).toStrictEqual([]);

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
    const error = await jsonBackupResponse(busy, admin, { tempDir: dir }).catch(
      (error: unknown) => error,
    );
    assert(error instanceof ServiceError);
    expect(error.code).toBe("unavailable");
    expect([...fsSync.readdirSync(dir, { withFileTypes: true })]).toStrictEqual([]);
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
    expect(document.tables.translations.map((row) => row.value)).toStrictEqual(['"Wanderer"']);
    expect(document.tables.history.filter((row) => row.language !== null).length).toStrictEqual(
      before.history.length,
    );
    expect(
      [...fsSync.readdirSync(local.storage.tempDir, { withFileTypes: true })],
      "the snapshot is gone",
    ).toStrictEqual([]);
    await restoreBackup(target.service, documentSource(document));
    expect(translationFacts((sql) => target.sql.query(sql))).toStrictEqual(before);

    // Only administrators, checked before any snapshot is taken.
    const denied = await jsonBackupResponse(
      local.service,
      { type: "anonymous" },
      {
        snapshotTo: local.storage.snapshotTo,
        tempDir: local.storage.tempDir,
      },
    ).catch((error: unknown) => error);
    assert(denied instanceof ServiceError);
    expect(denied.code).toBe("unauthorized");
    expect([...fsSync.readdirSync(local.storage.tempDir, { withFileTypes: true })]).toStrictEqual(
      [],
    );
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
    expect(await journalBytes(join(mount, "snapshot.sqlite"))).toStrictEqual([1, 1]);
    // One from before this release: in WAL mode, as the database is.
    await backup(local.storage.db, join(mount, "old.sqlite"));
    expect(await journalBytes(join(mount, "old.sqlite"))).toStrictEqual([2, 2]);
    await readOnly(mount, true);

    for (const name of ["snapshot.sqlite", "old.sqlite"]) {
      const target = await memoryService();
      const temp = await fs.mkdtemp(join(dir, "restore-"));
      try {
        const result = await restoreFile(target.service, join(mount, name), { tempDir: temp });
        expect(result.tables.revision_guard).toBe(undefined);
        expect(result.tables.strings, name).toBe(2);
        expect((await target.service.exportFiles(SYSTEM, {})).files, name).toStrictEqual(expected);
        expect(
          [...fsSync.readdirSync(temp, { withFileTypes: true })],
          `${name}: the copy is gone`,
        ).toStrictEqual([]);
      } finally {
        target.close();
      }
    }
    expect(
      [...fsSync.readdirSync(mount, { withFileTypes: true })].map((entry) => entry.name).sort(),
      "no -wal or -shm files beside the backups",
    ).toStrictEqual(["old.sqlite", "snapshot.sqlite"]);
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
    const error = await restoreFile(target.service, path).catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("isn't a Quaso database");
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
    const sqliteError = await restoreFile(target.service, path).catch((error: unknown) => error);
    assert(sqliteError instanceof ServiceError);
    expect(sqliteError.message).toContain("Beta 1 (1.0.0-rc.1) backups are not supported");
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
    const jsonError = await restoreFile(target.service, jsonPath).catch((error: unknown) => error);
    assert(jsonError instanceof ServiceError);
    expect(jsonError.message).toContain("Beta 1 (1.0.0-rc.1) backups are not supported");
    const gzipPath = join(dir, "beta-1.json.gz");
    await fs.writeFile(gzipPath, gzipSync(await fs.readFile(jsonPath)));
    const gzipError = await restoreFile(target.service, gzipPath).catch((error: unknown) => error);
    assert(gzipError instanceof ServiceError);
    expect(gzipError.message).toContain("Beta 1 (1.0.0-rc.1) backups are not supported");
    const after = await target.service.backupInfo(SYSTEM, {});
    expect(after.state).toStrictEqual(before.state);
    expect(after.tables).toStrictEqual(before.tables);
  } finally {
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("a gzip backup that expands past the limit is refused as too large", async () => {
  const dir = await tempDir();
  const target = await memoryService();
  try {
    const path = join(dir, "bomb.json.gz");
    await fs.writeFile(path, gzipSync(new Uint8Array(2 * 1024 * 1024)));
    const error = await restoreFile(target.service, path, { maxJsonBytes: 1024 * 1024 }).catch(
      (error: unknown) => error,
    );
    assert(error instanceof ServiceError);
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toBe("The backup's JSON document is larger than 1 MB.");
  } finally {
    target.close();
    await fs.rm(dir, { recursive: true });
  }
});
