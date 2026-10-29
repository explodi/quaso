// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { SYSTEM } from "./api.ts";
import { getRevision, transaction } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { loadSettings } from "./settings.ts";
import { writeTranslation } from "./translations.ts";
import { MAX_LENGTH_LIMIT } from "./upload.ts";
import {
  count,
  createToken,
  jsonFile,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  menu: { play: "Play", quit: "Quit" },
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  back: "$t(menu.quit)",
  version: 3,
};

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(instance.service, { "common.json": COMMON }, { languages: ["de", "fr"] });
  return instance;
}

/** Every table the upload writes, counted. */
function snapshot(instance: TestInstance) {
  return {
    revision: getRevision(instance.sql),
    strings: instance.sql.query("SELECT * FROM strings ORDER BY id"),
    files: instance.sql.query("SELECT * FROM files ORDER BY id"),
    translations: instance.sql.query("SELECT * FROM translations ORDER BY string_id, language"),
    history: count(instance.sql, "history"),
    uploads: count(instance.sql, "uploads"),
    activity: count(instance.sql, "activity"),
    languages: instance.sql.query("SELECT tag FROM languages ORDER BY tag"),
    settings: instance.sql.query("SELECT data FROM settings"),
  };
}

test("a first upload adds every entry in file order, and records it", async () => {
  using instance = await startTestService();
  const result = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      languages: ["de", "fr"],
    },
  );
  expect(result.dryRun).toBe(false);
  expect(result.files).toStrictEqual([
    {
      path: "common.json",
      status: "new",
      added: 6,
      changed: 0,
      removed: 0,
      restored: 0,
      moved: 0,
      unchanged: 0,
    },
  ]);
  expect(result.added.map((ref) => ref.key)).toStrictEqual([
    "title",
    "menu.play",
    "menu.quit",
    "coins",
    "back",
    "version",
  ]);
  expect(result.added[0]).toStrictEqual({ file: "common.json", key: "title" });
  expect(result.languagesAdded).toStrictEqual(["de", "fr"]);
  expect(result.warnings).toStrictEqual([]);
  expect(result.job).toBe(null);
  expect(result.revision).toBe(1);
  expect(getRevision(instance.sql)).toBe(1);
  expect(typeof result.uploadId).toBe("number");
  expect(count(instance.sql, "uploads")).toBe(1);
  expect(count(instance.sql, "activity", "type = 'upload'")).toBe(1);
  expect(count(instance.sql, "history", "event = 'source_added' AND language IS NULL")).toBe(6);
  const rows = instance.sql.query(
    "SELECT display_key, kind, source, words, position FROM strings ORDER BY position",
  );
  expect(rows).toStrictEqual([
    { display_key: "title", kind: "text", source: '"Wayfarer"', words: 1, position: 0 },
    { display_key: "menu.play", kind: "text", source: '"Play"', words: 1, position: 1 },
    { display_key: "menu.quit", kind: "text", source: '"Quit"', words: 1, position: 2 },
    {
      display_key: "coins",
      kind: "plural",
      source: '{"one":"{{count}} coin","other":"{{count}} coins"}',
      words: 2,
      position: 3,
    },
    { display_key: "back", kind: "reference", source: '"$t(menu.quit)"', words: 0, position: 4 },
    { display_key: "version", kind: "literal", source: '"3"', words: 0, position: 5 },
  ]);
  const [history] = instance.sql.query(
    "SELECT after_value, actor_type, actor_label, detail FROM history ORDER BY id LIMIT 1",
  );
  expect(history).toStrictEqual({
    after_value: '"Wayfarer"',
    actor_type: "system",
    actor_label: "System",
    detail: JSON.stringify({ upload: result.uploadId }),
  });
});

test("uploading the same files again changes nothing and writes nothing", async () => {
  using instance = await project();
  const before = snapshot(instance);
  const result = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      languages: ["de", "fr"],
    },
  );
  expect(result.uploadId).toBe(null);
  expect(result.files[0].status).toBe("unchanged");
  expect(result.files[0].unchanged).toBe(6);
  expect([result.added, result.changed, result.removed, result.restored]).toStrictEqual([
    [],
    [],
    [],
    [],
  ]);
  expect(result.revision).toStrictEqual(before.revision);
  expect(snapshot(instance)).toStrictEqual(before);
});

