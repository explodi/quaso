// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
  assertEquals(result.dryRun, false);
  assertEquals(result.files, [
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
  assertEquals(
    result.added.map((ref) => ref.key),
    ["title", "menu.play", "menu.quit", "coins", "back", "version"],
  );
  assertEquals(result.added[0], { file: "common.json", key: "title" });
  assertEquals(result.languagesAdded, ["de", "fr"]);
  assertEquals(result.warnings, []);
  assertEquals(result.job, null);
  assertEquals(result.revision, 1);
  assertEquals(getRevision(instance.sql), 1);
  assertEquals(typeof result.uploadId, "number");
  assertEquals(count(instance.sql, "uploads"), 1);
  assertEquals(count(instance.sql, "activity", "type = 'upload'"), 1);
  assertEquals(count(instance.sql, "history", "event = 'source_added' AND language IS NULL"), 6);
  const rows = instance.sql.query(
    "SELECT display_key, kind, source, words, position FROM strings ORDER BY position",
  );
  assertEquals(rows, [
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
  assertEquals(history, {
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
  assertEquals(result.uploadId, null);
  assertEquals(result.files[0].status, "unchanged");
  assertEquals(result.files[0].unchanged, 6);
  assertEquals([result.added, result.changed, result.removed, result.restored], [[], [], [], []]);
  assertEquals(result.revision, before.revision);
  assertEquals(snapshot(instance), before);
});

test("changed English keeps the translations, which become outdated", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.play", "de", "Spielen");
  const result = await uploadJson(instance.service, {
    "common.json": { ...COMMON, menu: { play: "Play now", quit: "Quit" } },
  });
  assertEquals(result.changed, [{ file: "common.json", key: "menu.play" }]);
  assertEquals(result.files[0].status, "updated");
  assertEquals(result.files[0].changed, 1);
  assertEquals(result.files[0].unchanged, 5);
  assertEquals(count(instance.sql, "translations"), 1);
  const [history] = instance.sql.query(
    "SELECT before_value, after_value FROM history WHERE event = 'source_changed'",
  );
  assertEquals(history, { before_value: '"Play"', after_value: '"Play now"' });
  const [row] = instance.sql.query(
    `SELECT t.source_hash <> s.source_hash AS outdated FROM translations t
     JOIN strings s ON s.id = t.string_id`,
  );
  assertEquals(row.outdated, 1);
});

test("removed keys are hidden, and come back with their translations", async () => {
  using instance = await project();
  write(instance, "common.json", "menu.quit", "de", "Beenden");
  const quit = stringId(instance.sql, "common.json", "menu.quit");
  const { menu: _, ...withoutMenu } = COMMON;
  const removed = await uploadJson(instance.service, {
    "common.json": { ...withoutMenu, menu: { play: "Play" } },
  });
  assertEquals(removed.removed, [{ file: "common.json", key: "menu.quit" }]);
  assertEquals(instance.sql.query("SELECT active FROM strings WHERE id = ?", quit), [
    {
      active: 0,
    },
  ]);
  assertEquals(count(instance.sql, "translations"), 1, "never deleted");
  const restored = await uploadJson(instance.service, {
    "common.json": { ...COMMON, menu: { play: "Play", quit: "Quit the game" } },
  });
  assertEquals(restored.restored, [{ file: "common.json", key: "menu.quit" }]);
  assertEquals(restored.changed, []);
  assertEquals(restored.files[0].restored, 1);
  assertEquals(instance.sql.query("SELECT active FROM strings WHERE id = ?", quit), [
    {
      active: 1,
    },
  ]);
  assertEquals(stringId(instance.sql, "common.json", "menu.quit"), quit, "the same string");
  const [row] = instance.sql.query(
    `SELECT t.value, t.source_hash <> s.source_hash AS outdated FROM translations t
     JOIN strings s ON s.id = t.string_id`,
  );
  assertEquals(row, { value: '"Beenden"', outdated: 1 });
  const events = instance.sql.query<{ event: string; before_value: string | null }>(
    "SELECT event, before_value FROM history WHERE string_id = ? AND language IS NULL ORDER BY id",
    quit,
  );
  assertEquals(
    events.map((event) => event.event),
    ["source_added", "source_removed", "source_restored"],
  );
  assertEquals(events[2].before_value, '"Quit"');
});

test("moved keys are counted, with no history", async () => {
  using instance = await project();
  const history = count(instance.sql, "history");
  const { title, ...rest } = COMMON;
  const result = await uploadJson(instance.service, { "common.json": { ...rest, title } });
  assertEquals(result.files[0].moved, 6);
  assertEquals(result.files[0].status, "updated");
  assertEquals([result.added, result.changed, result.removed], [[], [], []]);
  assertEquals(count(instance.sql, "history"), history);
  assertEquals(
    instance.sql
      .query("SELECT display_key FROM strings WHERE active = 1 ORDER BY position")
      .map((row) => row.display_key),
    ["menu.play", "menu.quit", "coins", "back", "version", "title"],
  );
  assertEquals(typeof result.uploadId, "number", "the order changed, so the files did");
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
  assertEquals(dry.dryRun, true);
  assertEquals(dry.uploadId, null);
  assertEquals(dry.revision, before.revision);
  assertEquals(dry.languagesAdded, ["it"]);
  assertEquals(
    dry.added.map((ref) => ref.key),
    ["extra", "hp"],
  );
  assertEquals(
    dry.changed.map((ref) => ref.key),
    ["title"],
  );
  assertEquals(
    dry.removed.map((ref) => ref.key),
    ["menu.quit", "coins", "back", "version"],
  );
  assertEquals(snapshot(instance), before);
  const real = await uploadJson(instance.service, changes, {
    languages: ["de", "it"],
    limits: [{ file: "common.json", key: "title", maxLength: 3 }],
  });
  assertEquals({ ...real, dryRun: true, uploadId: null, revision: dry.revision }, dry);
});

test("a full upload hides the files it doesn't include; a partial one doesn't", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" }, "b.json": { b: "B" } });
  const partial = await uploadJson(instance.service, { "a.json": { a: "A" } }, { partial: true });
  assertEquals(partial.hiddenFiles, []);
  assertEquals(partial.uploadId, null);
  const full = await uploadJson(instance.service, { "a.json": { a: "A" } });
  assertEquals(full.hiddenFiles, ["b.json"]);
  assertEquals(
    full.files.map((file) => [file.path, file.status]),
    [
      ["a.json", "unchanged"],
      ["b.json", "hidden"],
    ],
  );
  assertEquals(instance.sql.query("SELECT path, active FROM files ORDER BY path"), [
    { path: "a.json", active: 1 },
    { path: "b.json", active: 0 },
  ]);
  const back = await uploadJson(instance.service, { "a.json": { a: "A" }, "b.json": { b: "B" } });
  assertEquals(
    back.files.map((file) => [file.path, file.status]),
    [
      ["a.json", "unchanged"],
      ["b.json", "restored"],
    ],
  );
  assertEquals(back.added, []);
  assertEquals(count(instance.sql, "files", "active = 1"), 2);
});

test("a changed format updates the file and is kept as it comes", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } });
  const result = await instance.service.upload(SYSTEM, {
    files: [{ path: "a.json", repoPath: "a.json", content: '{\r\n\t"a": "A"\r\n}' }],
  });
  assertEquals(result.files[0].status, "updated");
  assertEquals(result.files[0].unchanged, 1);
  assertEquals(
    JSON.parse(instance.sql.query<{ format: string }>("SELECT format FROM files")[0].format),
    { indent: "\t", newline: "\r\n", finalNewline: false },
  );
});

