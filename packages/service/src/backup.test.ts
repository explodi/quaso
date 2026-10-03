// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@quaso/runtime/assert";
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
  assertEquals(document.format, "quaso-backup");
  assertEquals(document.version, 1);
  assertEquals(document.schemaVersion, DATABASE_VERSION);
  assertEquals(document.revision, getRevision(a.sql));
  assertEquals(document.tables.strings.length, count(a.sql, "strings"));
  assertEquals(document.tables.history.length, count(a.sql, "history"));
  for (const table of SECRET_TABLES) assertEquals(document.tables[table], undefined);

  using b = await startTestService();
  const result = await restoreBackup(b.service, documentSource(document));
  assertEquals(result.schemaVersion, { from: DATABASE_VERSION, to: DATABASE_VERSION });
  assertEquals(result.tables.strings, count(a.sql, "strings"));
  assertEquals(result.revision, document.revision + 1);

  const exportA = await a.service.exportFiles(SYSTEM, {});
  const exportB = await b.service.exportFiles(SYSTEM, {});
  assertEquals(exportB.files, exportA.files);
  const statusA = await a.service.getStatus(SYSTEM, {});
  const statusB = await b.service.getStatus(SYSTEM, {});
  assertEquals(statusB.languages, statusA.languages);
  for (const [file, key] of [
    ["common.json", "title"],
    ["big.json", "key7"],
  ]) {
    const id = stringId(a.sql, file, key);
    assertEquals(
      await b.service.getHistory(ANONYMOUS, { id }),
      await a.service.getHistory(ANONYMOUS, { id }),
    );
  }
  assertEquals(
    (await b.service.getSettings(SYSTEM, {})).settings,
    (await a.service.getSettings(SYSTEM, {})).settings,
  );
  // A backup of the new instance is the same backup.
  const again = await backupOf(b.service);
  assertEquals(comparable(again), comparable(document));
  // The API key works on the new instance, and so does the administrator.
  const token = await b.service.authenticateToken(SYSTEM, { secret: a.secret });
  assertEquals(token?.name, "CI");
  // The last backup was A's (a file of A's setup), not the new instance's.
  assertEquals((await a.service.getAdminInfo(a.admin, {})).lastBackup?.at, START_TIME);
  assertEquals(
    document.tables.meta.some((row) => row.key === "last_backup"),
    false,
  );
  assertEquals((await b.service.getAdminInfo(a.admin, {})).lastBackup, null);
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
  assertEquals(
    result.tables.meta,
    document.tables.meta.filter(
      (row) => !["schema_version", "schema_generation", "last_backup"].includes(row.key as string),
    ).length,
  );
  assertEquals((await b.service.getAdminInfo(a.admin, {})).lastBackup, null);
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
  const failed = await assertRejects(
    () =>
      new Response(backupJsonStream(writeWhileRead(a, a.admin, 1), a.admin, { chunk: 128 })).text(),
    ServiceError,
  );
  assertEquals(failed.code, "conflict");
  assertEquals(failed.message, BACKUP_CHANGED);

  let attempts = 0;
  const source = writeWhileRead(a, a.admin, 1);
  const document = await withBackupRetries(async () => {
    attempts++;
    const stream = backupJsonStream(source, a.admin, { chunk: 128 });
    return JSON.parse(await new Response(stream).text()) as BackupDocument;
  });
  assertEquals(attempts, 2);
  assertEquals(document.tables.translations.length, count(a.sql, "translations"));
  assertEquals(document.tables.history.length, count(a.sql, "history"));
  const key3 = stringId(a.sql, "big.json", "key3");
  assertEquals(
    document.tables.translations.filter((row) => row.string_id === key3).map((row) => row.value),
    ['"Text 3 again (0)"'],
  );
  using b = await startTestService();
  const result = await restoreBackup(b.service, documentSource(document));
  assertEquals(result.tables.translations, count(a.sql, "translations"));
  assertEquals(comparable(await backupOf(b.service)), comparable(await backupOf(a.service)));
});

