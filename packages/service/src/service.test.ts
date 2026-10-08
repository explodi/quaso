// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
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
    assertEquals(await service.start(), {
      schemaVersion: { from: 0, to: DATABASE_VERSION },
      created: true,
    });
    assertEquals(calls, []);
    const settings = loadSettings({
      sql: database.sql,
      defaultModel: "other",
    });
    assertEquals(settings.name, "Untitled project");
    assertEquals(settings.llm.model, "gemini-test");
    const again = createService({
      sql: database.sql,
      scheduler: new FakeScheduler(),
      secretKey: "x",
    });
    assertEquals(await again.start(), {
      schemaVersion: { from: DATABASE_VERSION, to: DATABASE_VERSION },
      created: false,
    });
  } finally {
    database.close();
  }
});

test("start re-arms the scheduler from the stored wake-up; alarm clears it", async () => {
  using instance = await startTestService();
  assertEquals(instance.scheduler.scheduled, []);
  setMeta(instance.sql, "next_alarm", "1790000000000");
  const scheduler = new FakeScheduler();
  const service = createService({ sql: instance.sql, scheduler, secretKey: "test" });
  await service.start();
  assertEquals(scheduler.scheduled, [1790000000000]);
  await service.alarm();
  assertEquals(getMeta(instance.sql, "next_alarm"), null);
});

test("a wake-up is stored before the scheduler is armed, so a restart arms it again", async () => {
  using instance = await startTestService();
  await scheduleWakeUp(instance.sql, instance.scheduler, 1790000000000);
  await scheduleWakeUp(instance.sql, instance.scheduler, 1790000999999);
  assertEquals(instance.scheduler.scheduled, [1790000000000], "the earlier one stays");
  await scheduleWakeUp(instance.sql, instance.scheduler, 1780000000000);
  assertEquals(nextWakeUp(instance.sql), 1780000000000);

  const scheduler = new FakeScheduler();
  const restarted = createService({ sql: instance.sql, scheduler, secretKey: "test" });
  await restarted.start();
  assertEquals(scheduler.scheduled, [1780000000000]);
  await restarted.alarm();
  assertEquals(nextWakeUp(instance.sql), null);

  await scheduleWakeUp(instance.sql, scheduler, 1790000000000);
  await cancelWakeUp(instance.sql, scheduler);
  assertEquals([nextWakeUp(instance.sql), scheduler.cancelled], [null, 1]);
});

test("getHealth reports the schema version and the revision", async () => {
  using instance = await startTestService();
  assertEquals(await instance.service.getHealth(ANONYMOUS, {}), {
    ok: true,
    schemaVersion: DATABASE_VERSION,
    revision: 0,
    busy: false,
    nextWakeUp: null,
  });
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  assertEquals((await instance.service.getHealth(ANONYMOUS, {})).revision, 1);
});

test("inputs are validated, with the path of each problem", async () => {
  using instance = await startTestService();
  const error = await assertRejects(
    () =>
      instance.service.listStrings(ANONYMOUS, {
        language: "not a tag",
        limit: 0,
        extra: 1,
      } as never),
    ServiceError,
  );
  assertEquals(error.code, "validation_failed");
  assertEquals(error.status, 400);
  assertEquals(
    error.details?.map((detail) => detail.path),
    ["language", "limit", "extra"],
  );
  const upload = await assertRejects(
    () =>
      instance.service.upload(SYSTEM, {
        files: [{ path: "../x.json", repoPath: "../x.json", content: "{}" }],
      }),
    ServiceError,
  );
  assertEquals(
    upload.details?.map((detail) => detail.path),
    ["files[0].path", "files[0].repoPath"],
  );
  const missing = await assertRejects(
    () => instance.service.getString(ANONYMOUS, undefined as never),
    ServiceError,
  );
  assertEquals(
    missing.details?.map((detail) => detail.path),
    ["id", "language"],
  );
});

test("actors are validated too", async () => {
  using instance = await startTestService();
  for (const actor of [{ type: "root" }, { type: "user" }, { type: "token", tokenId: -1 }]) {
    const error = await assertRejects(
      () => instance.service.getProject(actor as Actor, {}),
      ServiceError,
    );
    assertEquals(error.code, "validation_failed");
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
    assertEquals(
      [
        await codeOf(() => instance.service.upload(actor, { files })),
        await codeOf(() => instance.service.exportFiles(actor, {})),
        await codeOf(() => instance.service.getStatus(actor, {})),
      ],
      [uploads, exports, status],
      JSON.stringify(actor),
    );
  }
  assertEquals(
    await codeOf(() =>
      instance.service.importTranslations(read.actor, { language: "de", as: "green", files }),
    ),
    "forbidden",
  );
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
  assertEquals(
    lines.map(([message]) => message),
    ["Service started", "Upload"],
  );
  assertEquals(lines[1][1]?.added, 1);
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
  assertEquals(
    status.languages.map((language) => language.tag),
    ["de", "ja", "pl"],
  );
  for (const language of status.languages) {
    assertEquals(
      [language.strings, language.untranslated, language.green, language.blue],
      [3, 3, 0, 0],
      language.tag,
    );
    const page = await instance.service.listStrings(ANONYMOUS, { language: language.tag });
    assertEquals(page.total, 3);
    assertEquals(
      page.strings.every((string) => string.translation === null),
      true,
    );
    const red = await instance.service.listStrings(ANONYMOUS, {
      language: language.tag,
      state: "untranslated",
    });
    assertEquals(red.total, 3);
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
  assertEquals(
    outdated.strings.map((string) => [string.key, string.translation?.colour]),
    [
      ["title", "green"],
      ["play", "blue"],
    ],
  );
  assertEquals(
    outdated.strings.every((string) => string.translation?.outdated),
    true,
  );
  const status = await instance.service.getStatus(SYSTEM, { language: "de" });
  assertEquals([status.languages[0].outdated, status.languages[0].untranslated], [2, 0]);
  const download = async () =>
    JSON.parse(
      (await instance.service.exportFiles(SYSTEM, { languages: ["de"] })).files[0].content,
    );
  assertEquals(await download(), { title: "Wegfahrer", play: "Spielen" });
  write(instance, "common.json", "title", "de", "Wegfahrer II");
  assertEquals(await download(), { title: "Wegfahrer II", play: "Spielen" });
  const after = await instance.service.getStatus(SYSTEM, { language: "de" });
  assertEquals(after.languages[0].outdated, 1);
});

test("extra fields on an actor are ignored", async () => {
  using instance = await startTestService();
  const actor = { type: "system", sessionId: "abc" } as unknown as Actor;
  const created = await instance.service.createApiToken(actor, { name: "x", scope: "read" });
  assertEquals(created.name, "x");
});
