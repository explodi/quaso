// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(page.language).toBe("de");
  expect(page.total).toBe(9);
  expect(page.nextCursor).toBe(null);
  expect(page.strings.map((string) => `${string.file}:${string.key}`)).toStrictEqual([
    "common.json:title",
    "common.json:menu.play",
    "common.json:menu.quit",
    "common.json:menu.100%",
    "common.json:coins",
    "common.json:playAgain",
    "hud.json:hp",
    "hud.json:mana",
    "menus/main.json:main.start",
  ]);
  const [title, play, quit] = page.strings;
  expect(title.translation?.value).toBe("Wegfahrer");
  expect(title.translation?.colour).toBe("green");
  expect(title.translation?.author).toStrictEqual({ type: "llm", id: null, name: "test-model" });
  expect(play.translation?.colour).toBe("blue");
  expect(quit.translation).toBe(null);
  expect(page.strings[4].kind).toBe("plural");
  expect(page.strings[4].source).toStrictEqual({ one: "{{count}} coin", other: "{{count}} coins" });
  expect([
    title.words,
    title.maxLength,
    title.maxLengthLocked,
    title.pending,
    title.llmFailure,
  ]).toStrictEqual([1, null, false, 0, null]);
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
  expect(await keys(instance, { state: "green" })).toStrictEqual([
    "common.json:title",
    "hud.json:hp",
    "hud.json:mana",
  ]);
  expect(await keys(instance, { state: "blue" })).toStrictEqual(["common.json:menu.play"]);
  expect(await keys(instance, { state: "outdated" })).toStrictEqual(["common.json:title"]);
  expect(await keys(instance, { state: "pending" })).toStrictEqual(["common.json:menu.quit"]);
  expect(await keys(instance, { state: "qa" })).toStrictEqual(["hud.json:mana"]);
  expect((await keys(instance, { state: "untranslated" })).length).toBe(5);
  const quit = await instance.service.listStrings(ANONYMOUS, { language: "de", state: "pending" });
  expect(quit.strings[0].pending).toBe(1);
  expect(quit.total).toBe(1);
});

test("listStrings searches keys, English and translations", async () => {
  using instance = await project();
  expect(await keys(instance, { q: "LEBENS" })).toStrictEqual(["hud.json:hp"]);
  expect(await keys(instance, { q: "health" })).toStrictEqual(["hud.json:hp"]);
  expect(await keys(instance, { q: "menu.q" })).toStrictEqual(["common.json:menu.quit"]);
  expect(await keys(instance, { q: "100%" })).toStrictEqual(["common.json:menu.100%"]);
  expect(await keys(instance, { q: "r_u" })).toStrictEqual(["common.json:menu.100%"]);
  expect(await keys(instance, { q: "%" })).toStrictEqual(["common.json:menu.100%"]);
  expect(await keys(instance, { q: "ｐｌａｙ" }), "NFKC: full-width letters").toStrictEqual([
    "common.json:menu.play",
    "common.json:playAgain",
  ]);
  expect(await keys(instance, { q: "nothing like it" })).toStrictEqual([]);
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
  expect(q.length).toBe(200);
  expect(await keys(instance, { q })).toStrictEqual(["story.json:intro"]);
  expect(await keys(instance, { q: `${q.slice(0, 199)}!` })).toStrictEqual([]);
  expect(await keys(instance, { q: "c:\\games\\wayfarer\\save_1" })).toStrictEqual([
    "story.json:save",
  ]);
  expect(await keys(instance, { q: "\\s" })).toStrictEqual(["story.json:save"]);
  expect(await keys(instance, { q: "\\_" })).toStrictEqual([]);
});

test("listStrings filters by file, folder and IDs", async () => {
  using instance = await project();
  expect(await keys(instance, { file: "hud.json" })).toStrictEqual([
    "hud.json:hp",
    "hud.json:mana",
  ]);
  expect(await keys(instance, { file: "menus/" })).toStrictEqual(["menus/main.json:main.start"]);
  expect(await keys(instance, { file: "menus" })).toStrictEqual([]);
  const ids = [
    stringId(instance.sql, "hud.json", "mana"),
    stringId(instance.sql, "common.json", "title"),
  ];
  expect(await keys(instance, { ids })).toStrictEqual(["common.json:title", "hud.json:mana"]);
  expect(await keys(instance, { ids, file: "hud.json", state: "qa" })).toStrictEqual([
    "hud.json:mana",
  ]);
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
  expect(await folder("UI/")).toStrictEqual([1, ["UI/menu.json:play"]]);
  expect(await folder("ui/")).toStrictEqual([1, ["ui/hud.json:hp"]]);
  expect(await folder("straße/")).toStrictEqual([0, []]);
  expect(await folder("Straße/")).toStrictEqual([1, ["Straße/a.json:a"]]);
  expect(await folder("ui%/")).toStrictEqual([0, []]);
});

