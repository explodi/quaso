// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import type { BackupDocument } from "@quaso/core";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import {
  BACKUP_CHANGED,
  backupJsonStream,
  type BackupReader,
  documentSource,
  fromJsonValue,
  restoreBackup,
  SECRET_TABLES,
  sqlBackupReader,
  toJsonValue,
  withBackupRetries,
} from "./backup.ts";
import { getRevision } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { drain } from "./jobs/testing.ts";
import { createFakeTranslator } from "./llm/fake.ts";
import { DATABASE_VERSION } from "./migrations.ts";
import type { Service } from "./service.ts";
import {
  addUser,
  count,
  START_TIME,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";
import { NEXT_ALARM } from "./wakeups.ts";

/** Enough strings for several chunks of every table. */
function bigFile(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, `Text number ${i}`]));
}

/** An instance with a bit of everything: strings, translations, history, keys, people. */
async function richInstance(): Promise<TestInstance & { admin: Actor; secret: string }> {
  const instance = await startTestService();
  const { service, sql } = instance;
  const admin = addUser(sql, "administrator", null, "Ada");
  addUser(sql, "contributor", ["de"], "Carl");
  await uploadJson(
    service,
    {
      "common.json": {
        title: "Wayfarer",
        menu: { play: "Play" },
        coins_one: "{{count}} coin",
        coins_other: "{{count}} coins",
      },
      "big.json": bigFile(700),
    },
    { languages: ["de", "pl"] },
  );
  write(instance, "common.json", "title", "de", "Wanderer");
  write(instance, "common.json", "menu.play", "de", "Spielen", {
    colour: "blue",
    actor: { type: "user", id: 1, label: null },
    event: "translation_saved",
  });
  write(instance, "common.json", "coins#plural", "pl", {
    one: "{{count}} moneta",
    few: "{{count}} monety",
    many: "{{count}} monet",
    other: "{{count}} monety",
  });
  for (let i = 0; i < 300; i++) write(instance, "big.json", `key${i}`, "pl", `Tekst ${i}`);
  await service.updateSettings(admin, {
    name: "Wayfarer",
    llm: { projectInstructions: "Be brief." },
  });
  await service.updateLanguage(admin, { tag: "pl", instructions: "Informal." });
  await service.updateFile(admin, { id: 1, context: "Menus." });
  const key = await service.createApiToken(admin, { name: "CI", scope: "upload" });
  await service.recordBackup(SYSTEM, { at: START_TIME, file: "quaso-20260924T120000Z.sqlite" });
  return Object.assign(instance, { admin, secret: key.secret });
}

/** The JSON backup of a service, parsed. */
async function backupOf(service: Service, actor: Actor = SYSTEM): Promise<BackupDocument> {
  const text = await new Response(backupJsonStream(service, actor, { chunk: 128 })).text();
  return JSON.parse(text);
}

/** A document's tables without the rows that differ between two instances by design. */
function comparable(document: BackupDocument) {
  const tables = { ...document.tables };
  tables.meta = tables.meta.filter((row) => row.key !== "revision");
  return tables;
}