test("a backup that writes keep interrupting fails loudly, as unavailable", async () => {
  using a = await translatedInstance();
  const source = writeWhileRead(a, a.admin, 10);
  const error = await assertRejects(
    () =>
      withBackupRetries(() =>
        new Response(backupJsonStream(source, a.admin, { chunk: 128 })).text(),
      ),
    ServiceError,
  );
  assertEquals(error.code, "unavailable");
  assertStringIncludes(error.message, "3 times in a row");
  // Other errors aren't tried again.
  let calls = 0;
  const other = await assertRejects(
    () =>
      withBackupRetries(() => {
        calls++;
        return Promise.reject(new ServiceError("conflict", "Something else"));
      }),
    ServiceError,
  );
  assertEquals([other.message, calls], ["Something else", 1]);
});

test("a new row anywhere changes the state a backup is read at; reading a database needs no service", async () => {
  using a = await richInstance();
  const info = await a.service.backupInfo(a.admin, {});
  const chunk = await a.service.backupTables(a.admin, { table: "files", state: info.state });
  assertEquals(chunk.rows.length, 2);
  // An API key changes no revision, but it is a new row.
  await a.service.createApiToken(a.admin, { name: "Other", scope: "read" });
  assertEquals(getRevision(a.sql), info.revision);
  const error = await assertRejects(
    () => a.service.backupTables(a.admin, { table: "files", state: info.state }),
    ServiceError,
  );
  assertEquals(error.message, BACKUP_CHANGED);
  // The same document from the database itself, as the server reads a snapshot.
  const reader = sqlBackupReader(a.sql, () => START_TIME);
  const direct = JSON.parse(await new Response(backupJsonStream(reader, SYSTEM)).text());
  assertEquals(direct.tables, (await backupOf(a.service)).tables);
});

test("a restore that didn't finish may start again only until the instance is used", async () => {
  using a = await richInstance();
  const source = documentSource(await backupOf(a.service));
  const cut = { ...source, counts: { ...source.counts, strings: 99_999 } };

  for (const use of ["settings and an upload", "an API key"]) {
    using b = await startTestService();
    const { token } = await b.service.ensureSetupToken(SYSTEM, {});
    await assertRejects(() => restoreBackup(b.service, cut), ServiceError, "incomplete");
    // Nothing else wrote here: the restore may start again, with the setup token too.
    await assertRejects(() => restoreBackup(b.service, cut), ServiceError, "incomplete");
    assertEquals((await b.service.checkRestoreToken(SYSTEM, { token: token! })).ok, true);
    // The admin page says the data is incomplete.
    const [shown] = (await b.service.getAdminInfo(a.admin, {})).recentErrors;
    assertStringIncludes(shown.message, "Run the restore again");

    // The backup's administrator goes on working on it.
    if (use === "an API key") {
      await b.service.createApiToken(a.admin, { name: "CI 2", scope: "upload" });
    } else {
      await b.service.updateSettings(a.admin, { name: "Real project" });
      await uploadJson(b.service, { "real.json": { a: "Months of work" } }, { partial: true });
    }
    const strings = count(b.sql, "strings");
    assertEquals((await b.service.checkRestoreToken(SYSTEM, { token: token! })).ok, false, use);
    const rows = await assertRejects(
      () => b.service.restoreRows(SYSTEM, { table: "files", rows: [] }),
      ServiceError,
    );
    assertEquals(rows.code, "conflict");
    const refused = await assertRejects(() => restoreBackup(b.service, source), ServiceError);
    assertEquals(refused.code, "conflict", use);
    assertStringIncludes(refused.message, "an earlier restore didn't finish");
    assertEquals(count(b.sql, "strings"), strings, "nothing was touched");
    const [still] = (await b.service.getAdminInfo(a.admin, {})).recentErrors;
    assertStringIncludes(still.message, "into a new, empty instance");
  }

  // A restore that finishes leaves nothing on the admin page.
  using c = await startTestService();
  await restoreBackup(c.service, source);
  assertEquals((await c.service.getAdminInfo(a.admin, {})).recentErrors, []);
});

