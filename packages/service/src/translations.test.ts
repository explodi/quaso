// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { SYSTEM } from "./api.ts";
import { getRevision, transaction } from "./db.ts";
import { ServiceError } from "./errors.ts";
import {
  count,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";
import { loadTranslation, writeTranslation } from "./translations.ts";

const ENGLISH = {
  greeting: "Hello, {{name}}!",
  title: "Wayfarer",
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  count: 42,
};

const MANAGER = { type: "user" as const, id: 7, label: null };

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(instance.service, { "common.json": ENGLISH }, { languages: ["de", "pl"] });
  return instance;
}

function translation(instance: TestInstance, key: string, language: string) {
  return loadTranslation(instance.sql, stringId(instance.sql, "common.json", key), language);
}

function historyOf(instance: TestInstance, key: string) {
  return instance.sql.query(
    `SELECT language, event, before_value, after_value, before_colour, after_colour, actor_type,
            actor_label, detail FROM history WHERE string_id = ? AND language IS NOT NULL
     ORDER BY id`,
    stringId(instance.sql, "common.json", key),
  );
}

test("a write stores the value, its checks, the revision, search text and history", async () => {
  using instance = await project();
  const before = getRevision(instance.sql);
  const result = write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!", {
    detail: { request: 1 },
  });
  assertEquals(result.status, "written");
  assertEquals(result.revision, before + 1);
  assertEquals(getRevision(instance.sql), before + 1);
  const row = translation(instance, "greeting", "de")!;
  assertEquals(row.value, '"Hallo, {{name}}!"');
  assertEquals(row.colour, "green");
  assertEquals(row.author_type, "llm");
  assertEquals(row.author_label, "test-model");
  assertEquals(row.revision, before + 1);
  assertEquals([row.qa_errors, row.qa_warnings], [0, 0]);
  assertEquals(
    instance.sql.query("SELECT search_text FROM translations")[0].search_text,
    "hallo, {{name}}!",
  );
  assertEquals(historyOf(instance, "greeting"), [
    {
      language: "de",
      event: "translation_llm",
      before_value: null,
      after_value: '"Hallo, {{name}}!"',
      before_colour: null,
      after_colour: "green",
      actor_type: "llm",
      actor_label: "test-model",
      detail: '{"request":1}',
    },
  ]);
});

test("warnings are stored with the translation, not refused", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wayfarer");
  const row = translation(instance, "title", "de")!;
  assertEquals([row.qa_errors, row.qa_warnings], [0, 1]);
});

test("the LLM never writes over a blue translation (LLM-4)", async () => {
  using instance = await project();
  write(instance, "common.json", "greeting", "de", "Servus, {{name}}!", {
    colour: "blue",
    actor: MANAGER,
    event: "translation_saved",
  });
  const revision = getRevision(instance.sql);
  const result = write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!", {
    llm: true,
  });
  assertEquals(result.status, "skipped");
  assertEquals(result.reason, "blue");
  assertEquals(translation(instance, "greeting", "de")!.value, '"Servus, {{name}}!"');
  assertEquals(getRevision(instance.sql), revision);
  assertEquals(historyOf(instance, "greeting").length, 1);
});

test("a write by the LLM follows LLM-4 even without the llm flag", async () => {
  using instance = await project();
  const saved = write(instance, "common.json", "title", "de", "Mein Spiel", {
    colour: "blue",
    actor: MANAGER,
    event: "translation_saved",
  });
  const result = write(instance, "common.json", "title", "de", "Mein Game", {
    baseRevision: saved.revision,
  });
  assertEquals(result.status, "skipped");
  assertEquals(result.reason, "blue");
  const row = translation(instance, "title", "de")!;
  assertEquals([row.value, row.colour, row.author_type], ['"Mein Spiel"', "blue", "user"]);
  assertThrows(
    () => write(instance, "common.json", "greeting", "de", null, { event: "translation_deleted" }),
    ServiceError,
    "green",
  );
});

test("the LLM drops its result when a person changed the translation meanwhile", async () => {
  using instance = await project();
  const first = write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!", { llm: true });
  write(instance, "common.json", "greeting", "de", "Moin, {{name}}!", {
    colour: "green",
    actor: MANAGER,
    event: "translation_saved",
  });
  const late = write(instance, "common.json", "greeting", "de", "Guten Tag, {{name}}!", {
    llm: true,
    baseRevision: first.revision,
  });
  assertEquals(late.status, "skipped");
  assertEquals(late.reason, "changed");
  assertEquals(translation(instance, "greeting", "de")!.value, '"Moin, {{name}}!"');
  const fresh = write(instance, "common.json", "greeting", "de", "Guten Tag, {{name}}!", {
    llm: true,
    baseRevision: translation(instance, "greeting", "de")!.revision,
  });
  assertEquals(fresh.status, "written");
});

test("the LLM only writes green", async () => {
  using instance = await project();
  assertThrows(
    () => write(instance, "common.json", "title", "de", "Titel", { llm: true, colour: "blue" }),
    ServiceError,
    "green",
  );
});