test("backup JSON round trip: an empty instance gets identical exports, statuses and history", async () => {
  using a = await richInstance();
  const document = await backupOf(a.service, a.admin);
  expect(document.format).toBe("quaso-backup");
  expect(document.version).toBe(1);
  expect(document.schemaVersion).toStrictEqual(DATABASE_VERSION);
  expect(document.revision).toStrictEqual(getRevision(a.sql));
  expect(document.tables.strings.length).toStrictEqual(count(a.sql, "strings"));
  expect(document.tables.history.length).toStrictEqual(count(a.sql, "history"));
  for (const table of SECRET_TABLES) expect(document.tables[table]).toBe(undefined);

  using b = await startTestService();
  const result = await restoreBackup(b.service, documentSource(document));
  expect(result.schemaVersion).toStrictEqual({ from: DATABASE_VERSION, to: DATABASE_VERSION });
  expect(result.tables.strings).toStrictEqual(count(a.sql, "strings"));
  expect(result.revision).toStrictEqual(document.revision + 1);

  const exportA = await a.service.exportFiles(SYSTEM, {});
  const exportB = await b.service.exportFiles(SYSTEM, {});
  expect(exportB.files).toStrictEqual(exportA.files);
  const statusA = await a.service.getStatus(SYSTEM, {});
  const statusB = await b.service.getStatus(SYSTEM, {});
  expect(statusB.languages).toStrictEqual(statusA.languages);
  for (const [file, key] of [
    ["common.json", "title"],
    ["big.json", "key7"],
  ]) {
    const id = stringId(a.sql, file, key);
    expect(await b.service.getHistory(ANONYMOUS, { id })).toStrictEqual(
      await a.service.getHistory(ANONYMOUS, { id }),
    );
  }
  expect((await b.service.getSettings(SYSTEM, {})).settings).toStrictEqual(
    (await a.service.getSettings(SYSTEM, {})).settings,
  );
  // A backup of the new instance is the same backup.
  const again = await backupOf(b.service);
  expect(comparable(again)).toStrictEqual(comparable(document));
  // The API key works on the new instance, and so does the administrator.
  const token = await b.service.authenticateToken(SYSTEM, { secret: a.secret });
  expect(token?.name).toBe("CI");
  // The last backup was A's (a file of A's setup), not the new instance's.
  expect((await a.service.getAdminInfo(a.admin, {})).lastBackup?.at).toStrictEqual(START_TIME);
  expect(document.tables.meta.some((row) => row.key === "last_backup")).toBe(false);
  expect((await b.service.getAdminInfo(a.admin, {})).lastBackup).toBe(null);
});

test("a restore never brings the last backup of the instance the backup comes from", async () => {
  using a = await richInstance();
  const document = await backupOf(a.service);
  // A backup made before the last backup was left out of backups.
  document.tables.meta.push({
    key: "last_backup",
    value: JSON.stringify({ at: START_TIME, file: "backups/quaso-20260924T120000Z.sqlite" }),
  });
  using b = await startTestService();
  const result = await restoreBackup(b.service, documentSource(document));
  expect(result.tables.meta).toStrictEqual(
    document.tables.meta.filter(
      (row) => !["schema_version", "schema_generation", "last_backup"].includes(row.key as string),
    ).length,
  );
  expect((await b.service.getAdminInfo(a.admin, {})).lastBackup).toBe(null);
});

/**
 * The service as a backup reads it, with a write in the middle: after the first chunk of
 * translations, key3's German translation is deleted and made again (a new row, after the
 * cursor), `times` times at most.
 */
function writeWhileRead(instance: TestInstance, admin: Actor, times: number): BackupReader {
  let left = times;
  const id = stringId(instance.sql, "big.json", "key3");
  return {
    backupInfo: (actor, input) => instance.service.backupInfo(actor, input),
    async backupTables(actor, input) {
      const chunk = await instance.service.backupTables(actor, input);
      if (left > 0 && input.table === "translations" && input.after === undefined) {
        left--;
        const { translation } = await instance.service.getString(admin, { id, language: "de" });
        await instance.service.deleteTranslation(admin, {
          id,
          language: "de",
          baseRevision: translation!.revision,
        });
        write(instance, "big.json", "key3", "de", `Text 3 again (${left})`);
      }
      return chunk;
    },
  };
}

/** An instance whose German translations take several chunks. */
async function translatedInstance(): Promise<TestInstance & { admin: Actor }> {
  const instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  await uploadJson(instance.service, { "big.json": bigFile(600) }, { languages: ["de"] });
  for (let i = 0; i < 600; i++) write(instance, "big.json", `key${i}`, "de", `Text ${i}`);
  return Object.assign(instance, { admin });
}

