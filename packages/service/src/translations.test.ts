// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(result.status).toBe("written");
  expect(result.revision).toStrictEqual(before + 1);
  expect(getRevision(instance.sql)).toStrictEqual(before + 1);
  const row = translation(instance, "greeting", "de")!;
  expect(row.value).toBe('"Hallo, {{name}}!"');
  expect(row.colour).toBe("green");
  expect(row.author_type).toBe("llm");
  expect(row.author_label).toBe("test-model");
  expect(row.revision).toStrictEqual(before + 1);
  expect([row.qa_errors, row.qa_warnings]).toStrictEqual([0, 0]);
  expect(instance.sql.query("SELECT search_text FROM translations")[0].search_text).toStrictEqual(
    "hallo, {{name}}!",
  );
  expect(historyOf(instance, "greeting")).toStrictEqual([
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
  expect([row.qa_errors, row.qa_warnings]).toStrictEqual([0, 1]);
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
  expect(result.status).toBe("skipped");
  expect(result.reason).toBe("blue");
  expect(translation(instance, "greeting", "de")!.value).toBe('"Servus, {{name}}!"');
  expect(getRevision(instance.sql)).toStrictEqual(revision);
  expect(historyOf(instance, "greeting").length).toBe(1);
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
  expect(result.status).toBe("skipped");
  expect(result.reason).toBe("blue");
  const row = translation(instance, "title", "de")!;
  expect([row.value, row.colour, row.author_type]).toStrictEqual(['"Mein Spiel"', "blue", "user"]);
  expect(() =>
    write(instance, "common.json", "greeting", "de", null, { event: "translation_deleted" }),
  ).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("green"),
    }),
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
  expect(late.status).toBe("skipped");
  expect(late.reason).toBe("changed");
  expect(translation(instance, "greeting", "de")!.value).toBe('"Moin, {{name}}!"');
  const fresh = write(instance, "common.json", "greeting", "de", "Guten Tag, {{name}}!", {
    llm: true,
    baseRevision: translation(instance, "greeting", "de")!.revision,
  });
  expect(fresh.status).toBe("written");
});