test("empty uploads and duplicate paths are refused", async () => {
  using instance = await startTestService();
  const empty = await assertRejects(
    () => instance.service.upload(SYSTEM, { files: [] }),
    ServiceError,
  );
  assertEquals(empty.code, "bad_request");
  const twice = await assertRejects(
    () =>
      instance.service.upload(SYSTEM, {
        files: [
          { ...jsonFile("a.json", {}), repoPath: "a.json" },
          { ...jsonFile("a.json", {}), repoPath: "a.json" },
        ],
      }),
    ServiceError,
  );
  assertEquals(twice.code, "bad_request");
});

test("syntax errors in several files are reported together, with file, line and column", async () => {
  using instance = await startTestService();
  const error = await assertRejects(
    () =>
      instance.service.upload(SYSTEM, {
        files: [
          { path: "good.json", repoPath: "good.json", content: '{"a": "A"}' },
          { path: "broken.json", repoPath: "broken.json", content: '{\n  "a": "A",\n  "b" "B"\n}' },
          { path: "dup.json", repoPath: "dup.json", content: '{\n  "a": "A",\n  "a": "B"\n}' },
          { path: "array.json", repoPath: "array.json", content: "[1, 2]" },
        ],
      }),
    ServiceError,
  );
  assertEquals(error.code, "invalid_source");
  assertEquals(error.status, 422);
  assertEquals(
    error.details?.map((detail) => [detail.file, detail.line, detail.column]),
    [
      ["broken.json", 3, 7],
      ["dup.json", 3, 3],
      ["array.json", 1, 1],
    ],
  );
  assertEquals(error.details?.[1].key, "a");
  assertEquals(error.message.startsWith("broken.json:3:7: "), true);
  assertEquals(error.message.endsWith("(and 2 more)"), true);
  assertEquals(count(instance.sql, "strings"), 0);
});