test("changed English keeps the translations, which become outdated", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const result = await uploadJson(instance.service, {
    "common.json": { ...COMMON, menu: { play: "Play now", quit: "Quit" } },
  });
  expect(result.changed).toStrictEqual([{ file: "common.json", key: "menu.play" }]);
  expect(result.files[0].status).toBe("updated");
  expect(result.files[0].changed).toBe(1);
  expect(result.files[0].unchanged).toBe(5);
  expect(count(instance.sql, "translations")).toBe(1);
  const [history] = instance.sql.query(
    "SELECT before_value, after_value FROM history WHERE event = 'source_changed'",
  );
  expect(history).toStrictEqual({ before_value: '"Play"', after_value: '"Play now"' });
  const [row] = instance.sql.query(
    `SELECT t.source_hash <> s.source_hash AS outdated FROM translations t
     JOIN strings s ON s.id = t.string_id`,
  );
  expect(row.outdated).toBe(1);
});

test("removed keys are hidden, and come back with their translations", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.quit", "de", "Beenden");
  const quit = stringId(instance.sql, "common.json", "menu.quit");
  const { menu: _, ...withoutMenu } = COMMON;
  const removed = await uploadJson(instance.service, {
    "common.json": { ...withoutMenu, menu: { play: "Play" } },
  });
  expect(removed.removed).toStrictEqual([{ file: "common.json", key: "menu.quit" }]);
  expect(instance.sql.query("SELECT active FROM strings WHERE id = ?", quit)).toStrictEqual([
    {
      active: 0,
    },
  ]);
  expect(count(instance.sql, "translations"), "never deleted").toBe(1);
  const restored = await uploadJson(instance.service, {
    "common.json": { ...COMMON, menu: { play: "Play", quit: "Quit the game" } },
  });
  expect(restored.restored).toStrictEqual([{ file: "common.json", key: "menu.quit" }]);
  expect(restored.changed).toStrictEqual([]);
  expect(restored.files[0].restored).toBe(1);
  expect(instance.sql.query("SELECT active FROM strings WHERE id = ?", quit)).toStrictEqual([
    {
      active: 1,
    },
  ]);
  expect(stringId(instance.sql, "common.json", "menu.quit"), "the same string").toStrictEqual(quit);
  const [row] = instance.sql.query(
    `SELECT t.value, t.source_hash <> s.source_hash AS outdated FROM translations t
     JOIN strings s ON s.id = t.string_id`,
  );
  expect(row).toStrictEqual({ value: '"Beenden"', outdated: 1 });
  const events = instance.sql.query<{ event: string; before_value: string | null }>(
    "SELECT event, before_value FROM history WHERE string_id = ? AND language IS NULL ORDER BY id",
    quit,
  );
  expect(events.map((event) => event.event)).toStrictEqual([
    "source_added",
    "source_removed",
    "source_restored",
  ]);
  expect(events[2].before_value).toBe('"Quit"');
});

test("moved keys are counted, with no history", async () => {
  using instance = await project();
  const history = count(instance.sql, "history");
  const { title, ...rest } = COMMON;
  const result = await uploadJson(instance.service, { "common.json": { ...rest, title } });
  expect(result.files[0].moved).toBe(6);
  expect(result.files[0].status).toBe("updated");
  expect([result.added, result.changed, result.removed]).toStrictEqual([[], [], []]);
  expect(count(instance.sql, "history")).toStrictEqual(history);
  expect(
    instance.sql
      .query("SELECT display_key FROM strings WHERE active = 1 ORDER BY position")
      .map((row) => row.display_key),
  ).toStrictEqual(["menu.play", "menu.quit", "coins", "back", "version", "title"]);
  expect(typeof result.uploadId, "the order changed, so the files did").toBe("number");
});