test("a backup is one moment's copy: a write while it is read fails it, and it starts again", async () => {
  using a = await translatedInstance();
  // Without the check, key3's translation would be in the document twice (its old row and
  // its new one), and the document wouldn't restore.
  const failed = await new Response(
    backupJsonStream(writeWhileRead(a, a.admin, 1), a.admin, { chunk: 128 }),
  )
    .text()
    .catch((error: unknown) => error);
  assert(failed instanceof ServiceError);
  expect(failed.code).toBe("conflict");
  expect(failed.message).toStrictEqual(BACKUP_CHANGED);

  let attempts = 0;
  const source = writeWhileRead(a, a.admin, 1);
  const document = await withBackupRetries(async () => {
    attempts++;
    const stream = backupJsonStream(source, a.admin, { chunk: 128 });
    return JSON.parse(await new Response(stream).text()) as BackupDocument;
  });
  expect(attempts).toBe(2);
  expect(document.tables.translations.length).toStrictEqual(count(a.sql, "translations"));
  expect(document.tables.history.length).toStrictEqual(count(a.sql, "history"));
  const key3 = stringId(a.sql, "big.json", "key3");
  expect(
    document.tables.translations.filter((row) => row.string_id === key3).map((row) => row.value),
  ).toStrictEqual(['"Text 3 again (0)"']);
  using b = await startTestService();
  const result = await restoreBackup(b.service, documentSource(document));
  expect(result.tables.translations).toStrictEqual(count(a.sql, "translations"));
  expect(comparable(await backupOf(b.service))).toStrictEqual(
    comparable(await backupOf(a.service)),
  );
});

test("a backup that writes keep interrupting fails loudly, as unavailable", async () => {
  using a = await translatedInstance();
  const source = writeWhileRead(a, a.admin, 10);
  const error = await withBackupRetries(() =>
    new Response(backupJsonStream(source, a.admin, { chunk: 128 })).text(),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("unavailable");
  expect(error.message).toContain("3 times in a row");
  // Other errors aren't tried again.
  let calls = 0;
  const other = await withBackupRetries(() => {
    calls++;
    return Promise.reject(new ServiceError("conflict", "Something else"));
  }).catch((error: unknown) => error);
  assert(other instanceof ServiceError);
  expect([other.message, calls]).toStrictEqual(["Something else", 1]);
});

test("a new row anywhere changes the state a backup is read at; reading a database needs no service", async () => {
  using a = await richInstance();
  const info = await a.service.backupInfo(a.admin, {});
  const chunk = await a.service.backupTables(a.admin, { table: "files", state: info.state });
  expect(chunk.rows.length).toBe(2);
  // An API key changes no revision, but it is a new row.
  await a.service.createApiToken(a.admin, { name: "Other", scope: "read" });
  expect(getRevision(a.sql)).toStrictEqual(info.revision);
  const error = await a.service
    .backupTables(a.admin, { table: "files", state: info.state })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.message).toStrictEqual(BACKUP_CHANGED);
  // The same document from the database itself, as the server reads a snapshot.
  const reader = sqlBackupReader(a.sql, () => START_TIME);
  const direct = JSON.parse(await new Response(backupJsonStream(reader, SYSTEM)).text());
  expect(direct.tables).toStrictEqual((await backupOf(a.service)).tables);
});