test("IDs beyond the exact integers are refused, not a server error", async () => {
  using instance = await project();
  for (const call of [
    () => instance.service.listStrings(ANONYMOUS, { language: "de", ids: [1e20] }),
    () => instance.service.listStrings(ANONYMOUS, { language: "de", ids: [2 ** 53] }),
    () => instance.service.getString(ANONYMOUS, { id: 99999999999999999999, language: "de" }),
    () => instance.service.getHistory(ANONYMOUS, { id: 2 ** 60 }),
  ]) {
    const error = await call().catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("validation_failed");
  }
  const error = await instance.service
    .listStrings(ANONYMOUS, { language: "de", ids: [1, 1e20] })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.details).toStrictEqual([
    { path: "ids[1]", message: "must be at most 9007199254740991" },
  ]);
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
    expect(page.total).toBe(9);
    seen.push(...page.strings.map((string) => string.key));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor !== undefined);
  expect(pages).toBe(3);
  expect(seen.length).toBe(9);
  expect(new Set(seen).size).toBe(9);
  const error = await instance.service
    .listStrings(ANONYMOUS, { language: "de", cursor: "nope" })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("bad_request");
});

test("hidden strings and files aren't listed", async () => {
  using instance = await project();
  await uploadJson(instance.service, { "hud.json": { hp: "Health points" } });
  expect(await keys(instance, {})).toStrictEqual(["hud.json:hp"]);
});

test("getString gives the translation, other languages, references and checks", async () => {
  using instance = await project();
  write(instance, "common.json", "title", "fr", "Voyageur", BLUE);
  const id = stringId(instance.sql, "common.json", "title");
  const detail = await instance.service.getString(ANONYMOUS, { id, language: "de" });
  expect([detail.language, detail.key, detail.translation?.value]).toStrictEqual([
    "de",
    "title",
    "Wegfahrer",
  ]);
  expect(
    detail.otherLanguages.map((other) => [other.language, other.name, other.translation?.value]),
  ).toStrictEqual([["fr", "French", "Voyageur"]]);
  expect(detail.suggestions).toStrictEqual([]);
  expect(detail.references).toStrictEqual([]);
  expect(detail.checks).toStrictEqual([]);
  const again = await instance.service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "common.json", "playAgain"),
    language: "de",
  });
  expect(again.references).toStrictEqual([
    { raw: "$t(menu.play)", english: "Play" },
    { raw: "$t(hud:hp)", english: "Health points" },
    { raw: "$t(nowhere)", english: null },
  ]);
  const mana = await instance.service.getString(ANONYMOUS, {
    id: stringId(instance.sql, "hud.json", "mana"),
    language: "de",
  });
  expect(mana.checks.map((check) => check.check)).toStrictEqual(["empty"]);
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
  expect(
    detail.suggestions.map((suggestion) => [suggestion.status, suggestion.value]),
  ).toStrictEqual([
    ["rejected", "Wanderer"],
    ["pending", "Reisender"],
  ]);
  const pending = detail.suggestions[1];
  expect(pending.author.name).toBe("Volunteer");
  expect(pending.source).toBe("Wayfarer");
  expect(pending.current?.value).toBe("Wegfahrer");
  expect(pending.checks).toStrictEqual([]);
  expect(detail.pending).toBe(1);
});

test("getString of a hidden, literal or unknown string is not found", async () => {
  using instance = await project();
  const version = instance.sql.query<{ id: number }>(
    "SELECT id FROM strings WHERE display_key = 'version'",
  )[0].id;
  for (const id of [version, 999]) {
    const error = await instance.service
      .getString(ANONYMOUS, { id, language: "de" })
      .catch((error: unknown) => error);
    assert(error instanceof ServiceError);
    expect(error.code).toBe("not_found");
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
  expect(de.entries.map((entry) => [entry.event, entry.language])).toStrictEqual([
    ["source_changed", null],
    ["translation_llm", "de"],
    ["source_added", null],
  ]);
  expect(de.entries[0].before).toBe("Wayfarer");
  expect(de.entries[0].after).toBe("Wayfarer II");
  expect(de.entries[0].actor).toStrictEqual({ type: "system", id: null, name: "System" });
  expect(typeof de.entries[0].detail?.upload).toBe("number");
  expect(de.entries[1].afterColour).toBe("green");
  const all = await instance.service.getHistory(ANONYMOUS, { id });
  expect(all.entries.length).toBe(4);
  const error = await instance.service
    .getHistory(ANONYMOUS, { id: 999 })
    .catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("not_found");
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
  expect(first.items.length).toBe(3);
  expect(first.items[0].type).toBe("upload");
  expect(first.items[0].actor).toStrictEqual({ type: "token", id: token.id, name: "CI" });
  expect(first.items[0].summary).toBe("Upload: 1 changed");
  expect(first.items[0].detail.changed).toBe(1);
  const second = await instance.service.getActivity(ANONYMOUS, {
    limit: 3,
    cursor: first.nextCursor!,
  });
  expect(second.items.map((item) => item.actor.name)).toStrictEqual(["System"]);
  expect(second.nextCursor).toBe(null);
  expect(Number(second.items[0].id) < Number(first.items[2].id)).toBe(true);
});

test("reads are public, and work the same for every actor", async () => {
  using instance = await project();
  const anonymous = await instance.service.listStrings(ANONYMOUS, { language: "de" });
  const system = await instance.service.listStrings(SYSTEM, { language: "de" });
  expect(anonymous).toStrictEqual(system);
});