test("a stale base revision fails with conflict and the current translation", async () => {
  using instance = await project();
  const saved = write(instance, "common.json", "greeting", "de", "Hallo, {{name}}!", {
    colour: "blue",
    actor: MANAGER,
    event: "translation_saved",
    baseRevision: 0,
  });
  assertEquals(saved.status, "written");
  const error = assertThrows(
    () =>
      write(instance, "common.json", "greeting", "de", "Servus, {{name}}!", {
        colour: "blue",
        actor: MANAGER,
        event: "translation_saved",
        baseRevision: 0,
      }),
    ServiceError,
  );
  assertEquals(error.code, "conflict");
  assertEquals(error.status, 409);
  assertEquals(error.current?.value, "Hallo, {{name}}!");
  assertEquals(error.current?.colour, "blue");
  assertEquals(error.current?.revision, saved.revision);
  assertEquals(error.current?.author, {
    type: "user",
    id: 7,
    name: "Deleted user",
    avatarUrl: null,
  });
  const ok = write(instance, "common.json", "greeting", "de", "Servus, {{name}}!", {
    colour: "blue",
    actor: MANAGER,
    event: "translation_saved",
    baseRevision: saved.revision,
  });
  assertEquals(ok.status, "written");
});

test("a deleted translation conflicts with a save based on it, with current null", async () => {
  using instance = await project();
  const saved = write(instance, "common.json", "title", "de", "Titel");
  write(instance, "common.json", "title", "de", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  const error = assertThrows(
    () =>
      write(instance, "common.json", "title", "de", "Der Titel", {
        actor: MANAGER,
        event: "translation_saved",
        baseRevision: saved.revision,
      }),
    ServiceError,
  );
  assertEquals(error.code, "conflict");
  assertEquals(error.current, null);
});

test("values with check errors are refused with qa_failed and details (QA-1)", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const error = assertThrows(
    () => write(instance, "common.json", "greeting", "de", "Hallo!"),
    ServiceError,
  );
  assertEquals(error.code, "qa_failed");
  assertEquals(error.status, 422);
  assertEquals(error.details, [
    {
      file: "common.json",
      key: "greeting",
      language: "de",
      check: "placeholder_missing",
      message: error.details![0].message,
      value: "{{name}}",
    },
  ]);
  assertEquals(translation(instance, "greeting", "de"), undefined);
  assertEquals(getRevision(instance.sql), revision);
  assertEquals(count(instance.sql, "history", "language IS NOT NULL"), 0);
});

test("a Polish plural needs every form; a complete one is stored", async () => {
  using instance = await project();
  const error = assertThrows(
    () =>
      write(instance, "common.json", "coins", "pl", {
        one: "{{count}} moneta",
        other: "{{count}} monet",
      }),
    ServiceError,
  );
  assertEquals(error.code, "qa_failed");
  assertEquals(
    error.details!.map((detail) => [detail.check, detail.form]),
    [
      ["plural_form_missing", "few"],
      ["plural_form_missing", "many"],
    ],
  );
  const forms = {
    other: "{{count}} monety",
    many: "{{count}} monet",
    few: "{{count}} monety",
    one: "Jedna moneta",
  };
  assertEquals(write(instance, "common.json", "coins", "pl", forms).status, "written");
  assertEquals(
    translation(instance, "coins", "pl")!.value,
    '{"one":"Jedna moneta","few":"{{count}} monety","many":"{{count}} monet","other":"{{count}} monety"}',
    "stored canonically, in CLDR order",
  );
});

test("allowQaErrors stores a known problem with its error count", async () => {
  using instance = await project();
  write(instance, "common.json", "greeting", "de", "Hallo!", { allowQaErrors: true });
  assertEquals(translation(instance, "greeting", "de")!.qa_errors, 1);
});

test("writing the same value, colour and English changes nothing", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Titel");
  const revision = getRevision(instance.sql);
  const history = count(instance.sql, "history");
  const again = write(instance, "common.json", "title", "de", "Titel");
  assertEquals(again.status, "unchanged");
  assertEquals(again.revision, revision);
  assertEquals(getRevision(instance.sql), revision);
  assertEquals(count(instance.sql, "history"), history);
  const deleteNothing = write(instance, "common.json", "title", "pl", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  assertEquals(deleteNothing.status, "unchanged");
  assertEquals(getRevision(instance.sql), revision, "deleting nothing changes nothing");
});

