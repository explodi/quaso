// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { ANONYMOUS, SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import {
  addUser,
  createToken,
  startTestService,
  stringId,
  type TestInstance,
  uploadJson,
  write,
} from "./test_helpers.ts";

const COMMON = {
  title: "Wayfarer",
  menu: { play: "Play", quit: "Quit", "100%": "Full 100% power_up" },
  coins_one: "{{count}} coin",
  coins_other: "{{count}} coins",
  playAgain: "$t(menu.play) again, $t(hud:hp) and $t(nowhere)",
  back: "$t(menu.quit)",
  version: 3,
};
const HUD = { hp: "Health points", mana: "Mana" };
const MENUS = { main: { start: "Start" } };

const BLUE = {
  colour: "blue" as const,
  actor: { type: "user" as const, id: 1, label: null },
  event: "translation_saved" as const,
};

async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await uploadJson(
    instance.service,
    {
      "common.json": COMMON,
      "hud.json": HUD,
      "menus/main.json": MENUS,
    },
    { languages: ["de", "fr"] },
  );
  write(instance, "common.json", "title", "de", "Wegfahrer");
  write(instance, "common.json", "menu.play", "de", "Spielen", BLUE);
  write(instance, "hud.json", "hp", "de", "Lebenspunkte");
  write(instance, "hud.json", "mana", "de", "", { allowQaErrors: true });
  return instance;
}

async function keys(instance: TestInstance, query: Record<string, unknown>): Promise<string[]> {
  const page = await instance.service.listStrings(ANONYMOUS, { language: "de", ...query });
  return page.strings.map((string) => `${string.file}:${string.key}`);
}

test("listStrings lists translatable strings by file and position", async () => {
  using instance = await project();
  const page = await instance.service.listStrings(ANONYMOUS, { language: "de" });
  assertEquals(page.language, "de");
  assertEquals(page.total, 9);
  assertEquals(page.nextCursor, null);
  assertEquals(
    page.strings.map((string) => `${string.file}:${string.key}`),
    [
      "common.json:title",
      "common.json:menu.play",
      "common.json:menu.quit",
      "common.json:menu.100%",
      "common.json:coins",
      "common.json:playAgain",
      "hud.json:hp",
      "hud.json:mana",
      "menus/main.json:main.start",
    ],
  );
  const [title, play, quit] = page.strings;
  assertEquals(title.translation?.value, "Wegfahrer");
  assertEquals(title.translation?.colour, "green");
  assertEquals(title.translation?.author, { type: "llm", id: null, name: "test-model" });
  assertEquals(play.translation?.colour, "blue");
  assertEquals(quit.translation, null);
  assertEquals(page.strings[4].kind, "plural");
  assertEquals(page.strings[4].source, { one: "{{count}} coin", other: "{{count}} coins" });
  assertEquals(
    [title.words, title.maxLength, title.maxLengthLocked, title.pending, title.llmFailure],
    [1, null, false, 0, null],
  );
});

test("listStrings filters by state", async () => {
  using instance = await project();
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarer II" },
    "hud.json": HUD,
    "menus/main.json": MENUS,
  });
  instance.sql.run(
    `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
       author_type, created_at) VALUES (?, 'de', 'translation', '"Beenden"', 'x', 0, 'user', 0)`,
    stringId(instance.sql, "common.json", "menu.quit"),
  );
  assertEquals(await keys(instance, { state: "green" }), [
    "common.json:title",
    "hud.json:hp",
    "hud.json:mana",
  ]);
  assertEquals(await keys(instance, { state: "blue" }), ["common.json:menu.play"]);
  assertEquals(await keys(instance, { state: "outdated" }), ["common.json:title"]);
  assertEquals(await keys(instance, { state: "pending" }), ["common.json:menu.quit"]);
  assertEquals(await keys(instance, { state: "qa" }), ["hud.json:mana"]);
  assertEquals((await keys(instance, { state: "untranslated" })).length, 5);
  const quit = await instance.service.listStrings(ANONYMOUS, { language: "de", state: "pending" });
  assertEquals(quit.strings[0].pending, 1);
  assertEquals(quit.total, 1);
});

test("listStrings searches keys, English and translations", async () => {
  using instance = await project();
  assertEquals(await keys(instance, { q: "LEBENS" }), ["hud.json:hp"]);
  assertEquals(await keys(instance, { q: "health" }), ["hud.json:hp"]);
  assertEquals(await keys(instance, { q: "menu.q" }), ["common.json:menu.quit"]);
  assertEquals(await keys(instance, { q: "100%" }), ["common.json:menu.100%"]);
  assertEquals(await keys(instance, { q: "r_u" }), ["common.json:menu.100%"]);
  assertEquals(await keys(instance, { q: "%" }), ["common.json:menu.100%"]);
  assertEquals(
    await keys(instance, { q: "ｐｌａｙ" }),
    ["common.json:menu.play", "common.json:playAgain"],
    "NFKC: full-width letters",
  );
  assertEquals(await keys(instance, { q: "nothing like it" }), []);
});