test("a restart doesn't count as using an instance whose restore didn't finish", async () => {
  using a = await richInstance();
  const source = documentSource(await backupOf(a.service));
  using b = await startTestService();
  await assertRejects(
    () => restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 1 } }),
    ServiceError,
    "incomplete",
  );
  // The server starts on it (and prints a setup link, and takes a scheduled snapshot), or a
  // newer release migrates it.
  await b.service.start();
  await b.service.ensureSetupToken(SYSTEM, {});
  await b.service.recordBackup(SYSTEM, { at: START_TIME, file: "backups/quaso-x.sqlite" });
  b.sql.script("CREATE TABLE later_feature (id INTEGER PRIMARY KEY)");
  const result = await restoreBackup(b.service, source);
  assertEquals(result.tables.strings, count(a.sql, "strings"));
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
  await assertRejects(
    () => restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 9 } }),
    ServiceError,
    "incomplete",
  );
  // A restart arms the stored wake-up: the queued job must wait for the data.
  await b.service.start();
  await b.service.alarm();
  assertEquals(count(b.sql, "translations"), 0);
  assertEquals((await b.service.getJob(SYSTEM, { id: upload.job.id })).status, "queued");

  // Once the instance is used anyway, the restore is over: the jobs go on.
  using c = await startTestService({ provider: createFakeTranslator() });
  await assertRejects(
    () => restoreBackup(c.service, { ...source, counts: { ...source.counts, strings: 9 } }),
    ServiceError,
    "incomplete",
  );
  await uploadJson(c.service, { "other.json": { hello: "Hello" } }, { partial: true });
  await drain(c);
  assertEquals((await c.service.getJob(SYSTEM, { id: upload.job.id })).status, "done");

  await restoreBackup(b.service, source);
  await drain(b);
  assertEquals((await b.service.getJob(SYSTEM, { id: upload.job.id })).status, "done");
  assertEquals(count(b.sql, "translations"), 1);
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
  assertEquals(b.scheduler.scheduled.at(-1), b.clock.now, "woken up at once");
  assertEquals((await b.service.getJob(SYSTEM, { id: upload.job.id })).status, "queued");
  await drain(b);
  assertEquals((await b.service.getJob(SYSTEM, { id: upload.job.id })).status, "done");
  const page = await b.service.listStrings(ANONYMOUS, { language: "de" });
  assertEquals(page.strings[0].translation?.colour, "green");
});

test("a backup only restores into an empty instance", async () => {
  using a = await richInstance();
  const document = await backupOf(a.service);
  using b = await startTestService();
  await uploadJson(b.service, { "x.json": { a: "A" } });
  const error = await assertRejects(
    () => restoreBackup(b.service, documentSource(document)),
    ServiceError,
  );
  assertEquals(error.code, "conflict");
  assertStringIncludes(error.message, "it has strings");
  assertEquals(count(b.sql, "strings"), 1, "nothing was touched");

  using c = await startTestService();
  addUser(c.sql, "administrator");
  const refused = await assertRejects(
    () => restoreBackup(c.service, documentSource(document)),
    ServiceError,
  );
  assertStringIncludes(refused.message, "people with roles");

  // People who only signed up (no role) are replaced by the backup's.
  using d = await startTestService();
  addUser(d.sql, "none", null, "Early bird");
  await restoreBackup(d.service, documentSource(document));
  assertEquals(
    d.sql
      .query<{ display_name: string }>("SELECT display_name FROM users ORDER BY id")
      .map((row) => row.display_name),
    ["Ada", "Carl"],
  );
});