test("the source language must match once the instance has strings", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { a: "A" } }, { sourceLanguage: "de" });
  assertEquals(loadSettings(instance.ctx).sourceLanguage, "de", "a new instance adopts it");
  const error = await assertRejects(
    () => uploadJson(instance.service, { "a.json": { a: "A" } }, { sourceLanguage: "en" }),
    ServiceError,
  );
  assertEquals(error.code, "bad_request");
  assertEquals(error.message.includes("de on the server"), true);
  const same = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    {
      sourceLanguage: "de",
      languages: ["de", "en"],
    },
  );
  assertEquals(same.languagesAdded, ["en"], "never the source language");
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
  assertEquals(result.languagesAdded, ["pt-BR", "qaa"]);
  assertEquals(result.warnings, [
    "The server's runtime has no plural rules for qaa; set a plural override for it in the settings",
  ]);
  const again = await uploadJson(
    instance.service,
    { "a.json": { a: "A" } },
    {
      languages: ["pt-BR"],
    },
  );
  assertEquals(again.languagesAdded, []);
  assertEquals(again.uploadId, null);
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
  assertEquals(typeof limited.uploadId, "number");
  assertEquals(limited.warnings.length, 3);
  assertEquals(
    limited.warnings[0],
    "The limit for common.json › missing names a string the server doesn't have",
  );
  const limits = () =>
    instance.sql.query(
      "SELECT max_length, max_length_locked FROM strings WHERE display_key = 'title'",
    )[0];
  assertEquals(limits(), { max_length: 5, max_length_locked: 1 });
  const qa = () => instance.sql.query("SELECT qa_errors FROM translations")[0].qa_errors;
  assertEquals(qa(), 1, "the translation now fails, and stays");
  const again = await uploadJson(
    instance.service,
    { "common.json": COMMON },
    {
      limits: [{ file: "common.json", key: "title", maxLength: 5 }],
    },
  );
  assertEquals(again.uploadId, null, "the same limit changes nothing");
  await uploadJson(instance.service, { "common.json": COMMON });
  assertEquals(limits(), { max_length: null, max_length_locked: 0 });
  assertEquals(qa(), 0);
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
  assertEquals(result.renamed, [{ file: "common.json", from: "menu.play", to: "menu.start" }]);
  assertEquals(result.renameSuggestions, []);
  const start = stringId(instance.sql, "common.json", "menu.start");
  assertEquals(instance.sql.query("SELECT string_id, value FROM translations"), [
    { string_id: start, value: '"Spielen"' },
  ]);
  assertEquals(count(instance.sql, "history", `string_id = ${play}`), 1, "the removal stays");
  const events = instance.sql
    .query<{ event: string }>("SELECT event FROM history WHERE string_id = ? ORDER BY id", start)
    .map((row) => row.event);
  assertEquals(events, ["source_added", "translation_llm", "source_added", "source_renamed"]);
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
    const error = await assertRejects(
      () => uploadJson(instance.service, { "common.json": withoutPlay }, { renames }),
      ServiceError,
    );
    assertEquals(error.code, "bad_request");
    assertEquals(error.message.includes(text), true, error.message);
  };
  await rejects([{ from: "nothing", to: "menu.play" }], "no key nothing");
  await rejects([{ from: "menu.play", to: "missing" }], "no key missing in common.json");
  await rejects([{ from: "menu.play", to: "menu.quit" }], "menu.quit already has translations");
  await rejects([{ from: "menu.play", to: "coins" }], "text string but coins is a plural");
  await rejects([{ file: "other.json", from: "menu.play", to: "title" }], "in other.json");
  assertEquals(count(instance.sql, "translations", "value = '\"Spielen\"'"), 1);
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
  const error = await assertRejects(
    () =>
      uploadJson(
        instance.service,
        { "a.json": { quit: "Quit", exit: "Exit" } },
        {
          renames: [{ from: "quit", to: "exit" }],
        },
      ),
    ServiceError,
  );
  assertEquals(error.code, "bad_request");
  assertStringIncludes(error.message, "Can't rename quit: the English still has it.");
  assertEquals(instance.sql.query("SELECT string_id, value FROM translations"), [
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
  assertEquals(typeof first.uploadId, "number");
  const before = snapshot(instance);
  const again = await uploadJson(
    instance.service,
    { "a.json": { start: "Play", quit: "Quit" } },
    request,
  );
  assertEquals(again.uploadId, null);
  assertEquals(again.renamed, []);
  assertEquals(again.renameSuggestions, []);
  assertEquals(snapshot(instance), before);
});

