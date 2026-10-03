// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { makeTempDir } from "@quaso/runtime/files";
import * as fsSync from "node:fs";
/**
 * The administrators' routes with the real service: settings, languages, files, strings,
 * renames, the admin page, backup downloads (JSON and SQLite, with local and Cloudflare
 * storage) and the restore at setup.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@quaso/runtime/assert";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdminInfo, BackupDocument, SettingsResult } from "@quaso/core";
import {
  type Actor,
  ANONYMOUS,
  createService,
  createGeminiProvider,
  type ServiceOptions,
  handleServiceRequest,
  type Service,
  type ServiceApi,
  silentLogger,
  type SyncSql,
  SYSTEM,
} from "@quaso/service";
import { openNodeSqlite } from "@quaso/service/node-sqlite";
import { type App, createApp } from "../app.ts";
import type { Authenticator } from "../auth.ts";
import { startLocalService } from "../local_service.ts";
import { connectRemoteService } from "../storage/remote.ts";
import { call, memoryLogger, testConfig } from "../testing/helpers.ts";
import { SETUP_KEY_HEADER } from "./admin.ts";
import { backupKey } from "../../../service/src/stored_backups.ts";
import { restoreFile } from "../storage/backup_files.ts";

/** Signs requests in by `Authorization: Bearer <name>`, for the people a test made. */
function peopleAuth(people: Record<string, Actor>): Authenticator {
  return {
    actorFor: (request) => {
      const name = request.headers.get("Authorization")?.replace(/^Bearer /, "");
      return Promise.resolve(name ? (people[name] ?? ANONYMOUS) : ANONYMOUS);
    },
    recheck: () => Promise.resolve(),
    forget: () => {},
    scopeOf: () => null,
  };
}

function addUser(sql: SyncSql, role: string, name = `A ${role}`): Actor {
  const [row] = sql.query<{ id: number }>(
    `INSERT INTO users (email, display_name, role, created_at) VALUES (?, ?, ?, 1) RETURNING id`,
    `${crypto.randomUUID()}@example.com`,
    name,
    role,
  );
  return { type: "user", userId: row.id };
}

const COMMON = {
  title: "Wayfarer",
  menu: { play: "Play", quit: "Quit" },
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
};

interface Instance {
  service: Service;
  sql: SyncSql;
  close(): void;
}

/** A started service on an in-memory database. */
async function memoryService(options: Partial<ServiceOptions> = {}): Promise<Instance> {
  const database = openNodeSqlite(":memory:");
  const service = createService({
    ...options,
    sql: database.sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "test-secret-key-".repeat(4),
    logger: silentLogger,
  });
  await service.start();
  return { service, sql: database.sql, close: () => database.close() };
}

/** A project with strings and a translation, and an app whose people are named. */
async function project(service: Service, sql: SyncSql) {
  await service.upload(SYSTEM, {
    files: [
      {
        path: "common.json",
        repoPath: "common.json",
        content: JSON.stringify(COMMON, null, 2) + "\n",
      },
    ],
    languages: ["de", "pl"],
  });
  await service.importTranslations(SYSTEM, {
    language: "de",
    files: [{ path: "common.json", content: JSON.stringify({ title: "Wanderer" }) }],
    as: "blue",
  });
  return {
    admin: addUser(sql, "administrator", "Ada"),
    manager: addUser(sql, "manager", "Max"),
  };
}

function appFor(service: ServiceApi, people: Record<string, Actor>, extra = {}) {
  const log = memoryLogger();
  const app = createApp({
    config: testConfig(),
    service,
    log,
    version: "9.9.9",
    auth: peopleAuth(people),
    ...extra,
  });
  return { app, log };
}

const json = (response: Response) => response.json();