test("the LLM only writes green", async () => {
  using instance = await project();
  expect(() =>
    write(instance, "common.json", "title", "de", "Titel", { llm: true, colour: "blue" }),
  ).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("green"),
    }),
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
  expect(saved.status).toBe("written");
  const error = await Promise.try(() =>
    write(instance, "common.json", "greeting", "de", "Servus, {{name}}!", {
      colour: "blue",
      actor: MANAGER,
      event: "translation_saved",
      baseRevision: 0,
    }),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("conflict");
  expect(error.status).toBe(409);
  expect(error.current?.value).toBe("Hallo, {{name}}!");
  expect(error.current?.colour).toBe("blue");
  expect(error.current?.revision).toStrictEqual(saved.revision);
  expect(error.current?.author).toStrictEqual({
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
  expect(ok.status).toBe("written");
});

test("a deleted translation conflicts with a save based on it, with current null", async () => {
  using instance = await project();
  const saved = write(instance, "common.json", "title", "de", "Titel");
  write(instance, "common.json", "title", "de", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  const error = await Promise.try(() =>
    write(instance, "common.json", "title", "de", "Der Titel", {
      actor: MANAGER,
      event: "translation_saved",
      baseRevision: saved.revision,
    }),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("conflict");
  expect(error.current).toBe(null);
});

test("values with check errors are refused with qa_failed and details (QA-1)", async () => {
  using instance = await project();
  const revision = getRevision(instance.sql);
  const error = await Promise.try(() =>
    write(instance, "common.json", "greeting", "de", "Hallo!"),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("qa_failed");
  expect(error.status).toBe(422);
  expect(error.details).toStrictEqual([
    {
      file: "common.json",
      key: "greeting",
      language: "de",
      check: "placeholder_missing",
      message: error.details![0].message,
      value: "{{name}}",
    },
  ]);
  expect(translation(instance, "greeting", "de")).toBe(undefined);
  expect(getRevision(instance.sql)).toStrictEqual(revision);
  expect(count(instance.sql, "history", "language IS NOT NULL")).toBe(0);
});

test("a Polish plural needs every form; a complete one is stored", async () => {
  using instance = await project();
  const error = await Promise.try(() =>
    write(instance, "common.json", "coins", "pl", {
      one: "{{count}} moneta",
      other: "{{count}} monet",
    }),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("qa_failed");
  expect(error.details!.map((detail) => [detail.check, detail.form])).toStrictEqual([
    ["plural_form_missing", "few"],
    ["plural_form_missing", "many"],
  ]);
  const forms = {
    other: "{{count}} monety",
    many: "{{count}} monet",
    few: "{{count}} monety",
    one: "Jedna moneta",
  };
  expect(write(instance, "common.json", "coins", "pl", forms).status).toBe("written");
  expect(
    translation(instance, "coins", "pl")!.value,
    "stored canonically, in CLDR order",
  ).toStrictEqual(
    '{"one":"Jedna moneta","few":"{{count}} monety","many":"{{count}} monet","other":"{{count}} monety"}',
  );
});

test("allowQaErrors stores a known problem with its error count", async () => {
  using instance = await project();
  write(instance, "common.json", "greeting", "de", "Hallo!", { allowQaErrors: true });
  expect(translation(instance, "greeting", "de")!.qa_errors).toBe(1);
});

test("writing the same value, colour and English changes nothing", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Titel");
  const revision = getRevision(instance.sql);
  const history = count(instance.sql, "history");
  const again = write(instance, "common.json", "title", "de", "Titel");
  expect(again.status).toBe("unchanged");
  expect(again.revision).toStrictEqual(revision);
  expect(getRevision(instance.sql)).toStrictEqual(revision);
  expect(count(instance.sql, "history")).toStrictEqual(history);
  const deleteNothing = write(instance, "common.json", "title", "pl", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  expect(deleteNothing.status).toBe("unchanged");
  expect(getRevision(instance.sql), "deleting nothing changes nothing").toStrictEqual(revision);
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
  expect([row.colour, row.author_type, row.approver_id]).toStrictEqual(["blue", "llm", 7]);
  write(instance, "common.json", "title", "de", "Titel", {
    colour: "green",
    actor: MANAGER,
    event: "translation_unapproved",
  });
  const unapproved = translation(instance, "title", "de")!;
  expect([unapproved.colour, unapproved.approver_id]).toStrictEqual(["green", null]);
  expect(
    historyOf(instance, "title").map((entry) => [
      entry.event,
      entry.before_colour,
      entry.after_colour,
    ]),
  ).toStrictEqual([
    ["translation_llm", null, "green"],
    ["translation_approved", "green", "blue"],
    ["translation_unapproved", "blue", "green"],
  ]);
});

test("deleting makes the string red again and writes history", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Titel");
  const result = write(instance, "common.json", "title", "de", null, {
    actor: MANAGER,
    event: "translation_deleted",
  });
  expect(result).toStrictEqual({ status: "written", revision: 0, checks: [] });
  expect(translation(instance, "title", "de")).toBe(undefined);
  expect(historyOf(instance, "title").at(-1)).toStrictEqual({
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
  expect(again.status).toBe("unchanged");
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
  expect(outdated()).toBe(false);
  await uploadJson(instance.service, { "common.json": { ...ENGLISH, title: "Wayfarer 2" } });
  expect(outdated()).toBe(true);
  expect(translation(instance, "title", "de")!.value, "kept").toBe('"Wegfahrer"');
  await uploadJson(instance.service, { "common.json": ENGLISH });
  expect(outdated()).toBe(false);
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
  expect(row.source_hash).toStrictEqual(english.source_hash);
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
  expect(revisions).toStrictEqual([before + 1, before + 1]);
  expect(getRevision(instance.sql)).toStrictEqual(before + 1);
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
  expect(() => run({ stringId: titleId, language: "fr" })).toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "bad_request" }),
  );
  expect(() => run({ stringId: titleId, language: "en" })).toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "bad_request" }),
  );
  expect(() => run({ stringId: literal, language: "de" })).toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "bad_request" }),
  );
  expect(() => run({ stringId: 9999, language: "de" })).toThrow(
    expect.objectContaining({ constructor: ServiceError, code: "not_found" }),
  );
  const { title: _, ...withoutTitle } = ENGLISH;
  await instance.service.upload(SYSTEM, {
    files: [
      { path: "common.json", repoPath: "common.json", content: JSON.stringify(withoutTitle) },
    ],
  });
  const error = await Promise.try(() => run({ stringId: titleId, language: "de" })).catch(
    (error: unknown) => error,
  );
  assert(error instanceof ServiceError);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("not_found");
});

test("language tags are matched in their canonical form", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { hi: "Hi" } }, { languages: ["pt-br"] });
  expect(write(instance, "a.json", "hi", "PT-BR", "Oi").status).toBe("written");
  expect(instance.sql.query("SELECT language FROM translations")).toStrictEqual([
    { language: "pt-BR" },
  ]);
});