test("only the system restores; administrators read backups", async () => {
  using a = await richInstance();
  const manager = addUser(a.sql, "manager");
  const header = { format: "quaso-backup", version: 1, schemaVersion: DATABASE_VERSION };
  for (const actor of [a.admin, manager, ANONYMOUS]) {
    const begin = await assertRejects(() => a.service.beginRestore(actor, header), ServiceError);
    assertEquals(begin.code, "forbidden");
    const rows = await assertRejects(
      () => a.service.restoreRows(actor, { table: "files", rows: [] }),
      ServiceError,
    );
    assertEquals(rows.code, "forbidden");
    const finish = await assertRejects(
      () => a.service.finishRestore(actor, { counts: {} }),
      ServiceError,
    );
    assertEquals(finish.code, "forbidden");
    const record = await assertRejects(
      () => a.service.recordBackup(actor, { at: 1, file: null }),
      ServiceError,
    );
    assertEquals(record.code, "forbidden");
  }
  const info = await a.service.backupInfo(a.admin, {});
  assert(info.tables.some((table) => table.name === "strings"));
  const denied = await assertRejects(() => a.service.backupInfo(manager, {}), ServiceError);
  assertEquals(denied.code, "forbidden");
  const unknown = await assertRejects(
    () => a.service.backupTables(a.admin, { table: "sqlite_master" }),
    ServiceError,
  );
  assertEquals(unknown.code, "not_found");
});

test("restores refuse newer schemas, other formats, and incomplete tables", async () => {
  using a = await richInstance();
  using b = await startTestService();
  const future = await assertRejects(
    () =>
      b.service.beginRestore(SYSTEM, {
        format: "quaso-backup",
        version: 1,
        schemaVersion: DATABASE_VERSION + 1,
      }),
    ServiceError,
  );
  assertStringIncludes(future.message, "Upgrade Quaso");
  const other = await assertRejects(
    () => b.service.beginRestore(SYSTEM, { format: "crowdin", version: 1, schemaVersion: 1 }),
    ServiceError,
  );
  assertStringIncludes(other.message, "isn't a Quaso backup");
  const early = await assertRejects(
    () => b.service.restoreRows(SYSTEM, { table: "files", rows: [] }),
    ServiceError,
  );
  assertStringIncludes(early.message, "No restore is in progress");

  const document = await backupOf(a.service);
  const source = documentSource(document);
  const wrong = await assertRejects(
    () => restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 9999 } }),
    ServiceError,
  );
  assertStringIncludes(wrong.message, "The restore is incomplete: strings");
  // The restore can start again, since it didn't finish.
  const result = await restoreBackup(b.service, source);
  assertEquals(result.tables.strings, count(a.sql, "strings"));
});

test("blobs travel as base64", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const json = toJsonValue(bytes);
  assertEquals(json, { $base64: "AAEC+v8=" });
  assertEquals(fromJsonValue(json, "t"), bytes);
  assertEquals(fromJsonValue(7, "t"), 7);
  assertEquals(fromJsonValue(null, "t"), null);
  assertEquals(toJsonValue(12n), 12);
  const error = (() => {
    try {
      fromJsonValue({ $base64: "not base64!" }, "t");
    } catch (error) {
      return error as ServiceError;
    }
  })();
  assertEquals(error?.code, "bad_request");
});

test("recordBackup keeps the newest backup", async () => {
  using instance = await startTestService();
  const admin = addUser(instance.sql, "administrator");
  assertEquals((await instance.service.getAdminInfo(admin, {})).lastBackup, null);
  await instance.service.recordBackup(SYSTEM, { at: 2000, file: "b" });
  await instance.service.recordBackup(SYSTEM, { at: 1000, file: "a" });
  assertEquals((await instance.service.getAdminInfo(admin, {})).lastBackup, {
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
  assertEquals(
    own.tables.meta.some((row) => row.key === "setup_token"),
    false,
  );

  // A restore that fails can start again with the same token.
  await assertRejects(
    () => restoreBackup(b.service, { ...source, counts: { ...source.counts, strings: 1 } }),
    ServiceError,
  );
  assertEquals((await b.service.checkRestoreToken(SYSTEM, { token })).ok, true);
  assertEquals((await b.service.checkRestoreToken(SYSTEM, { token: "wrong" })).ok, false);
  await restoreBackup(b.service, source);
  assertEquals((await b.service.validateSetupToken(ANONYMOUS, { token })).ok, false);
  assertEquals((await b.service.checkRestoreToken(SYSTEM, { token })).ok, false);
  const denied = await assertRejects(
    () => b.service.checkRestoreToken(ANONYMOUS, { token }),
    ServiceError,
  );
  assertEquals(denied.code, "forbidden");
  assertEquals(count(b.sql, "meta", "key = 'setup_token'"), 0);
});