test("Gemini test route probes the saved key, lists compatible models and returns safe failures", async () => {
  const keys: string[] = [];
  let refused = false;
  const instance = await memoryService({
    providerFactory: (apiKey) =>
      createGeminiProvider({
        apiKey,
        fetch: async (_input, init) => {
          keys.push(new Headers(init?.headers).get("x-goog-api-key")!);
          if (refused)
            return Response.json({ error: { message: `echoed ${apiKey}` } }, { status: 401 });
          return Response.json({
            models: [
              { name: "models/model-a", supportedGenerationMethods: ["generateContent"] },
              { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
            ],
          });
        },
      }),
  });
  try {
    const people = await project(instance.service, instance.sql);
    const { app, log } = appFor(instance.service, people);
    const path = "/api/v1/settings/llm/test";
    assertEquals((await call(app, path, { method: "POST", json: {} })).status, 401);
    assertEquals(
      (
        await call(app, path, {
          method: "POST",
          headers: { Authorization: "Bearer manager" },
          json: {},
        })
      ).status,
      403,
    );
    assertEquals(keys, []);
    const value = "stored-gemini-key-1234";
    const status = await instance.service.setSecret(SYSTEM, { name: "gemini_api_key", value });
    const response = await call(app, path, {
      method: "POST",
      headers: { Authorization: "Bearer admin" },
      json: {},
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      models: ["model-a"],
      keyUpdatedAt: status.updatedAt,
    });
    assertEquals(keys, [value]);
    refused = true;
    const failed = await call(app, path, {
      method: "POST",
      headers: { Authorization: "Bearer admin" },
      json: {},
    });
    assertEquals(failed.status, 400);
    assertEquals((await failed.text()).includes(value), false);
    assertEquals(JSON.stringify(log.lines).includes(value), false);
  } finally {
    instance.close();
  }
});

test("secret routes require an administrator and never echo credentials", async () => {
  const instance = await memoryService();
  try {
    const people = await project(instance.service, instance.sql);
    const { app, log } = appFor(instance.service, people);
    const path = "/api/v1/settings/secrets/gemini_api_key";
    const value = "provider-secret-never-in-http-output-9231";
    assertEquals((await call(app, "/api/v1/settings/secrets")).status, 401);
    assertEquals(
      (
        await call(app, path, {
          method: "PUT",
          headers: { Authorization: "Bearer manager" },
          json: { value },
        })
      ).status,
      403,
    );
    const response = await call(app, path, {
      method: "PUT",
      headers: { Authorization: "Bearer admin" },
      json: { value },
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      name: "gemini_api_key",
      set: true,
      ending: "9231",
      updatedAt: instance.sql.query("SELECT updated_at FROM secrets")[0].updated_at,
    });
    const status = await call(app, "/api/v1/settings/secrets", {
      headers: { Authorization: "Bearer admin" },
    });
    assertEquals((await status.text()).includes(value), false);
    const activity = await call(app, "/api/v1/activity", {
      headers: { Authorization: "Bearer admin" },
    });
    assertEquals((await activity.text()).includes(value), false);
    assertEquals(JSON.stringify(log).includes(value), false);
    assertEquals(
      (await call(app, path, { method: "DELETE", headers: { Authorization: "Bearer admin" } }))
        .status,
      200,
    );
    assertEquals(instance.sql.query("SELECT * FROM secrets"), []);
  } finally {
    instance.close();
  }
});

test("admin routes: settings, languages, files, strings and renames", async () => {
  const instance = await memoryService();
  try {
    const people = await project(instance.service, instance.sql);
    const { app } = appFor(instance.service, people);
    const as = (name: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
      call(app, path, { ...init, headers: { Authorization: `Bearer ${name}` } });

    assertEquals((await call(app, "/api/v1/settings")).status, 401);
    assertEquals((await as("manager", "/api/v1/settings")).status, 403);
    const settings: SettingsResult = await json(await as("admin", "/api/v1/settings"));
    assertEquals(
      settings.languages.map((language) => language.tag),
      ["de", "pl"],
    );

    const patched = await as("admin", "/api/v1/settings", {
      method: "PATCH",
      json: { name: "Wayfarer", llm: { context: { glossary: false } } },
    });
    assertEquals(patched.status, 200);
    const after: SettingsResult = await json(patched);
    assertEquals(after.settings.name, "Wayfarer");
    assertEquals(after.settings.llm.context.glossary, false);
    assertEquals(after.settings.llm.context.fileContext, true);
    const invalid = await as("admin", "/api/v1/settings", {
      method: "PATCH",
      json: { llm: { promptTemplate: "No strings" } },
    });
    assertEquals(invalid.status, 400);
    assertEquals((await json(invalid)).error.code, "bad_request");

    const added = await as("admin", "/api/v1/languages", { method: "POST", json: { tag: "fr" } });
    assertEquals(added.status, 201);
    assertEquals((await json(added)).language.tag, "fr");
    const changed = await as("admin", "/api/v1/languages/pl", {
      method: "PATCH",
      json: { instructions: "Informal." },
    });
    assertEquals((await json(changed)).instructions, "Informal.");
    const removed = await as("admin", "/api/v1/languages/de", { method: "DELETE" });
    assertEquals(await json(removed), { ok: true });

    const file = await as("manager", "/api/v1/files/1", {
      method: "PATCH",
      json: { context: "Menus." },
    });
    assertEquals(file.status, 200);
    assertEquals((await json(file)).context, "Menus.");

    const string = await as("admin", "/api/v1/strings/1", {
      method: "PATCH",
      json: { description: "The title", maxLength: 20 },
    });
    assertEquals(await json(string), {
      id: 1,
      description: "The title",
      maxLength: 20,
      maxLengthLocked: false,
    });

    const rename = await as("admin", "/api/v1/renames", {
      method: "POST",
      json: { file: "common.json", from: "menu.play", to: "menu.quit" },
    });
    assertEquals(rename.status, 400);
    assertStringIncludes((await json(rename)).error.message, "the English still has it");
  } finally {
    instance.close();
  }
});

test("GET /admin adds the server's version, setup and recent errors", async () => {
  const instance = await memoryService();
  try {
    const people = await project(instance.service, instance.sql);
    const { app, log } = appFor(instance.service, people, { storage: "cloudflare" });
    log.error("Something broke", { requestId: "r-1" });
    const response = await call(app, "/api/v1/admin", {
      headers: { Authorization: "Bearer admin" },
    });
    assertEquals(response.status, 200);
    const info: AdminInfo = await response.json();
    assertEquals(info.version, "9.9.9");
    assertEquals(info.setup, "cloudflare");
    assertEquals(
      info.recentErrors.map((error) => error.message),
      ["Something broke"],
    );
    assertEquals(info.recentErrors[0].requestId, "r-1");
    assert(info.database.revision > 0);
    const denied = await call(app, "/api/v1/admin", {
      headers: { Authorization: "Bearer manager" },
    });
    assertEquals(denied.status, 403);

    // A restore that didn't finish comes first: the data may be incomplete.
    instance.sql.run(
      "INSERT INTO meta (key, value) VALUES ('restore', ?)",
      JSON.stringify({ schemaVersion: 1, startedAt: 1_000 }),
    );
    const unfinished: AdminInfo = await (
      await call(app, "/api/v1/admin", {
        headers: { Authorization: "Bearer admin" },
      })
    ).json();
    assertEquals(
      unfinished.recentErrors.map((error) => error.at),
      [1_000, info.recentErrors[0].at],
    );
    assertStringIncludes(unfinished.recentErrors[0].message, "restore of a backup didn't finish");
  } finally {
    instance.close();
  }
});

test("GET /backup?format=json streams the backup document", async () => {
  const instance = await memoryService();
  try {
    const people = await project(instance.service, instance.sql);
    const { app } = appFor(instance.service, people);
    const response = await call(app, "/api/v1/backup?format=json", {
      headers: { Authorization: "Bearer admin" },
    });
    assertEquals(response.status, 200);
    assertMatch(
      response.headers.get("Content-Disposition") ?? "",
      /^attachment; filename="quaso-backup-\d{8}T\d{6}Z\.json"$/,
    );
    assertEquals(response.headers.get("Cache-Control"), "private, no-store");
    const document: BackupDocument = await response.json();
    assertEquals(document.format, "quaso-backup");
    const strings = instance.sql.query("SELECT * FROM strings ORDER BY id");
    assertEquals(document.tables.strings, strings);
    const denied = await call(app, "/api/v1/backup?format=json", {
      headers: { Authorization: "Bearer manager" },
    });
    assertEquals(denied.status, 403);
    assertEquals(
      (
        await call(app, "/api/v1/backup?format=zip", {
          headers: { Authorization: "Bearer admin" },
        })
      ).status,
      400,
    );
  } finally {
    instance.close();
  }
});

/** Saves a response's body to a file and opens it as a SQLite database. */
async function downloadDatabase(response: Response, dir: string): Promise<DatabaseSync> {
  assertEquals(
    response.status,
    200,
    await response
      .clone()
      .text()
      .catch(() => ""),
  );
  assertEquals(response.headers.get("Content-Type"), "application/vnd.sqlite3");
  assertMatch(
    response.headers.get("Content-Disposition") ?? "",
    /filename="quaso-backup-\d{8}T\d{6}Z\.sqlite"/,
  );
  const path = join(await fs.realpath(dir), "download.sqlite");
  await fs.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  return new DatabaseSync(path, { readOnly: true });
}

/** Every table's rows, by table, as a database has them. */
function tables(read: (sql: string) => Record<string, unknown>[]) {
  const names = read(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => String(row.name));
  return Object.fromEntries(
    names.map((name) => [name, read(`SELECT * FROM "${name}" ORDER BY rowid`)]),
  );
}

function plain(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({ ...row }));
}

test("GET /backup with local storage: a consistent SQLite copy, then the file is gone", async () => {
  const dir = await makeTempDir();
  const config = testConfig({ DATA_DIR: dir, SECRET_KEY: "k".repeat(64) });
  const local = await startLocalService(config, silentLogger);
  try {
    const people = await project(local.service, local.storage.sql);
    const { app } = appFor(local.service, people, {
      backups: { snapshotTo: local.storage.snapshotTo, tempDir: local.storage.tempDir },
    });
    const response = await call(app, "/api/v1/backup", {
      headers: { Authorization: "Bearer admin" },
    });
    const copy = await downloadDatabase(response, dir);
    try {
      const read = (sql: string) => plain(copy.prepare(sql).all() as Record<string, unknown>[]);
      assertEquals(
        tables(read),
        { ...tables((sql) => local.storage.sql.query(sql)), secrets: [] },
      );
    } finally {
      copy.close();
    }
    assertEquals(
      [...fsSync.readdirSync(local.storage.tempDir, { withFileTypes: true })],
      [],
      "the temporary file is gone",
    );
  } finally {
    local.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("GET /backup selects retained and pre-migration copies, checks permission and restores the earlier project", async () => {
  const dir = await makeTempDir();
  const source = await startLocalService(
    testConfig({ DATA_DIR: join(dir, "source") }),
    silentLogger,
  );
  const target = await startLocalService(
    testConfig({ DATA_DIR: join(dir, "target") }),
    silentLogger,
  );
  try {
    const people = await project(source.service, source.storage.sql);
    const expected = (await source.service.exportFiles(SYSTEM, {})).files;
    const firstAt = Date.UTC(2026, 9, 2);
    const secondAt = firstAt + 3_600_000;
    const firstKey = backupKey(firstAt, "sqlite");
    const captured = join(dir, "capture.sqlite");
    await source.storage.snapshotTo(captured);
    await source.storage.store.write(firstKey, new Uint8Array(await fs.readFile(captured)));
    await source.service.importTranslations(SYSTEM, {
      language: "de",
      files: [{ path: "common.json", content: '{"title":"Later title"}' }],
      as: "blue",
      overwrite: true,
    });
    await source.storage.snapshotTo(captured);
    await source.storage.store.write(
      backupKey(secondAt, "sqlite"),
      new Uint8Array(await fs.readFile(captured)),
    );
    await source.storage.beforeMigrate(5, 6);
    const migrationKeys = [];
    for await (const object of source.storage.store.list("backups/pre-migration-"))
      migrationKeys.push(object.key);
    const { app } = appFor(source.service, people, {
      backups: {
        snapshotTo: source.storage.snapshotTo,
        tempDir: source.storage.tempDir,
        store: source.storage.store,
      },
    });
    const auth = { headers: { Authorization: "Bearer admin" } };
    const at = encodeURIComponent(new Date(firstAt + 1000).toISOString());
    assertEquals((await call(app, `/api/v1/backup?at=${at}`)).status, 401);
    assertEquals(
      (await call(app, `/api/v1/backup?at=${at}`, { headers: { Authorization: "Bearer manager" } }))
        .status,
      403,
    );
    assertEquals(
      (await call(app, "/api/v1/backup?file=published/de/common.json", auth)).status,
      400,
    );
    assertEquals((await call(app, `/api/v1/backup?at=${at}&file=${firstKey}`, auth)).status, 400);
    assertEquals((await call(app, "/api/v1/backup?at=2026-01-01T00:00Z", auth)).status, 404);
    const jsonResponse = await call(app, `/api/v1/backup?at=${at}&format=json`, auth);
    assertEquals(jsonResponse.status, 200);
    const document: BackupDocument = await jsonResponse.json();
    assertEquals(
      document.tables.translations.map((row) => row.value),
      ['"Wanderer"'],
    );
    const migration = await call(
      app,
      `/api/v1/backup?file=${encodeURIComponent(migrationKeys[0])}`,
      auth,
    );
    const migratedCopy = await downloadDatabase(migration, dir);
    try {
      assertEquals(
        migratedCopy.prepare("SELECT value FROM translations").get()?.value,
        '"Later title"',
      );
    } finally {
      migratedCopy.close();
    }
    const previous = await call(app, `/api/v1/backup?at=${at}`, auth);
    const oldCopy = await downloadDatabase(previous, dir);
    oldCopy.close();
    await restoreFile(target.service, join(dir, "download.sqlite"), {
      tempDir: target.storage.tempDir,
    });
    assertEquals((await target.service.exportFiles(SYSTEM, {})).files, expected);
    assertEquals(
      (await target.service.getPublishedFile(SYSTEM, { file: "common.json", language: "de" }))
        .content,
      expected[0].content,
    );
    assertEquals(await fs.readdir(source.storage.tempDir), []);
  } finally {
    source.storage.close();
    target.storage.close();
    await fs.rm(dir, { recursive: true });
  }
});

/** A fetch that answers like the Worker's internal API. */
function workerStub(service: ServiceApi, token: string): Fetch {
  return (input, init) => handleServiceRequest(new Request(input, init), service, { token });
}

test("GET /backup with Cloudflare storage: a SQLite file built from the rows", async () => {
  const dir = await makeTempDir();
  const instance = await memoryService();
  try {
    const people = await project(instance.service, instance.sql);
    const token = "internal-token-for-the-tests-0123456789";
    const env = {
      SERVICES_URL: "https://quaso.test/internal",
      SERVICE_TOKEN: token,
      SECRET_KEY: "k".repeat(64),
    };
    const remote = await connectRemoteService(testConfig(env), silentLogger, {
      fetch: workerStub(instance.service, token),
    });
    const { app } = appFor(remote, people, { storage: "cloudflare" });
    const response = await call(app, "/api/v1/backup?format=sqlite", {
      headers: { Authorization: "Bearer admin" },
    });
    const copy = await downloadDatabase(response, dir);
    try {
      const read = (sql: string) => plain(copy.prepare(sql).all() as Record<string, unknown>[]);
      const expected = tables((sql) => instance.sql.query(sql));
      for (const secret of ["sessions", "email_tokens"]) {
        if (secret in expected) expected[secret] = [];
      }
      assertEquals(tables(read), expected);
    } finally {
      copy.close();
    }
  } finally {
    instance.close();
    await fs.rm(dir, { recursive: true });
  }
});

/** An app on a new instance, in setup (no administrator yet), with its setup key. */
async function newInstance() {
  const instance = await memoryService();
  const { token } = await instance.service.ensureSetupToken(SYSTEM, {});
  const { app } = appFor(instance.service, {});
  return { ...instance, app, token: token! };
}

async function restore(app: App, body: BodyInit, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers[SETUP_KEY_HEADER] = token;
  return await call(app, "/api/v1/restore", { method: "POST", body, headers });
}

test("POST /restore: only with the setup key, only before setup", async () => {
  const source = await memoryService();
  const target = await newInstance();
  try {
    const people = await project(source.service, source.sql);
    const backup = await (
      await call(appFor(source.service, people).app, "/api/v1/backup?format=json", {
        headers: { Authorization: "Bearer admin" },
      })
    ).text();

    const missing = await restore(target.app, backup);
    assertEquals(missing.status, 401);
    const wrong = await restore(target.app, backup, "not-the-token");
    assertEquals(wrong.status, 403);
    assertEquals((await json(wrong)).error.code, "forbidden");
    const empty = await restore(target.app, "", target.token);
    assertEquals(empty.status, 400);

    const response = await restore(target.app, backup, target.token);
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.tables.strings, 4);
    const restored = await target.service.getProject(ANONYMOUS, {});
    assertEquals(restored.details.strings, 4);
    assertEquals(
      (await target.service.exportFiles(SYSTEM, {})).files,
      (await source.service.exportFiles(SYSTEM, {})).files,
    );

    // Set up now: the token is spent, and the instance isn't empty.
    const again = await restore(target.app, backup, target.token);
    assertEquals(again.status, 403);
  } finally {
    source.close();
    target.close();
  }
});

test("POST /restore takes SQLite files and gzip-compressed JSON too", async () => {
  const source = await memoryService();
  const dir = await makeTempDir();
  try {
    const people = await project(source.service, source.sql);
    const { app } = appFor(source.service, people);
    const download = await call(app, "/api/v1/backup?format=sqlite", {
      headers: { Authorization: "Bearer admin" },
    });
    assertEquals(download.status, 200);
    const sqlite = new Uint8Array(await download.arrayBuffer());
    assertEquals(new TextDecoder().decode(sqlite.subarray(0, 15)), "SQLite format 3");
    const text = await (
      await call(app, "/api/v1/backup?format=json", {
        headers: { Authorization: "Bearer admin" },
      })
    ).text();
    const gzip = await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();

    for (const body of [sqlite, gzip]) {
      const target = await newInstance();
      try {
        const response = await restore(target.app, body, target.token);
        assertEquals(response.status, 200, await response.clone().text());
        assertEquals(
          (await target.service.exportFiles(SYSTEM, {})).files,
          (await source.service.exportFiles(SYSTEM, {})).files,
        );
      } finally {
        target.close();
      }
    }
    const target = await newInstance();
    try {
      const garbage = await restore(target.app, "this is no backup", target.token);
      assertEquals(garbage.status, 400);
      assertEquals((await target.service.getProject(ANONYMOUS, {})).details.strings, 0);
    } finally {
      target.close();
    }
  } finally {
    source.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("the OpenAPI document lists the administrators' routes", async () => {
  const instance = await memoryService();
  try {
    const { app } = appFor(instance.service, {});
    const document = await (await call(app, "/api/v1/openapi.json")).json();
    assert(document.paths["/settings"].patch);
    assert(document.paths["/languages/{tag}"].delete);
    assertEquals(Object.keys(document.paths["/backup"].get.responses["200"].content), [
      "application/vnd.sqlite3",
      "application/json",
    ]);
    assert(document.paths["/restore"].post.requestBody.content["application/vnd.sqlite3"]);
    assertStringIncludes(document.paths["/restore"].post.description, "setup key");
  } finally {
    instance.close();
  }
});