test("listStrings searches with long, non-ASCII queries, and backslashes as themselves", async () => {
  // Durable Objects refuse LIKE patterns over 50 bytes; search must work up to the API's
  // 200 characters on both storages (the same case runs in workerd).
  using instance = await startTestService();
  const story = "你好，旅行者。".repeat(40);
  await uploadJson(
    instance.service,
    {
      "story.json": { intro: story, save: "C:\\Games\\Wayfarer\\save_1" },
    },
    { languages: ["de"] },
  );
  const q = story.slice(3, 203);
  assertEquals(q.length, 200);
  assertEquals(await keys(instance, { q }), ["story.json:intro"]);
  assertEquals(await keys(instance, { q: `${q.slice(0, 199)}!` }), []);
  assertEquals(await keys(instance, { q: "c:\\games\\wayfarer\\save_1" }), ["story.json:save"]);
  assertEquals(await keys(instance, { q: "\\s" }), ["story.json:save"]);
  assertEquals(await keys(instance, { q: "\\_" }), []);
});

test("listStrings filters by file, folder and IDs", async () => {
  using instance = await project();
  assertEquals(await keys(instance, { file: "hud.json" }), ["hud.json:hp", "hud.json:mana"]);
  assertEquals(await keys(instance, { file: "menus/" }), ["menus/main.json:main.start"]);
  assertEquals(await keys(instance, { file: "menus" }), []);
  const ids = [
    stringId(instance.sql, "hud.json", "mana"),
    stringId(instance.sql, "common.json", "title"),
  ];
  assertEquals(await keys(instance, { ids }), ["common.json:title", "hud.json:mana"]);
  assertEquals(await keys(instance, { ids, file: "hud.json", state: "qa" }), ["hud.json:mana"]);
});

test("the folder filter matches the folder's case exactly", async () => {
  using instance = await startTestService();
  await uploadJson(
    instance.service,
    {
      "UI/menu.json": { play: "Play" },
      "ui/hud.json": { hp: "HP" },
      "Straße/a.json": { a: "A" },
      "ui_x/b.json": { b: "B" },
    },
    { languages: ["de"] },
  );
  const folder = async (file: string) => {
    const page = await instance.service.listStrings(ANONYMOUS, { language: "de", file });
    return [page.total, page.strings.map((string) => `${string.file}:${string.key}`)];
  };
  assertEquals(await folder("UI/"), [1, ["UI/menu.json:play"]]);
  assertEquals(await folder("ui/"), [1, ["ui/hud.json:hp"]]);
  assertEquals(await folder("straße/"), [0, []]);
  assertEquals(await folder("Straße/"), [1, ["Straße/a.json:a"]]);
  assertEquals(await folder("ui%/"), [0, []]);
});

test("IDs beyond the exact integers are refused, not a server error", async () => {
  using instance = await project();
  for (const call of [
    () => instance.service.listStrings(ANONYMOUS, { language: "de", ids: [1e20] }),
    () => instance.service.listStrings(ANONYMOUS, { language: "de", ids: [2 ** 53] }),
    () => instance.service.getString(ANONYMOUS, { id: 99999999999999999999, language: "de" }),
    () => instance.service.getHistory(ANONYMOUS, { id: 2 ** 60 }),
  ]) {
    const error = await assertRejects(call, ServiceError);
    assertEquals(error.code, "validation_failed");
  }
  const error = await assertRejects(
    () => instance.service.listStrings(ANONYMOUS, { language: "de", ids: [1, 1e20] }),
    ServiceError,
  );
  assertEquals(error.details, [{ path: "ids[1]", message: "must be at most 9007199254740991" }]);
});

test("listStrings pages with an opaque cursor", async () => {
  using instance = await project();
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await instance.service.listStrings(ANONYMOUS, {
      language: "de",
      limit: 4,
      cursor,
    });
    assertEquals(page.total, 9);
    seen.push(...page.strings.map((string) => string.key));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor !== undefined);
  assertEquals(pages, 3);
  assertEquals(seen.length, 9);
  assertEquals(new Set(seen).size, 9);
  const error = await assertRejects(
    () => instance.service.listStrings(ANONYMOUS, { language: "de", cursor: "nope" }),
    ServiceError,
  );
  assertEquals(error.code, "bad_request");
});

test("hidden strings and files aren't listed", async () => {
  using instance = await project();
  await uploadJson(instance.service, { "hud.json": { hp: "Health points" } });
  assertEquals(await keys(instance, {}), ["hud.json:hp"]);
});

test("getString gives the translation, other languages, references and checks", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "fr", "Voyageur", BLUE);
  const id = stringId(instance.sql, "common.json", "title");
  const detail = await instance.service.getString(ANONYMOUS, { id, language: "de" });
  assertEquals(
    [detail.language, detail.key, detail.translation?.value],
    ["de", "title", "Wegfahrer"],
  );
  assertEquals(
    detail.otherLanguages.map((other) => [other.language, other.name, other.translation?.value]),
    [["fr", "French", "Voyageur"]],
  );
  assertEquals(detail.suggestions, []);
  assertEquals(detail.references, []);
  assertEquals(detail.checks, []);
  const again = await instance.service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "playAgain"),
    language: "de",
  });
  assertEquals(again.references, [
    { raw: "$t(menu.play)", english: "Play" },
    { raw: "$t(hud:hp)", english: "Health points" },
    { raw: "$t(nowhere)", english: null },
  ]);
  const mana = await instance.service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "hud.json", "mana"),
    language: "de",
  });
  assertEquals(
    mana.checks.map((check) => check.check),
    ["empty"],
  );
});