test("a rename needs the file when the key is in several files", async () => {
  using instance = await startTestService();
  await uploadJson(instance.service, { "a.json": { x: "X" }, "b.json": { x: "X" } });
  const renamed = { "a.json": { y: "X" }, "b.json": { y: "X" } };
  const error = await assertRejects(
    () => uploadJson(instance.service, renamed, { renames: [{ from: "x", to: "y" }] }),
    ServiceError,
  );
  assertEquals(error.message.includes("several files (a.json, b.json)"), true);
  const ok = await uploadJson(instance.service, renamed, {
    renames: [{ file: "a.json", from: "x", to: "y" }],
  });
  assertEquals(ok.renamed, [{ file: "a.json", from: "x", to: "y" }]);
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
  assertEquals(dry.renameSuggestions, [
    { file: "c.json", from: "coins#text", to: "money#text" },
    { file: "c.json", from: "coins#plural", to: "money#plural" },
  ]);
  const ambiguous = await assertRejects(
    () =>
      uploadJson(
        instance.service,
        { "c.json": money },
        {
          renames: [{ from: "coins", to: "money" }],
        },
      ),
    ServiceError,
  );
  assertStringIncludes(ambiguous.message, "several strings have the key coins in c.json");
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
  assertEquals(result.renamed, [{ file: "c.json", from: "coins#plural", to: "money#plural" }]);
  assertEquals(result.renameSuggestions, [
    {
      file: "c.json",
      from: "coins#text",
      to: "money#text",
    },
  ]);
  assertEquals(result.warnings.length, 2);
  assertStringIncludes(result.warnings[0], "The limit for c.json › money names 2 strings");
  assertStringIncludes(result.warnings[1], "The limit for c.json › a.b names 2 strings");
  assertEquals(
    instance.sql.query(
      "SELECT key, max_length FROM strings WHERE active = 1 AND max_length IS NOT NULL ORDER BY key",
    ),
    [
      { key: '["a","b"]', max_length: 4 },
      { key: '["money"]', max_length: 7 },
    ],
  );
  assertEquals(
    instance.sql.query("SELECT value FROM translations WHERE string_id = ?", plural).length,
    0,
    "the plural's translation moved",
  );
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
  assertEquals(dry.renameSuggestions, [{ file: "c.json", from: "coins#plural", to: "coinCount" }]);
  const result = await uploadJson(instance.service, renamed, {
    renames: [{ from: "coins", to: "coinCount" }],
  });
  assertEquals(result.renamed.length, 1);
  assertEquals(
    instance.sql.query(
      "SELECT s.display_key, s.kind FROM translations t JOIN strings s ON s.id = t.string_id",
    ),
    [{ display_key: "coinCount", kind: "plural" }],
  );
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
  assertEquals(result.renameSuggestions, [
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
  assertEquals(result.renameSuggestions.length, 600);
  assertEquals(result.renameSuggestions.slice(0, 2), [
    { file: "items.json", from: "items.0.name", to: "itemData.0.name" },
    { file: "items.json", from: "items.0.description", to: "itemData.0.description" },
  ]);
  assertEquals(result.renameSuggestions.at(-1), {
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
  assertEquals(first.warnings, [
    "The limits for store.json › title and store.json › title name the same string; the last one (50) applies",
  ]);
  const again = await uploadJson(
    instance.service,
    { "store.json": { title: "My game" } },
    {
      limits,
    },
  );
  assertEquals(again.uploadId, null);
  assertEquals(count(instance.sql, "uploads"), 1);
  assertEquals(instance.sql.query("SELECT max_length FROM strings"), [{ max_length: 50 }]);
});

test("limits above the largest are refused before anything is stored", async () => {
  using instance = await startTestService();
  for (const maxLength of [MAX_LENGTH_LIMIT + 1, 9007199254740993, 1e20]) {
    const error = await assertRejects(
      () =>
        uploadJson(
          instance.service,
          { "a.json": { title: "Hello" } },
          {
            limits: [{ file: "a.json", key: "title", maxLength }],
          },
        ),
      ServiceError,
    );
    assertEquals(error.code, "validation_failed");
    assertEquals(error.details?.[0].path, "limits[0].maxLength");
  }
  assertEquals(count(instance.sql, "strings"), 0);
});

test("a key that changes kind is a change", async () => {
  using instance = await project();
  const result = await uploadJson(instance.service, { "common.json": { ...COMMON, title: 7 } });
  assertEquals(result.changed, [{ file: "common.json", key: "title" }]);
  assertEquals(instance.sql.query("SELECT kind, source FROM strings WHERE display_key = 'title'"), [
    { kind: "literal", source: '"7"' },
  ]);
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
  assertEquals(instance.sql.query("SELECT display_key, kind FROM strings ORDER BY position"), [
    { display_key: "power_one", kind: "text" },
    { display_key: "power_other", kind: "text" },
  ]);
});

test("uploads by an API key record the key", async () => {
  using instance = await startTestService();
  const token = await createToken(instance.service, "upload", "CI");
  await uploadJson(instance.service, { "a.json": { a: "A" } }, {}, token.actor);
  assertEquals(instance.sql.query("SELECT actor_type, actor_id FROM uploads"), [
    { actor_type: "token", actor_id: token.id },
  ]);
  assertEquals(instance.sql.query("SELECT actor_label FROM activity"), [{ actor_label: "CI" }]);
});