test("a dry run reports everything and writes nothing", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Wegfahrer");
  const before = snapshot(instance);
  const changes = {
    "common.json": { title: "Wayfarer!", menu: { play: "Play" }, extra: "New" },
    "hud.json": { hp: "HP" },
  };
  const dry = await uploadJson(instance.service, changes, {
    dryRun: true,
    languages: ["de", "it"],
    limits: [{ file: "common.json", key: "title", maxLength: 3 }],
  });
  expect(dry.dryRun).toBe(true);
  expect(dry.uploadId).toBe(null);
  expect(dry.revision).toStrictEqual(before.revision);
  expect(dry.languagesAdded).toStrictEqual(["it"]);
  expect(dry.added.map((ref) => ref.key)).toStrictEqual(["extra", "hp"]);
  expect(dry.changed.map((ref) => ref.key)).toStrictEqual(["title"]);
  expect(dry.removed.map((ref) => ref.key)).toStrictEqual([
    "menu.quit",
    "coins",
    "back",
    "version",
  ]);
  expect(snapshot(instance)).toStrictEqual(before);
  const real = await uploadJson(instance.service, changes, {
    languages: ["de", "it"],
    limits: [{ file: "common.json", key: "title", maxLength: 3 }],
  });
  expect({ ...real, dryRun: true, uploadId: null, revision: dry.revision }).toStrictEqual(dry);
});

test("a full upload hides the files it doesn't include; a partial one doesn't", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" }, "b.json": { b: "B" } });
  const partial = await uploadJson(instance.service, { "a.json": { a: "A" } }, { partial: true });
  expect(partial.hiddenFiles).toStrictEqual([]);
  expect(partial.uploadId).toBe(null);
  const full = await uploadJson(instance.service, { "a.json": { a: "A" } });
  expect(full.hiddenFiles).toStrictEqual(["b.json"]);
  expect(full.files.map((file) => [file.path, file.status])).toStrictEqual([
    ["a.json", "unchanged"],
    ["b.json", "hidden"],
  ]);
  expect(instance.sql.query("SELECT path, active FROM files ORDER BY path")).toStrictEqual([
    { path: "a.json", active: 1 },
    { path: "b.json", active: 0 },
  ]);
  const back = await uploadJson(instance.service, { "a.json": { a: "A" }, "b.json": { b: "B" } });
  expect(back.files.map((file) => [file.path, file.status])).toStrictEqual([
    ["a.json", "unchanged"],
    ["b.json", "restored"],
  ]);
  expect(back.added).toStrictEqual([]);
  expect(count(instance.sql, "files", "active = 1")).toBe(2);
});

test("a changed format updates the file and is kept as it comes", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  const result = await instance.service.upload(SYSTEM, {
    files: [{ path: "a.json", repoPath: "a.json", content: '{\r\n\t"a": "A"\r\n}' }],
  });
  expect(result.files[0].status).toBe("updated");
  expect(result.files[0].unchanged).toBe(1);
  expect(
    JSON.parse(instance.sql.query<{ format: string }>("SELECT format FROM files")[0].format),
  ).toStrictEqual({ indent: "\t", newline: "\r\n", finalNewline: false });
});

test("empty uploads and duplicate paths are refused", async () => {
  using instance = await startTestService();
  const empty = await instance.service
    .upload(SYSTEM, { files: [] })
    .catch((error: unknown) => error);
  assert(empty instanceof ServiceError);
  expect(empty.code).toBe("bad_request");
  const twice = await instance.service
    .upload(SYSTEM, {
      files: [
        { ...jsonFile("a.json", {}), repoPath: "a.json" },
        { ...jsonFile("a.json", {}), repoPath: "a.json" },
      ],
    })
    .catch((error: unknown) => error);
  assert(twice instanceof ServiceError);
  expect(twice.code).toBe("bad_request");
});