test("a restore that didn't finish may start again only until the instance is used", async () => {
  using a = await richInstance();
  const source = documentSource(await backupOf(a.service));
  const cut = { ...source, counts: { ...source.counts, strings: 99_999 } };

  for (const use of ["settings and an upload", "an API key"]) {
    using b = await startTestService();
    const { token } = await b.service.ensureSetupToken(SYSTEM, {});
    await expect(restoreBackup(b.service, cut)).rejects.toThrow(
      expect.objectContaining({
        constructor: ServiceError,
        message: expect.stringContaining("incomplete"),
      }),
    );
    // Nothing else wrote here: the restore may start again, with the setup token too.
    await expect(restoreBackup(b.service, cut)).rejects.toThrow(
      expect.objectContaining({
        constructor: ServiceError,
        message: expect.stringContaining("incomplete"),
      }),
    );
    expect((await b.service.checkRestoreToken(SYSTEM, { token: token! })).ok).toBe(true);
    // The admin page says the data is incomplete.
    const [shown] = (await b.service.getAdminInfo(a.admin, {})).recentErrors;
    expect(shown.message).toContain("Run the restore again");

    // The backup's administrator goes on working on it.
    if (use === "an API key") {
      await b.service.createApiToken(a.admin, { name: "CI 2", scope: "upload" });
    } else {
      await b.service.updateSettings(a.admin, { name: "Real project" });
      await uploadJson(b.service, { "real.json": { a: "Months of work" } }, { partial: true });
    }
    const strings = count(b.sql, "strings");
    expect((await b.service.checkRestoreToken(SYSTEM, { token: token! })).ok, use).toStrictEqual(
      false,
    );
    const rows = await b.service
      .restoreRows(SYSTEM, { table: "files", rows: [] })
      .catch((error: unknown) => error);
    assert(rows instanceof ServiceError);
    expect(rows.code).toBe("conflict");
    const refused = await restoreBackup(b.service, source).catch((error: unknown) => error);
    assert(refused instanceof ServiceError);
    expect(refused.code, use).toBe("conflict");
    expect(refused.message).toContain("an earlier restore didn't finish");
    expect(count(b.sql, "strings"), "nothing was touched").toStrictEqual(strings);
    const [still] = (await b.service.getAdminInfo(a.admin, {})).recentErrors;
    expect(still.message).toContain("into a new, empty instance");
  }

  // A restore that finishes leaves nothing on the admin page.
  using c = await startTestService();
  await restoreBackup(c.service, source);
  expect((await c.service.getAdminInfo(a.admin, {})).recentErrors).toStrictEqual([]);
});

test("a restart doesn't count as using an instance whose restore didn't finish", async () => {
  using a = await richInstance();
  const source = documentSource(await backupOf(a.service));
  using b = await startTestService();
  await expect(
    restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 1 } }),
  ).rejects.toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("incomplete"),
    }),
  );
  // The server starts on it (and prints a setup link, and takes a scheduled snapshot), or a
  // newer release migrates it.
  await b.service.start();
  await b.service.ensureSetupToken(SYSTEM, {});
  await b.service.recordBackup(SYSTEM, { at: START_TIME, file: "backups/quaso-x.sqlite" });
  b.sql.script("CREATE TABLE later_feature (id INTEGER PRIMARY KEY)");
  const result = await restoreBackup(b.service, source);
  expect(result.tables.strings).toStrictEqual(count(a.sql, "strings"));
});

test("no LLM job runs on a restore that didn't finish; they go on once it does", async () => {
  using a = await startTestService({ provider: createFakeTranslator() });
  const upload = await uploadJson(
    a.service,
    { "common.json": { title: "Wayfarer" } },
    {
      languages: ["de"],
    },
  );
  assert(upload.job !== null);
  const source = documentSource(await backupOf(a.service));
  using b = await startTestService({ provider: createFakeTranslator() });
  await expect(
    restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 9 } }),
  ).rejects.toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("incomplete"),
    }),
  );
  // A restart arms the stored wake-up: the queued job must wait for the data.
  await b.service.start();
  await b.service.alarm();
  expect(count(b.sql, "translations")).toBe(0);
  expect((await b.service.getJob(SYSTEM, { id: upload.job.id })).status).toBe("queued");

  // Once the instance is used anyway, the restore is over: the jobs go on.
  using c = await startTestService({ provider: createFakeTranslator() });
  await expect(
    restoreBackup(c.service, { ...source, counts: { ...source.counts, strings: 9 } }),
  ).rejects.toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("incomplete"),
    }),
  );
  await uploadJson(c.service, { "other.json": { hello: "Hello" } }, { partial: true });
  await drain(c);
  expect((await c.service.getJob(SYSTEM, { id: upload.job.id })).status).toBe("done");

  await restoreBackup(b.service, source);
  await drain(b);
  expect((await b.service.getJob(SYSTEM, { id: upload.job.id })).status).toBe("done");
  expect(count(b.sql, "translations")).toBe(1);
});

