// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { getMeta, setMeta } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { DATABASE_VERSION } from "./migrations.ts";
import type { Logger } from "./ports.ts";
import { createService } from "./service.ts";
import { loadSettings } from "./settings.ts";
import {
  addUser,
  createToken,
  FakeScheduler,
  startTestService,
  uploadJson,
  write,
} from "./test_helpers.ts";
import { cancelWakeUp, nextWakeUp, scheduleWakeUp } from "./wakeups.ts";

test("start creates a new instance with the default settings", async () => {
  const database = openNodeSqlite(":memory:");
  try {
    const calls: number[][] = [];
    const service = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "test",
      defaultModel: "gemini-test",
      beforeMigrate: (from, to) => void calls.push([from, to]),
    });
    expect(await service.start()).toStrictEqual({
      schemaVersion: { from: 0, to: DATABASE_VERSION },
      created: true,
    });
    expect(calls).toStrictEqual([]);
    const settings = loadSettings({
      sql: database.sql,
      defaultModel: "other",
    });
    expect(settings.name).toBe("Untitled project");
    expect(settings.llm.model).toBe("gemini-test");
    const again = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "x",
    });
    expect(await again.start()).toStrictEqual({
      schemaVersion: { from: DATABASE_VERSION, to: DATABASE_VERSION },
      created: false,
    });
  } finally {
    database.close();
  }
});

test("start re-arms the scheduler from the stored wake-up; alarm clears it", async () => {
  using instance = await startTestService();
  expect(instance.scheduler.scheduled).toStrictEqual([]);
  setMeta(instance.sql, "next_alarm", "1790000000000");
  const scheduler = new FakeScheduler();
  const service = createService({ sql: instance.sql, scheduler, secretKey: "test" });
  await service.start();
  expect(scheduler.scheduled).toStrictEqual([1790000000000]);
  await service.alarm();
  expect(getMeta(instance.sql, "next_alarm")).toBe(null);
});

test("a wake-up is stored before the scheduler is armed, so a restart arms it again", async () => {
  using instance = await startTestService();
  await scheduleWakeUp(instance.sql, instance.scheduler, 1790000000000);
  await scheduleWakeUp(instance.sql, instance.scheduler, 1790000999999);
  expect(instance.scheduler.scheduled, "the earlier one stays").toStrictEqual([1790000000000]);
  await scheduleWakeUp(instance.sql, instance.scheduler, 1780000000000);
  expect(nextWakeUp(instance.sql)).toBe(1780000000000);

  const scheduler = new FakeScheduler();
  const restarted = createService({ sql: instance.sql, scheduler, secretKey: "test" });
  await restarted.start();
  expect(scheduler.scheduled).toStrictEqual([1780000000000]);
  await restarted.alarm();
  expect(nextWakeUp(instance.sql)).toBe(null);

  await scheduleWakeUp(instance.sql, scheduler, 1790000000000);
  await cancelWakeUp(instance.sql, scheduler);
  expect([nextWakeUp(instance.sql), scheduler.cancelled]).toStrictEqual([null, 1]);
});

test("getHealth reports the schema version and the revision", async () => {
  using instance = await startTestService();
  expect(await instance.service.getHealth(ANONYMOUS, {})).toStrictEqual({
    ok: true,
    schemaVersion: DATABASE_VERSION,
    revision: 0,
    busy: false,
    nextWakeUp: null,
  });
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  expect((await instance.service.getHealth(ANONYMOUS, {})).revision).toBe(1);
});

test("inputs are validated, with the path of each problem", async () => {
  using instance = await startTestService();
  const error = await instance.service
    .listStrings(ANONYMOUS, {
      language: "not a tag",
      limit: 0,
      extra: 1,
    } as never)
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("validation_failed");
  expect(error.status).toBe(400);
  expect(error.details?.map((detail) => detail.path)).toStrictEqual(["language", "limit", "extra"]);
  const upload = await instance.service
    .upload(SYSTEM, {
      files: [{ path: "../x.json", repoPath: "../x.json", content: "{}" }],
    })
    .catch((error: unknown) => error);
  assert(upload instanceof ServiceError);
  expect(upload.details?.map((detail) => detail.path)).toStrictEqual([
    "files[0].path",
    "files[0].repoPath",
  ]);
  const missing = await instance.service
    .getString(ANONYMOUS, undefined as never)
    .catch((error: unknown) => error);
  assert(missing instanceof ServiceError);
  expect(missing.details?.map((detail) => detail.path)).toStrictEqual(["id", "language"]);
});

test("actors are validated too", async () => {
  using instance = await startTestService();
  for (const actor of [{ type: "root" }, { type: "user" }, { type: "token", tokenId: -1 }]) {
    const error = await instance.service
      .getProject(actor as Actor, {})
      .catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("validation_failed");
  }
});