test("syntax errors in several files are reported together, with file, line and column", async () => {
  using instance = await startTestService();
  const error = await instance.service
    .upload(SYSTEM, {
      files: [
        { path: "good.json", repoPath: "good.json", content: '{"a": "A"}' },
        { path: "broken.json", repoPath: "broken.json", content: '{\n  "a": "A",\n  "b" "B"\n}' },
        { path: "dup.json", repoPath: "dup.json", content: '{\n  "a": "A",\n  "a": "B"\n}' },
        { path: "array.json", repoPath: "array.json", content: "[1, 2]" },
      ],
    })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("invalid_source");
  expect(error.status).toBe(422);
  expect(error.details?.map((detail) => [detail.file, detail.line, detail.column])).toStrictEqual([
    ["broken.json", 3, 7],
    ["dup.json", 3, 3],
    ["array.json", 1, 1],
  ]);
  expect(error.details?.[1].key).toBe("a");
  expect(error.message.startsWith("broken.json:3:7: ")).toBe(true);
  expect(error.message.endsWith("(and 2 more)")).toBe(true);
  expect(count(instance.sql, "strings")).toBe(0);
});

test("the source language must match once the instance has strings", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } }, { sourceLanguage: "de" });
  expect(loadSettings(instance.ctx).sourceLanguage, "a new instance adopts it").toBe("de");
  const error = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    { sourceLanguage: "en" },
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("bad_request");
  expect(error.message.includes("de on the server")).toBe(true);
  const same = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    {
      sourceLanguage: "de",
      languages: ["de", "en"],
    },
  );
  expect(same.languagesAdded, "never the source language").toStrictEqual(["en"]);
});

test("languages are added once, canonical, with a warning when the runtime lacks plural rules", async () => {
  using instance = await startTestService();
  const result = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    {
      languages: ["pt-br", "pt-BR", "qaa", "en"],
    },
  );
  expect(result.languagesAdded).toStrictEqual(["pt-BR", "qaa"]);
  expect(result.warnings).toStrictEqual([
    "The server's runtime has no plural rules for qaa; set a plural override for it in the settings",
  ]);
  const again = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    {
      languages: ["pt-BR"],
    },
  );
  expect(again.languagesAdded).toStrictEqual([]);
  expect(again.uploadId).toBe(null);
});

test("limits set locked maximum lengths, recheck translations, and clear old ones (FMT-4)", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "de", "Der Wegfahrer");
  const limited = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      limits: [
        { file: "common.json", key: "title", maxLength: 5 },
        { file: "common.json", key: "missing", maxLength: 5 },
        { file: "other.json", key: "title", maxLength: 5 },
        { file: "common.json", key: "version", maxLength: 5 },
      ],
    },
  );
  expect(typeof limited.uploadId).toBe("number");
  expect(limited.warnings.length).toBe(3);
  expect(limited.warnings[0]).toStrictEqual(
    "The limit for common.json › missing names a string the server doesn't have, so it does nothing: remove it, or correct its file and key",
  );
  const limits = () =>
    instance.sql.query(
      "SELECT max_length, max_length_locked FROM strings WHERE display_key = 'title'",
    )[0];
  expect(limits()).toStrictEqual({ max_length: 5, max_length_locked: 1 });
  const qa = () => instance.sql.query("SELECT qa_errors FROM translations")[0].qa_errors;
  expect(qa(), "the translation now fails, and stays").toBe(1);
  const again = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      limits: [{ file: "common.json", key: "title", maxLength: 5 }],
    },
  );
  expect(again.uploadId, "the same limit changes nothing").toBe(null);
  await uploadJson(instance.service, { "common.json": COMMON });
  expect(limits()).toStrictEqual({ max_length: null, max_length_locked: 0 });
  expect(qa()).toBe(0);
});

test("renames move translations and history to the new key (STR-6)", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const play = stringId(instance.sql, "common.json", "menu.play");
  const renamedEnglish = { ...COMMON, menu: { start: "Play", quit: "Quit" } };
  const result = await uploadJson(
    instance.service,
    { "common.json": renamedEnglish },
    {
      renames: [{ from: "menu.play", to: "menu.start" }],
    },
  );
  expect(result.renamed).toStrictEqual([
    { file: "common.json", from: "menu.play", to: "menu.start" },
  ]);
  expect(result.renameSuggestions).toStrictEqual([]);
  const start = stringId(instance.sql, "common.json", "menu.start");
  expect(instance.sql.query("SELECT string_id, value FROM translations")).toStrictEqual([
    { string_id: start, value: '"Spielen"' },
  ]);
  expect(count(instance.sql, "history", `string_id = ${play}`), "the removal stays").toStrictEqual(
    1,
  );
  const events = instance.sql
    .query<{ event: string }>("SELECT event FROM history WHERE string_id = ? ORDER BY id", start)
    .map((row) => row.event);
  expect(events).toStrictEqual([
    "source_added",
    "translation_llm",
    "source_added",
    "source_renamed",
  ]);
});