test("restored LLM jobs go on, paused ones too, as after a restart", async () => {
  using a = await startTestService({ provider: createFakeTranslator() });
  const upload = await uploadJson(
    a.service,
    { "common.json": { title: "Wayfarer" } },
    {
      languages: ["de"],
    },
  );
  assert(upload.job !== null);
  // Paused by the budget, say, and no wake-up stored.
  a.sql.run("UPDATE jobs SET status = 'paused', error = 'Monthly token budget reached'");
  a.sql.run("DELETE FROM meta WHERE key = ?", NEXT_ALARM);
  const document = await backupOf(a.service);

  using b = await startTestService({ provider: createFakeTranslator() });
  await restoreBackup(b.service, documentSource(document));
  expect(b.scheduler.scheduled.at(-1), "woken up at once").toStrictEqual(b.clock.now);
  expect((await b.service.getJob(SYSTEM, { id: upload.job.id })).status).toBe("queued");
  await drain(b);
  expect((await b.service.getJob(SYSTEM, { id: upload.job.id })).status).toBe("done");
  const page = await b.service.listStrings(ANONYMOUS, { language: "de" });
  expect(page.strings[0].translation?.colour).toBe("green");
});

test("a backup only restores into an empty instance", async () => {
  using a = await richInstance();
  const document = await backupOf(a.service);
  using b = await startTestService();
  await uploadJson(b.service, { "x.json": { a: "A" } });
  const error = await restoreBackup(b.service, documentSource(document)).catch(
    (error: unknown) => error,
  );
  assert(error instanceof ServiceError);
  expect(error.code).toBe("conflict");
  expect(error.message).toContain("it has strings");
  expect(count(b.sql, "strings"), "nothing was touched").toBe(1);

  using c = await startTestService();
  addUser(c.sql, "administrator");
  const refused = await restoreBackup(c.service, documentSource(document)).catch(
    (error: unknown) => error,
  );
  assert(refused instanceof ServiceError);
  expect(refused.message).toContain("people with roles");

  // People who only signed up (no role) are replaced by the backup's.
  using d = await startTestService();
  addUser(d.sql, "none", null, "Early bird");
  await restoreBackup(d.service, documentSource(document));
  expect(
    d.sql
      .query<{ display_name: string }>("SELECT display_name FROM users ORDER BY id")
      .map((row) => row.display_name),
  ).toStrictEqual(["Ada", "Carl"]);
});

test("only the system restores; administrators read backups", async () => {
  using a = await richInstance();
  const manager = addUser(a.sql, "manager");
  const header = { format: "quaso-backup", version: 1, schemaVersion: DATABASE_VERSION };
  for (const actor of [a.admin, manager, ANONYMOUS]) {
    const begin = await a.service.beginRestore(actor, header).catch((error: unknown) => error);
    assert(begin instanceof ServiceError);
    expect(begin.code).toBe("forbidden");
    const rows = await a.service
      .restoreRows(actor, { table: "files", rows: [] })
      .catch((error: unknown) => error);
    assert(rows instanceof ServiceError);
    expect(rows.code).toBe("forbidden");
    const finish = await a.service
      .finishRestore(actor, { counts: {} })
      .catch((error: unknown) => error);
    assert(finish instanceof ServiceError);
    expect(finish.code).toBe("forbidden");
    const record = await a.service
      .recordBackup(actor, { at: 1, file: null })
      .catch((error: unknown) => error);
    assert(record instanceof ServiceError);
    expect(record.code).toBe("forbidden");
  }
  const info = await a.service.backupInfo(a.admin, {});
  assert(info.tables.some((table) => table.name === "strings"));
  const denied = await a.service.backupInfo(manager, {}).catch((error: unknown) => error);
  assert(denied instanceof ServiceError);
  expect(denied.code).toBe("forbidden");
  const unknown = await a.service
    .backupTables(a.admin, { table: "sqlite_master" })
    .catch((error: unknown) => error);
  assert(unknown instanceof ServiceError);
  expect(unknown.code).toBe("not_found");
});