test("getString lists pending and recently reviewed suggestions", async () => {
  using instance = await project();
  const id = stringId(instance.sql, "common.json", "title");
  const now = instance.clock.now;
  const volunteer = addUser(instance.sql, "contributor", null, "Volunteer");
  const insert = (status: string, reviewedAt: number | null, value: string) =>
    instance.sql.run(
      `INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision,
         status, author_type, author_id, created_at, reviewed_at)
       VALUES (?, 'de', 'correction', ?, 'x', 2, ?, 'user', ?, ?, ?)`,
      id,
      value,
      status,
      volunteer.type === "user" ? volunteer.userId : null,
      now,
      reviewedAt,
    );
  insert("pending", null, '"Reisender"');
  insert("rejected", now - 1000, '"Wanderer"');
  insert("rejected", now - 40 * 24 * 3600 * 1000, '"Alt"');
  const detail = await instance.service.getString(ANONYMOUS, { id, language: "de" });
  assertEquals(
    detail.suggestions.map((suggestion) => [suggestion.status, suggestion.value]),
    [
      ["rejected", "Wanderer"],
      ["pending", "Reisender"],
    ],
  );
  const pending = detail.suggestions[1];
  assertEquals(pending.author.name, "Volunteer");
  assertEquals(pending.source, "Wayfarer");
  assertEquals(pending.current?.value, "Wegfahrer");
  assertEquals(pending.checks, []);
  assertEquals(detail.pending, 1);
});

test("getString of a hidden, literal or unknown string is not found", async () => {
  using instance = await project();
  const version = instance.sql.query<{ id: number }>(
    "SELECT id FROM strings WHERE display_key = 'version'",
  )[0].id;
  for (const id of [version, 999]) {
    const error = await assertRejects(
      () => instance.service.getString(ANONYMOUS, { id, language: "de" }),
      ServiceError,
    );
    assertEquals(error.code, "not_found");
  }
});

test("getHistory: newest first, one language's events and the English's", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "fr", "Voyageur");
  await uploadJson(instance.service, {
    "common.json": { ...COMMON, title: "Wayfarer II" },
    "hud.json": HUD,
    "menus/main.json": MENUS,
  });
  const id = stringId(instance.sql, "common.json", "title");
  const de = await instance.service.getHistory(ANONYMOUS, { id, language: "de" });
  assertEquals(
    de.entries.map((entry) => [entry.event, entry.language]),
    [
      ["source_changed", null],
      ["translation_llm", "de"],
      ["source_added", null],
    ],
  );
  assertEquals(de.entries[0].before, "Wayfarer");
  assertEquals(de.entries[0].after, "Wayfarer II");
  assertEquals(de.entries[0].actor, { type: "system", id: null, name: "System" });
  assertEquals(typeof de.entries[0].detail?.upload, "number");
  assertEquals(de.entries[1].afterColour, "green");
  const all = await instance.service.getHistory(ANONYMOUS, { id });
  assertEquals(all.entries.length, 4);
  const error = await assertRejects(
    () => instance.service.getHistory(ANONYMOUS, { id: 999 }),
    ServiceError,
  );
  assertEquals(error.code, "not_found");
});

test("getActivity: newest first, paged by the last ID", async () => {
  using instance = await project();
  const token = await createToken(instance.service, "upload", "CI");
  for (const title of ["One", "Two", "Three"]) {
    await uploadJson(
      instance.service,
      {
        "common.json": { ...COMMON, title },
        "hud.json": HUD,
        "menus/main.json": MENUS,
      },
      {},
      token.actor,
    );
  }
  const first = await instance.service.getActivity(ANONYMOUS, { limit: 3 });
  assertEquals(first.items.length, 3);
  assertEquals(first.items[0].type, "upload");
  assertEquals(first.items[0].actor, { type: "token", id: token.id, name: "CI" });
  assertEquals(first.items[0].summary, "Upload: 1 changed");
  assertEquals(first.items[0].detail.changed, 1);
  const second = await instance.service.getActivity(ANONYMOUS, {
    limit: 3,
    cursor: first.nextCursor!,
  });
  assertEquals(
    second.items.map((item) => item.actor.name),
    ["System"],
  );
  assertEquals(second.nextCursor, null);
  assertEquals(Number(second.items[0].id) < Number(first.items[2].id), true);
});

test("reads are public, and work the same for every actor", async () => {
  using instance = await project();
  const anonymous = await instance.service.listStrings(ANONYMOUS, { language: "de" });
  const system = await instance.service.listStrings(SYSTEM, { language: "de" });
  assertEquals(anonymous, system);
});