test("rename errors name the key", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  // A person's: a rename never replaces it (only what the LLM alone wrote).
  write(instance, "common.json", "menu.quit", "de", "Beenden", {
    actor: { type: "user", id: 1, label: null },
    event: "translation_saved",
  });
  const withoutPlay = { ...COMMON, menu: { quit: "Quit" } };
  const rejects = async (renames: { file?: string; from: string; to: string }[], text: string) => {
    const error = await uploadJson(
      instance.service,
      { "common.json": withoutPlay },
      { renames },
    ).catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("bad_request");
    expect(error.message.includes(text), error.message).toBe(true);
  };
  await rejects([{ from: "nothing", to: "menu.play" }], "no key nothing");
  await rejects([{ from: "menu.play", to: "missing" }], "no key missing in common.json");
  await rejects([{ from: "menu.play", to: "menu.quit" }], "menu.quit already has translations");
  await rejects([{ from: "menu.play", to: "coins" }], "text string but coins is a plural");
  await rejects([{ file: "other.json", from: "menu.play", to: "title" }], "in other.json");
  expect(count(instance.sql, "translations", "value = '\"Spielen\"'")).toBe(1);
});

test("a rename from a key the English still has is refused", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    { "a.json": { quit: "Quit", exit: "Exit" } },
    {
      languages: ["de"],
    },
  );
  write(instance, "a.json", "quit", "de", "Beenden");
  const error = await uploadJson(
    instance.service,
    { "a.json": { quit: "Quit", exit: "Exit" } },
    {
      renames: [{ from: "quit", to: "exit" }],
    },
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("bad_request");
  expect(error.message).toContain("Can't rename quit: the English still has it.");
  expect(instance.sql.query("SELECT string_id, value FROM translations")).toStrictEqual([
    { string_id: stringId(instance.sql, "a.json", "quit"), value: '"Beenden"' },
  ]);
});

test("sending the same rename again changes nothing", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    { "a.json": { play: "Play", quit: "Quit" } },
    {
      languages: ["de"],
    },
  );
  write(instance, "a.json", "play", "de", "Spielen");
  const request = { renames: [{ from: "play", to: "start" }] };
  const first = await uploadJson(
    instance.service,
    { "a.json": { start: "Play", quit: "Quit" } },
    request,
  );
  expect(typeof first.uploadId).toBe("number");
  const before = snapshot(instance);
  const again = await uploadJson(
    instance.service,
    { "a.json": { start: "Play", quit: "Quit" } },
    request,
  );
  expect(again.uploadId).toBe(null);
  expect(again.renamed).toStrictEqual([]);
  expect(again.renameSuggestions).toStrictEqual([]);
  expect(snapshot(instance)).toStrictEqual(before);
});

test("a rename needs the file when the key is in several files", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { x: "X" }, "b.json": { x: "X" } });
  const renamed = { "a.json": { y: "X" }, "b.json": { y: "X" } };
  const error = await uploadJson(instance.service, renamed, {
    renames: [{ from: "x", to: "y" }],
  }).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.message.includes("several files (a.json, b.json)")).toBe(true);
  const ok = await uploadJson(instance.service, renamed, {
    renames: [{ file: "a.json", from: "x", to: "y" }],
  });
  expect(ok.renamed).toStrictEqual([{ file: "a.json", from: "x", to: "y" }]);
});