test("the CLI's methods need an API key with the right scope, or an administrator", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } }, { languages: ["de"] });
  const read = await createToken(instance.service, "read");
  const upload = await createToken(instance.service, "upload");
  const manager = addUser(instance.sql, "manager");
  const admin = addUser(instance.sql, "administrator");
  const files = [{ path: "a.json", repoPath: "a.json", content: '{"a": "A"}' }];
  const codeOf = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "ok";
    } catch (error) {
      return (error as ServiceError).code;
    }
  };
  const table: [Actor, string, string, string][] = [
    [ANONYMOUS, "unauthorized", "unauthorized", "unauthorized"],
    [read.actor, "forbidden", "ok", "ok"],
    [upload.actor, "ok", "ok", "ok"],
    [manager, "forbidden", "forbidden", "forbidden"],
    [admin, "ok", "ok", "ok"],
  ];
  for (const [actor, uploads, exports, status] of table) {
    expect(
      [
        await codeOf(() => instance.service.upload(actor, { files })),
        await codeOf(() => instance.service.exportFiles(actor, {})),
        await codeOf(() => instance.service.getStatus(actor, {})),
      ],
      JSON.stringify(actor),
    ).toStrictEqual([uploads, exports, status]);
  }
  expect(
    await codeOf(() =>
      instance.service.importTranslations(read.actor, { language: "de", as: "green", files }),
    ),
  ).toBe("forbidden");
});

test("uploads are logged", async () => {
  const lines: [string, Record<string, unknown> | undefined][] = [];
  const logger: Logger = {
    debug() {},
    info: (message, fields) => void lines.push([message, fields]),
    warn() {},
    error() {},
  };
  using instance = await startTestService({ logger });
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  expect(lines.map(([message]) => message)).toStrictEqual(["Service started", "Upload"]);
  expect(lines[1][1]?.added).toBe(1);
});

test("acceptance test 2: after an upload, every string is red in every language", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "upload");
  await uploadJson(
    instance.service,
    {
      "common.json": {
        title: "Wayfarer",
        coins_one: "{{count}} coin",
        coins_other: "{{count}} coins",
      },
      "hud.json": { hp: "HP", version: 2 },
    },
    { languages: ["de", "pl", "ja"] },
    token.actor,
  );
  const status = await instance.service.getStatus(token.actor, {});
  expect(status.languages.map((language) => language.tag)).toStrictEqual(["de", "ja", "pl"]);
  for (const language of status.languages) {
    expect(
      [language.strings, language.untranslated, language.green, language.blue],
      language.tag,
    ).toStrictEqual([3, 3, 0, 0]);
    const page = await instance.service.listStrings(ANONYMOUS, { language: language.tag });
    expect(page.total).toBe(3);
    expect(page.strings.every((string) => string.translation === null)).toBe(true);
    const red = await instance.service.listStrings(ANONYMOUS, {
      language: language.tag,
      state: "untranslated",
    });
    expect(red.total).toBe(3);
  }
});

test("acceptance test 7: changed English makes translations outdated; the old one is downloaded until updated", async () => {
  using instance = await startTestService();
  const english = { title: "Wayfarer", play: "Play" };
  await uploadJson(instance.service, { "common.json": english }, { languages: ["de"] });
  write(instance, "common.json", "title", "de", "Wegfahrer");
  write(instance, "common.json", "play", "de", "Spielen", {
    colour: "blue",
    actor: { type: "user", id: 1, label: null },
    event: "translation_saved",
  });
  await uploadJson(instance.service, {
    "common.json": { title: "Wayfarer II", play: "Play now" },
  });
  const outdated = await instance.service.listStrings(ANONYMOUS, {
    language: "de",
    state: "outdated",
  });
  expect(outdated.strings.map((string) => [string.key, string.translation?.colour])).toStrictEqual([
    ["title", "green"],
    ["play", "blue"],
  ]);
  expect(outdated.strings.every((string) => string.translation?.outdated)).toBe(true);
  const status = await instance.service.getStatus(SYSTEM, { language: "de" });
  expect([status.languages[0].outdated, status.languages[0].untranslated]).toStrictEqual([2, 0]);
  const download = async () =>
    JSON.parse(
      (await instance.service.exportFiles(SYSTEM, { languages: ["de"] })).files[0].content,
    );
  expect(await download()).toStrictEqual({ title: "Wegfahrer", play: "Spielen" });
  write(instance, "common.json", "title", "de", "Wegfahrer II");
  expect(await download()).toStrictEqual({ title: "Wegfahrer II", play: "Spielen" });
  const after = await instance.service.getStatus(SYSTEM, { language: "de" });
  expect(after.languages[0].outdated).toBe(1);
});

test("extra fields on an actor are ignored", async () => {
  using instance = await startTestService();
  const actor = { type: "system", sessionId: "abc" } as unknown as Actor;
  const created = await instance.service.createApiToken(actor, { name: "x", scope: "read" });
  expect(created.name).toBe("x");
});