test("approving keeps the text's author and records the approver", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Titel");
  write(instance, "common.json", "title", "de", "Titel", {
    colour: "blue",
    actor: MANAGER,
    approverId: 7,
    event: "translation_approved",
  });
  const row = translation(instance, "title", "de")!;
  assertEquals([row.colour, row.author_type, row.approver_id], ["blue", "llm", 7]);
  write(instance, "common.json", "title", "de", "Titel", {
    colour: "green",
    actor: MANAGER,
    event: "translation_unapproved",
  });
  const unapproved = translation(instance, "title", "de")!;
  assertEquals([unapproved.colour, unapproved.approver_id], ["green", null]);
  assertEquals(
    historyOf(instance, "title").map((entry) => [
      entry.event,
      entry.before_colour,
      entry.after_colour,
    ]),
    [
      ["translation_llm", null, "green"],
      ["translation_approved", "green", "blue"],
      ["translation_unapproved", "blue", "green"],
    ],
  );
});

test("deleting makes the string red again and writes history", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Titel");
  const result = write(instance, "common.json", "title", "de", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  assertEquals(result, { status: "written", revision: 0, checks: [] });
  assertEquals(translation(instance, "title", "de"), undefined);
  assertEquals(historyOf(instance, "title").at(-1), {
    language: "de",
    event: "translation_deleted",
    before_value: '"Titel"',
    after_value: null,
    before_colour: "green",
    after_colour: null,
    actor_type: "user",
    actor_label: null,
    detail: null,
  });
  const again = write(instance, "common.json", "title", "de", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  assertEquals(again.status, "unchanged");
});

test("outdated is computed by hash, and reverts when the English changes back (STR-4)", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  const outdated = () => {
    const row = translation(instance, "title", "de")!;
    const english = instance.sql.query<{ source_hash: string }>(
      "SELECT source_hash FROM strings WHERE id = ?",
      row.string_id,
    )[0];
    return row.source_hash !== english.source_hash;
  };
  assertEquals(outdated(), false);
  await uploadJson(instance.service, { "common.json": { ...ENGLISH, title: "Wayfarer 2" } });
  assertEquals(outdated(), true);
  assertEquals(translation(instance, "title", "de")!.value, '"Wegfahrer"', "kept");
  await uploadJson(instance.service, { "common.json": ENGLISH });
  assertEquals(outdated(), false);
});

test("updating an outdated translation makes it current", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  await uploadJson(instance.service, { "common.json": { ...ENGLISH, title: "Wayfarer 2" } });
  write(instance, "common.json", "title", "de", "Wegfahrer 2");
  const row = translation(instance, "title", "de")!;
  const [english] = instance.sql.query(
    "SELECT source_hash FROM strings WHERE id = ?",
    row.string_id,
  );
  assertEquals(row.source_hash, english.source_hash);
});

test("the revision goes up once per transaction", async () => {
  using instance = await project();
  const before = getRevision(instance.sql);
  const revisions = transaction(instance.sql, () => [
    writeTranslation(instance.ctx, {
      stringId: stringId(instance.sql, "common.json", "title"),
      language: "de",
      value: "Titel",
      colour: "green",
      actor: MANAGER,
      event: "translation_saved",
    }).revision,
    writeTranslation(instance.ctx, {
      stringId: stringId(instance.sql, "common.json", "title"),
      language: "pl",
      value: "Tytuł",
      colour: "green",
      actor: MANAGER,
      event: "translation_saved",
    }).revision,
  ]);
  assertEquals(revisions, [before + 1, before + 1]);
  assertEquals(getRevision(instance.sql), before + 1);
});

test("writes to unknown languages, literals and hidden strings are refused", async () => {
  using instance = await project();
  const literal = instance.sql.query<{ id: number }>(
    "SELECT id FROM strings WHERE display_key = 'count'",
  )[0].id;
  const run = (input: { stringId: number; language: string }) =>
    transaction(instance.sql, () =>
      writeTranslation(instance.ctx, {
        ...input,
        value: "x",
        colour: "green",
        actor: MANAGER,
        event: "translation_saved",
      }),
    );
  const titleId = stringId(instance.sql, "common.json", "title");
  assertEquals(
    assertThrows(() => run({ stringId: titleId, language: "fr" }), ServiceError).code,
    "bad_request",
  );
  assertEquals(
    assertThrows(() => run({ stringId: titleId, language: "en" }), ServiceError).code,
    "bad_request",
  );
  assertEquals(
    assertThrows(() => run({ stringId: literal, language: "de" }), ServiceError).code,
    "bad_request",
  );
  assertEquals(
    assertThrows(() => run({ stringId: 9999, language: "de" }), ServiceError).code,
    "not_found",
  );
  const { title: _, ...withoutTitle } = ENGLISH;
  await instance.service.upload(SYSTEM, {
    files: [
      { path: "common.json", repoPath: "common.json", content: JSON.stringify(withoutTitle) },
    ],
  });
  const error = assertThrows(() => run({ stringId: titleId, language: "de" }), ServiceError);
  assertInstanceOf(error, ServiceError);
  assertEquals(error.code, "not_found");
});

test("language tags are matched in their canonical form", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { hi: "Hi" } }, { languages: ["pt-br"] });
  assertEquals(write(instance, "a.json", "hi", "PT-BR", "Oi").status, "written");
  assertEquals(instance.sql.query("SELECT language FROM translations"), [{ language: "pt-BR" }]);
});