test("keys that name several strings take their kind or their key path", async () => {
  using instance = await startTestService();
  const coins = { coins: "Coins", coins_one: "{{count}} coin", coins_other: "{{count}} coins" };
  await uploadJson(
    instance.service,
    { "c.json": { ...coins, a: { b: "B" }, "a.b": "AB" } },
    {
      languages: ["de"],
    },
  );
  write(instance, "c.json", "coins#text", "de", "Münzen");
  write(instance, "c.json", "coins#plural", "de", {
    one: "{{count}} Münze",
    other: "{{count}} Münzen",
  });
  const plural = stringId(instance.sql, "c.json", "coins#plural");
  const money = {
    money: "Coins",
    money_one: "{{count}} coin",
    money_other: "{{count}} coins",
    a: { b: "B" },
    "a.b": "AB",
  };
  const dry = await uploadJson(instance.service, { "c.json": money }, { dryRun: true });
  expect(dry.renameSuggestions).toStrictEqual([
    { file: "c.json", from: "coins#text", to: "money#text" },
    { file: "c.json", from: "coins#plural", to: "money#plural" },
  ]);
  const ambiguous = await uploadJson(
    instance.service,
    { "c.json": money },
    {
      renames: [{ from: "coins", to: "money" }],
    },
  ).catch((error: unknown) => error);
  assert(ambiguous instanceof ServiceError);
  expect(ambiguous.message).toContain("several strings have the key coins in c.json");
  const result = await uploadJson(
    instance.service,
    { "c.json": money },
    {
      renames: [{ from: "coins#plural", to: "money#plural" }],
      limits: [
        { file: "c.json", key: "money", maxLength: 6 },
        { file: "c.json", key: "money#text", maxLength: 7 },
        { file: "c.json", key: "a.b", maxLength: 5 },
        { file: "c.json", key: '["a", "b"]', maxLength: 4 },
      ],
    },
  );
  expect(result.renamed).toStrictEqual([
    { file: "c.json", from: "coins#plural", to: "money#plural" },
  ]);
  expect(result.renameSuggestions).toStrictEqual([
    {
      file: "c.json",
      from: "coins#text",
      to: "money#text",
    },
  ]);
  expect(result.warnings.length).toBe(2);
  expect(result.warnings[0]).toContain("The limit for c.json › money names 2 strings");
  expect(result.warnings[1]).toContain("The limit for c.json › a.b names 2 strings");
  expect(
    instance.sql.query(
      "SELECT key, max_length FROM strings WHERE active = 1 AND max_length IS NOT NULL ORDER BY key",
    ),
  ).toStrictEqual([
    { key: '["a","b"]', max_length: 4 },
    { key: '["money"]', max_length: 7 },
  ]);
  expect(
    instance.sql.query("SELECT value FROM translations WHERE string_id = ?", plural).length,
    "the plural's translation moved",
  ).toBe(0);
});

test("a text that becomes a plural can take its plural's translations under a new key", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "c.json": { coins: "Coins" } }, { languages: ["de"] });
  await uploadJson(instance.service, {
    "c.json": { coins_one: "{{count}} coin", coins_other: "{{count}} coins" },
  });
  write(instance, "c.json", "coins", "de", { one: "{{count}} Münze", other: "{{count}} Münzen" });
  const renamed = {
    "c.json": { coinCount_one: "{{count}} coin", coinCount_other: "{{count}} coins" },
  };
  const dry = await uploadJson(instance.service, renamed, { dryRun: true });
  expect(dry.renameSuggestions).toStrictEqual([
    { file: "c.json", from: "coins#plural", to: "coinCount" },
  ]);
  const result = await uploadJson(instance.service, renamed, {
    renames: [{ from: "coins", to: "coinCount" }],
  });
  expect(result.renamed.length).toBe(1);
  expect(
    instance.sql.query(
      "SELECT s.display_key, s.kind FROM translations t JOIN strings s ON s.id = t.string_id",
    ),
  ).toStrictEqual([{ display_key: "coinCount", kind: "plural" }]);
});

test("a removed translated key and an added key with the same English suggest a rename", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const result = await uploadJson(instance.service, {
    "common.json": {
      ...COMMON,
      menu: { start: "Play", begin: "Play", quit: "Quit", leave: "Quit" },
    },
  });
  expect(result.renameSuggestions).toStrictEqual([
    { file: "common.json", from: "menu.play", to: "menu.start" },
    { file: "common.json", from: "menu.play", to: "menu.begin" },
  ]);
});