test("restores refuse newer schemas, other formats, and incomplete tables", async () => {
  using a = await richInstance();
  using b = await startTestService();
  const future = await b.service
    .beginRestore(SYSTEM, {
      format: "quaso-backup",
      version: 1,
      schemaVersion: DATABASE_VERSION + 1,
    })
    .catch((error: unknown) => error);
  assert(future instanceof ServiceError);
  expect(future.message).toContain("Upgrade Quaso");
  const other = await b.service
    .beginRestore(SYSTEM, { format: "crowdin", version: 1, schemaVersion: 1 })
    .catch((error: unknown) => error);
  assert(other instanceof ServiceError);
  expect(other.message).toContain("isn't a Quaso backup");
  const early = await b.service
    .restoreRows(SYSTEM, { table: "files", rows: [] })
    .catch((error: unknown) => error);
  assert(early instanceof ServiceError);
  expect(early.message).toContain("No restore is in progress");

  const document = await backupOf(a.service);
  const source = documentSource(document);
  const wrong = await restoreBackup(b.service, {
    ...source,
    counts: { ...source.counts, strings: 9999 },
  }).catch((error: unknown) => error);
  assert(wrong instanceof ServiceError);
  expect(wrong.message).toContain("The restore is incomplete: strings");
  // The restore can start again, since it didn't finish.
  const result = await restoreBackup(b.service, source);
  expect(result.tables.strings).toStrictEqual(count(a.sql, "strings"));
});

test("blobs travel as base64", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const json = toJsonValue(bytes);
  expect(json).toStrictEqual({ $base64: "AAEC+v8=" });
  expect(fromJsonValue(json, "t")).toStrictEqual(bytes);
  expect(fromJsonValue(7, "t")).toBe(7);
  expect(fromJsonValue(null, "t")).toBe(null);
  expect(toJsonValue(12n)).toBe(12);
  const error = (() => {
    try {
      fromJsonValue({ $base64: "not base64!" }, "t");
    } catch (error) {
      return error as ServiceError;
    }
  })();
  expect(error?.code).toBe("bad_request");
});

test("recordBackup keeps the newest backup", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  expect((await instance.service.getAdminInfo(admin, {})).lastBackup).toBe(null);
  await instance.service.recordBackup(SYSTEM, { at: 2000, file: "b" });
  await instance.service.recordBackup(SYSTEM, { at: 1000, file: "a" });
  expect((await instance.service.getAdminInfo(admin, {})).lastBackup).toStrictEqual({
    at: 2000,
    file: "b",
  });
});

test("the setup token stays out of backups, and lasts through a restore until it is done", async () => {
  using a = await richInstance();
  const source = documentSource(await backupOf(a.service));
  using b = await startTestService();
  const { token } = await b.service.ensureSetupToken(SYSTEM, {});
  assert(token !== null);
  const own = await backupOf(b.service);
  expect(own.tables.meta.some((row) => row.key === "setup_token")).toBe(false);

  // A restore that fails can start again with the same token.
  await expect(
    restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 1 } }),
  ).rejects.toThrow(ServiceError);
  expect((await b.service.checkRestoreToken(SYSTEM, { token })).ok).toBe(true);
  expect((await b.service.checkRestoreToken(SYSTEM, { token: "wrong" })).ok).toBe(false);
  await restoreBackup(b.service, source);
  expect((await b.service.validateSetupToken(ANONYMOUS, { token })).ok).toBe(false);
  expect((await b.service.checkRestoreToken(SYSTEM, { token })).ok).toBe(false);
  const denied = await b.service
    .checkRestoreToken(ANONYMOUS, { token })
    .catch((error: unknown) => error);
  assert(denied instanceof ServiceError);
  expect(denied.code).toBe("forbidden");
  expect(count(b.sql, "meta", "key = 'setup_token'")).toBe(0);
});