test("rename suggestions pair strings with the same English in order, not every pair", async () => {
  using instance = await startTestService();
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, description: "No description yet" }));
  await uploadJson(
    instance.service,
    { "items.json": { items: items(300) } },
    {
      languages: ["de"],
    },
  );
  const ids = instance.sql.query<{ id: number }>("SELECT id FROM strings ORDER BY id");
  transaction(instance.sql, () => {
    for (const { id } of ids) {
      writeTranslation(instance.ctx, {
        stringId: id,
        language: "de",
        value: "Noch nichts",
        colour: "green",
        actor: { type: "llm", id: null, label: "test-model" },
        event: "translation_llm",
        allowQaErrors: true,
      });
    }
  });
  const result = await uploadJson(
    instance.service,
    { "items.json": { itemData: items(300) } },
    {
      dryRun: true,
    },
  );
  expect(result.renameSuggestions.length).toBe(600);
  expect(result.renameSuggestions.slice(0, 2)).toStrictEqual([
    { file: "items.json", from: "items.0.name", to: "itemData.0.name" },
    { file: "items.json", from: "items.0.description", to: "itemData.0.description" },
  ]);
  expect(result.renameSuggestions.at(-1)).toStrictEqual({
    file: "items.json",
    from: "items.299.description",
    to: "itemData.299.description",
  });
});

test("limits: the same string twice applies the last one, once", async () => {
  using instance = await startTestService();
  const limits = [
    { file: "store.json", key: "title", maxLength: 30 },
    { file: "store.json", key: "title", maxLength: 50 },
  ];
  const first = await uploadJson(
    instance.service,
    { "store.json": { title: "My game" } },
    {
      limits,
    },
  );
  expect(first.warnings).toStrictEqual([
    "The limits for store.json › title and store.json › title name the same string; the last one (50) applies",
  ]);
  const again = await uploadJson(
    instance.service,
    { "store.json": { title: "My game" } },
    {
      limits,
    },
  );
  expect(again.uploadId).toBe(null);
  expect(count(instance.sql, "uploads")).toBe(1);
  expect(instance.sql.query("SELECT max_length FROM strings")).toStrictEqual([{ max_length: 50 }]);
});

test("limits above the largest are refused before anything is stored", async () => {
  using instance = await startTestService();
  for (const maxLength of [MAX_LENGTH_LIMIT + 1, 9007199254740993, 1e20]) {
    const error = await uploadJson(
      instance.service,
      { "a.json": { title: "Hello" } },
      {
        limits: [{ file: "a.json", key: "title", maxLength }],
      },
    ).catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("validation_failed");
    expect(error.details?.[0].path).toBe("limits[0].maxLength");
  }
  expect(count(instance.sql, "strings")).toBe(0);
});

test("a key that changes kind is a change", async () => {
  using instance = await project();
  const result = await uploadJson(instance.service, { "common.json": { ...COMMON, title: 7 } });
  expect(result.changed).toStrictEqual([{ file: "common.json", key: "title" }]);
  expect(
    instance.sql.query("SELECT kind, source FROM strings WHERE display_key = 'title'"),
  ).toStrictEqual([{ kind: "literal", source: '"7"' }]);
});

test("plural exclusions keep look-alike keys as plain strings", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    { "a.json": { power_one: "One", power_other: "Many" } },
    {
      pluralExclusions: [{ file: "a.json", key: "power" }],
    },
  );
  expect(
    instance.sql.query("SELECT display_key, kind FROM strings ORDER BY position"),
  ).toStrictEqual([
    { display_key: "power_one", kind: "text" },
    { display_key: "power_other", kind: "text" },
  ]);
});

test("uploads by an API key record the key", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "upload", "CI");
  await uploadJson(instance.service, { "a.json": { a: "A" } }, {}, token.actor);
  expect(instance.sql.query("SELECT actor_type, actor_id FROM uploads")).toStrictEqual([
    { actor_type: "token", actor_id: token.id },
  ]);
  expect(instance.sql.query("SELECT actor_label FROM activity")).toStrictEqual([
    { actor_label: "CI" },
  ]);
});
