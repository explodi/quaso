// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { assert, expect, test } from "vitest";
import {
  entryValue,
  isReferenceOnly,
  JsonSyntaxError,
  type LiteralEntry,
  parsePluralKey,
  type PluralEntry,
  pluralKeyName,
  readSource,
  readTranslation,
  type ReadTranslationResult,
  type SourceEntry,
  SourceError,
} from "./entries.ts";
import { entryKey, type KeyPath, PLURAL_CATEGORIES, type TextValue } from "./types.ts";
const enAppendix = await fs.readFile(
  new URL("../testdata/i18next/en/appendix.json", import.meta.url),
  "utf8",
);
const enCommon = await fs.readFile(
  new URL("../testdata/i18next/en/common.json", import.meta.url),
  "utf8",
);
const enMenus = await fs.readFile(
  new URL("../testdata/i18next/en/menus.json.txt", import.meta.url),
  "utf8",
);
const jaAppendix = await fs.readFile(
  new URL("../testdata/i18next/ja/appendix.json", import.meta.url),
  "utf8",
);
const importedPlCommon = await fs.readFile(
  new URL("../testdata/i18next/import/pl/common.json.txt", import.meta.url),
  "utf8",
);

// Helpers

const APPENDIX_OPTIONS = { file: "en/appendix.json", pluralExclusions: ["menu.player"] };

/** Reads English text given as lines joined with `\n`. */
function read(lines: string[] | string, options = {}): SourceEntry[] {
  return readSource(typeof lines === "string" ? lines : lines.join("\n"), options).entries;
}

/** Entries without their line numbers, for comparisons. */
function withoutLines(entries: readonly SourceEntry[]): SourceEntry[] {
  return entries.map(({ line: _line, ...entry }) => entry as SourceEntry);
}

/** A one-line summary of each entry: its kind and key path. */
function summary(entries: readonly SourceEntry[]): string[] {
  return entries.map((entry) => `${entry.kind} ${JSON.stringify(entry.keyPath)}`);
}

/** The entry with a kind and key path. */
function find(entries: readonly SourceEntry[], kind: string, keyPath: KeyPath): SourceEntry {
  const key = JSON.stringify(keyPath);
  const entry = entries.find((e) => e.kind === kind && JSON.stringify(e.keyPath) === key);
  assert(entry, `no ${kind} entry at ${key}`);
  return entry;
}

/** The raw text of the literal at a key path. */
function literal(entries: readonly SourceEntry[], keyPath: KeyPath): string {
  return (find(entries, "literal", keyPath) as LiteralEntry).raw;
}

/** The 1-based line of the first occurrence of `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  assert(index >= 0, `${needle} not found`);
  return text.slice(0, index).split("\n").length;
}

/** Reads a translation of `english` (lines joined with `\n`). */
function readPl(lines: string[] | string, english: SourceEntry[]): ReadTranslationResult {
  const text = typeof lines === "string" ? lines : lines.join("\n");
  return readTranslation(text, english, { language: "pl", file: "pl/test.json" });
}

// readSource: the entry table (design §5.2)

test("readSource turns the appendix into entries, in file order", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  expect(summary(entries)).toStrictEqual([
    'text ["title"]',
    'literal ["subtitle"]',
    'literal ["spacer"]',
    'text ["intro"]',
    'text ["play"]',
    'text ["playAgain"]',
    'reference ["back"]',
    'reference ["backOrQuit"]',
    'reference ["coinsLabel"]',
    'text ["collected"]',
    'text ["inventory","coins"]',
    'plural ["inventory","coins"]',
    'plural ["inventory","gems"]',
    'text ["inventory","leftovers_other"]',
    'plural ["messages"]',
    'plural ["lap"]',
    'ordinal ["lap"]',
    'ordinal ["place"]',
    'text ["greeting_male"]',
    'text ["greeting_female"]',
    'plural ["ally_male"]',
    'plural ["ally_female"]',
    'text ["hints",0]',
    'text ["hints",1]',
    'reference ["hints",2]',
    'text ["tutorial",0,"title"]',
    'text ["tutorial",0,"body"]',
    'text ["tutorial",1,"title"]',
    'text ["tutorial",1,"body"]',
    'plural ["tutorial",1,"offers"]',
    'literal ["tutorial",2]',
    'text ["biomes",0,0]',
    'text ["biomes",0,1]',
    'text ["biomes",1,0]',
    'text ["biomes",1,1,0]',
    'text ["biomes",1,1,1]',
    'literal ["biomes",2]',
    'literal ["stats","version"]',
    'literal ["stats","ratio"]',
    'literal ["stats","scale"]',
    'literal ["stats","drift"]',
    'literal ["stats","limit"]',
    'literal ["stats","zero"]',
    'literal ["stats","thresholds",0]',
    'literal ["stats","thresholds",1]',
    'literal ["stats","thresholds",2]',
    'literal ["stats","beta"]',
    'literal ["stats","hardcore"]',
    'literal ["stats","legacy"]',
    'literal ["extras"]',
    'literal ["tags"]',
    'text ["file.save"]',
    'text ["v1.2","changelog"]',
    'text ["chapters","10"]',
    'text ["chapters","2"]',
    'text ["chapters","1"]',
    'text ["chapters","1.5"]',
    'text ["menu","player_one"]',
    'text ["menu","player_two"]',
    'text ["menu","player_other"]',
    'text ["menu","resume"]',
    'text ["unicode","emoji"]',
    'text ["unicode","family"]',
    'text ["unicode","flags"]',
    'text ["unicode","combining"]',
    'text ["unicode","surrogates"]',
    'text ["unicode","cjk"]',
    'text ["unicode","rtl"]',
    'text ["unicode","nbsp"]',
    'text ["unicode","zeroWidth"]',
    'text ["unicode","quotes"]',
    'text ["unicode","escapes"]',
    'text ["日本語"]',
    'text ["emoji_🎉"]',
    'text ["ключ"]',
  ]);
  const keys = entries.map((entry) => entryKey(entry.kind, entry.keyPath));
  expect(new Set(keys).size).toStrictEqual(keys.length);
});

test("readSource reads plural and ordinal groups with their English forms", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const forms = (kind: string, keyPath: KeyPath) =>
    (find(entries, kind, keyPath) as PluralEntry).forms;
  expect(forms("plural", ["inventory", "coins"])).toStrictEqual({
    one: "{{count}} coin",
    other: "{{count}} coins",
  });
  expect(forms("plural", ["messages"])).toStrictEqual({
    zero: "No new messages",
    one: "One new message",
    other: "{{count}} new messages",
  });
  expect(forms("ordinal", ["place"])).toStrictEqual({
    one: "You finished {{count}}st",
    two: "You finished {{count}}nd",
    few: "You finished {{count}}rd",
    other: "You finished {{count}}th",
  });
  expect(forms("plural", ["lap"])).toStrictEqual({ one: "{{count}} lap", other: "{{count}} laps" });
  expect(Object.keys(forms("ordinal", ["lap"]))).toStrictEqual(["one", "two", "few", "other"]);
  expect(forms("plural", ["ally_female"])).toStrictEqual({
    one: "She travels with {{count}} ally.",
    other: "She travels with {{count}} allies.",
  });
  expect(forms("plural", ["tutorial", 1, "offers"])).toStrictEqual({
    one: "{{count}} offer",
    other: "{{count}} offers",
  });
});

test("readSource keeps text, references and literals as written", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const value = (kind: string, keyPath: KeyPath) =>
    (find(entries, kind, keyPath) as { value: string }).value;
  expect(value("text", ["playAgain"])).toBe("$t(play) again");
  expect(value("reference", ["backOrQuit"])).toBe("$t(common:back) $t(common:quit)");
  expect(value("reference", ["coinsLabel"])).toStrictEqual(
    '$t(inventory.coins, {"count": {{total}}})',
  );
  expect(value("text", ["inventory", "coins"])).toBe("Coins");
  expect(value("text", ["inventory", "leftovers_other"])).toBe("Leftovers");
  expect(value("text", ["greeting_female"])).toBe("Welcome back, madam.");
  expect(value("text", ["hints", 1])).toBe("Press {{key}} to open the map.");
  expect(value("reference", ["hints", 2])).toBe("$t(common:tip)");
  expect(value("text", ["biomes", 1, 1, 0])).toBe("Dunes");
  expect(value("text", ["file.save"])).toBe("Save file");
  expect(value("text", ["v1.2", "changelog"])).toStrictEqual(
    "Fixed the ferry to the north island.",
  );
  expect(literal(entries, ["subtitle"])).toBe('""');
  expect(literal(entries, ["spacer"])).toBe('" "');
  expect(literal(entries, ["tutorial", 2])).toBe("{}");
  expect(literal(entries, ["biomes", 2])).toBe("[]");
  expect(literal(entries, ["stats", "version"])).toBe("3");
  expect(literal(entries, ["stats", "ratio"])).toBe("1.50");
  expect(literal(entries, ["stats", "scale"])).toBe("1e3");
  expect(literal(entries, ["stats", "drift"])).toBe("-0.25");
  expect(literal(entries, ["stats", "limit"])).toBe("2E+5");
  expect(literal(entries, ["stats", "zero"])).toBe("0");
  expect(literal(entries, ["stats", "thresholds", 1])).toBe("2.50");
  expect(literal(entries, ["stats", "beta"])).toBe("true");
  expect(literal(entries, ["stats", "hardcore"])).toBe("false");
  expect(literal(entries, ["stats", "legacy"])).toBe("null");
  expect(literal(entries, ["extras"])).toBe("{}");
  expect(literal(entries, ["tags"])).toBe("[]");
});

test("readSource keeps Unicode text and keys exactly", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const value = (key: string) =>
    (find(entries, "text", ["unicode", key]) as { value: string }).value;
  expect(value("emoji")).toBe("Treasure found \u{1f389}\u{1f48e}");
  expect(value("family")).toBe("\u{1f469}\u200d\u{1f469}\u200d\u{1f467} Family mode");
  expect(value("flags")).toBe("Made in \u{1f1fa}\u{1f1e6} and \u{1f1f5}\u{1f1f9}");
  expect(value("combining")).toBe("Cafe\u0301 for Ame\u0301lie, man\u0303ana");
  expect(value("surrogates")).toBe("\ud835\udcb3 marks the spot \ud834\udd1e");
  expect(value("cjk")).toBe("\u65c5\u306e\u8a18\u9332");
  expect(value("nbsp")).toBe("10\u00a0km to go");
  expect(value("zeroWidth")).toBe("no\u200bbreak");
  expect(value("quotes")).toBe('She said "run" and left \\o/');
  expect(value("escapes")).toBe("Line one\nLine two\tTabbed \u0001");
  find(entries, "text", ["\u65e5\u672c\u8a9e"]);
  find(entries, "text", ["emoji_\u{1f389}"]);
  find(entries, "text", ["\u043a\u043b\u044e\u0447"]);
});

test("readSource keeps integer-like keys in file order", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const chapters = entries.filter((entry) => entry.keyPath[0] === "chapters");
  expect(chapters.map((entry) => entry.keyPath[1])).toStrictEqual(["10", "2", "1", "1.5"]);
  expect(read(['{"b": "x", "10": "y", "2": "z"}']).map((e) => e.keyPath[0])).toStrictEqual([
    "b",
    "10",
    "2",
  ]);
});

test("readSource gives each entry the line of its key", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const line = (kind: string, keyPath: KeyPath) => find(entries, kind, keyPath).line;
  expect(line("text", ["title"])).toBe(2);
  expect(line("plural", ["inventory", "coins"])).toStrictEqual(lineOf(enAppendix, '"coins_one"'));
  expect(line("plural", ["messages"])).toStrictEqual(lineOf(enAppendix, '"messages_zero"'));
  expect(line("ordinal", ["lap"])).toStrictEqual(lineOf(enAppendix, '"lap_ordinal_one"'));
  expect(line("text", ["hints", 0])).toStrictEqual(lineOf(enAppendix, '"Hold Shift'));
  expect(line("literal", ["tutorial", 2])).toStrictEqual(lineOf(enAppendix, "    {}"));
  expect(line("text", ["biomes", 1, 1, 1])).toStrictEqual(lineOf(enAppendix, '"Oasis"'));
  expect(line("literal", ["stats", "legacy"])).toStrictEqual(lineOf(enAppendix, '"legacy"'));
  expect(line("text", ["\u043a\u043b\u044e\u0447"])).toStrictEqual(lineOf(enAppendix, '"\u043a'));
});

test("readSource reads CRLF files with 4-space indentation", () => {
  const { format, entries } = readSource(enMenus, { file: "en/menus.json" });
  expect(format).toStrictEqual({ indent: "    ", newline: "\r\n", finalNewline: true });
  const lf = enMenus.replaceAll("\r\n", "\n");
  const rank = find(entries, "ordinal", ["results", "rank"]) as PluralEntry;
  expect(rank.line).toStrictEqual(lineOf(lf, '"rank_ordinal_one"'));
  expect(rank.forms.two).toBe("Ranked {{count}}nd on today\u2019s board");
  expect(find(entries, "text", ["options", "difficulty", "levels", 3]).line).toStrictEqual(
    lineOf(lf, "Inferno"),
  );
  expect(literal(entries, ["options", "difficulty", "default"])).toBe("1");
  expect(find(entries, "reference", ["pause", "restart"]).line).toStrictEqual(
    lineOf(lf, '"restart"'),
  );
  for (const entry of entries) {
    const value = entryValue(entry);
    assert(typeof value !== "string" || !value.includes("\r"));
  }
});

// readSource: plural groups

test("readSource forms plural groups with _other and at least one other category", () => {
  const cases: [string, string[]][] = [
    ['{"x_other": "a"}', ['text ["x_other"]']],
    ['{"x_one": "a", "x_few": "b"}', ['text ["x_one"]', 'text ["x_few"]']],
    ['{"x_one": "a", "x_other": "b"}', ['plural ["x"]']],
    ['{"x_zero": "a", "x_other": "b"}', ['plural ["x"]']],
    ['{"x_many": "a", "x_other": "b", "x_two": "c"}', ['plural ["x"]']],
    ['{"x_ordinal_other": "a"}', ['text ["x_ordinal_other"]']],
    ['{"x_ordinal_two": "a", "x_ordinal_other": "b"}', ['ordinal ["x"]']],
    ['{"_one": "a", "_other": "b"}', ['text ["_one"]', 'text ["_other"]']],
    ['{"x_One": "a", "x_OTHER": "b"}', ['text ["x_One"]', 'text ["x_OTHER"]']],
    ['{"x_one ": "a", "x_other": "b"}', ['text ["x_one "]', 'text ["x_other"]']],
    ['{"x_1": "a", "x_other": "b"}', ['text ["x_1"]', 'text ["x_other"]']],
    ['{"a_one_one": "a", "a_one_other": "b"}', ['plural ["a_one"]']],
    [
      '{"\u043c\u043e\u043d\u0435\u0442\u0430_one": "a", "\u043c\u043e\u043d\u0435\u0442\u0430_other": "b"}',
      ['plural ["\u043c\u043e\u043d\u0435\u0442\u0430"]'],
    ],
    ['{"a.b_one": "a", "a.b_other": "b"}', ['plural ["a.b"]']],
  ];
  for (const [text, expected] of cases) expect(summary(read(text)), text).toStrictEqual(expected);
});

test("readSource forms a group only when every key of it holds a string", () => {
  expect(summary(read('{"x_one": "a", "x_other": 5}'))).toStrictEqual([
    'text ["x_one"]',
    'literal ["x_other"]',
  ]);
  expect(summary(read('{"x_one": "a", "x_other": "b", "x_few": {"deep": "c"}}'))).toStrictEqual([
    'text ["x_one"]',
    'text ["x_other"]',
    'text ["x_few","deep"]',
  ]);
  expect(summary(read('{"x_one": "a", "x_other": "b", "x_zero": ""}'))).toStrictEqual([
    'plural ["x"]',
  ]);
  expect(
    (read('{"x_one": "a", "x_other": "b", "x_zero": ""}')[0] as PluralEntry).forms,
  ).toStrictEqual({
    zero: "",
    one: "a",
    other: "b",
  });
  // A non-string ordinal key doesn't stop the cardinal group of the same base.
  expect(summary(read('{"x_one": "a", "x_other": "b", "x_ordinal_one": null}'))).toStrictEqual([
    'plural ["x"]',
    'literal ["x_ordinal_one"]',
  ]);
});

test("readSource puts a group at the position of its first key, forms in CLDR order", () => {
  const entries = read('{"x_other": "b", "y": "c", "x_one": "a", "z": "d", "x_zero": "e"}');
  expect(summary(entries)).toStrictEqual(['plural ["x"]', 'text ["y"]', 'text ["z"]']);
  expect(Object.keys((entries[0] as PluralEntry).forms)).toStrictEqual(["zero", "one", "other"]);
  expect(entries[0].line).toBe(1);
});

test("readSource combines context and plural keys as i18next does", () => {
  const entries = read([
    "{",
    '  "friend": "A friend",',
    '  "friend_male": "A boyfriend",',
    '  "friend_one": "{{count}} friend",',
    '  "friend_other": "{{count}} friends",',
    '  "friend_male_one": "{{count}} boyfriend",',
    '  "friend_male_other": "{{count}} boyfriends",',
    '  "friend_female_other": "{{count}} girlfriends"',
    "}",
  ]);
  expect(summary(entries)).toStrictEqual([
    'text ["friend"]',
    'text ["friend_male"]',
    'plural ["friend"]',
    'plural ["friend_male"]',
    'text ["friend_female_other"]',
  ]);
});

test("readSource keeps a cardinal group, an ordinal group and a plain key with one base apart", () => {
  const entries = read([
    "{",
    '  "place": "Place",',
    '  "place_one": "{{count}} place",',
    '  "place_other": "{{count}} places",',
    '  "place_ordinal_one": "{{count}}st",',
    '  "place_ordinal_other": "{{count}}th"',
    "}",
  ]);
  expect(summary(entries)).toStrictEqual([
    'text ["place"]',
    'plural ["place"]',
    'ordinal ["place"]',
  ]);
  expect(entries.map((entry) => entryKey(entry.kind, entry.keyPath))).toStrictEqual([
    '["place"]',
    '["place"]#plural',
    '["place"]#ordinal',
  ]);
});

test("readSource finds plural groups in objects inside arrays", () => {
  const entries = read(
    '{"list": [{"n_one": "a", "n_other": "b"}, [{"m_two": "c", "m_other": "d"}]]}',
  );
  expect(summary(entries)).toStrictEqual(['plural ["list",0,"n"]', 'plural ["list",1,0,"m"]']);
});

test("readSource leaves excluded groups as text, by key path without the category", () => {
  const text = [
    "{",
    '  "menu": {',
    '    "player_one": "Player One",',
    '    "player_two": "Player Two",',
    '    "player_other": "Other players",',
    '    "power_ordinal_one": "Power I",',
    '    "power_ordinal_other": "Power N"',
    "  },",
    '  "player_one": "{{count}} player",',
    '  "player_other": "{{count}} players",',
    '  "a.b": { "c_one": "x", "c_other": "y" }',
    "}",
  ];
  expect(summary(read(text))).toStrictEqual([
    'plural ["menu","player"]',
    'ordinal ["menu","power"]',
    'plural ["player"]',
    'plural ["a.b","c"]',
  ]);
  expect((read(text)[0] as PluralEntry).forms).toStrictEqual({
    one: "Player One",
    two: "Player Two",
    other: "Other players",
  });
  const excluded = read(text, {
    pluralExclusions: ["menu.player", "menu.power_ordinal", "a.b.c", "nope"],
  });
  expect(summary(excluded)).toStrictEqual([
    'text ["menu","player_one"]',
    'text ["menu","player_two"]',
    'text ["menu","player_other"]',
    'text ["menu","power_ordinal_one"]',
    'text ["menu","power_ordinal_other"]',
    'plural ["player"]',
    'text ["a.b","c_one"]',
    'text ["a.b","c_other"]',
  ]);
});

test("readSource excludes a cardinal or an ordinal group, and exact key paths", () => {
  // Regression: an exclusion took out both groups with its base, and couldn't tell a key
  // "a.b" from a key "b" in an object "a".
  const text = JSON.stringify({
    rank_one: "Rank one",
    rank_other: "Other ranks",
    rank_ordinal_one: "{{count}}st",
    rank_ordinal_two: "{{count}}nd",
    rank_ordinal_few: "{{count}}rd",
    rank_ordinal_other: "{{count}}th",
    "a.b_one": "x",
    "a.b_other": "y",
    a: { b_one: "x", b_other: "y" },
  });
  const groups = (exclusions: string[]) =>
    summary(read(text, { pluralExclusions: exclusions })).filter((e) => !e.startsWith("text"));
  const all = ['plural ["rank"]', 'ordinal ["rank"]', 'plural ["a.b"]', 'plural ["a","b"]'];
  expect(groups([])).toStrictEqual(all);
  expect(groups(["rank"])).toStrictEqual(all.filter((e) => e !== 'plural ["rank"]'));
  expect(groups(["rank_ordinal"])).toStrictEqual(all.filter((e) => e !== 'ordinal ["rank"]'));
  expect(groups(["a.b"])).toStrictEqual(['plural ["rank"]', 'ordinal ["rank"]']);
  expect(groups(['["a.b"]'])).toStrictEqual(all.filter((e) => e !== 'plural ["a.b"]'));
  expect(groups(['["a", "b"]'])).toStrictEqual(all.filter((e) => e !== 'plural ["a","b"]'));
  expect(groups(['["rank_ordinal"]', "[not json", "[]", '["x", -1]'])).toStrictEqual(
    all.filter((e) => e !== 'ordinal ["rank"]'),
  );
  // Excluded keys become the entries plain strings would be.
  expect(summary(read(text, { pluralExclusions: ["rank_ordinal"] })).slice(1, 5)).toStrictEqual([
    'text ["rank_ordinal_one"]',
    'text ["rank_ordinal_two"]',
    'text ["rank_ordinal_few"]',
    'text ["rank_ordinal_other"]',
  ]);
});

test("readSource copies groups with nothing to translate, as plain strings", () => {
  // Regression: a group whose forms were blank or only references was shown to
  // translators, and copying the English failed the checks.
  const entries = read(
    JSON.stringify({
      status: "",
      unread_zero: "",
      unread_one: "{{count}} unread message",
      unread_other: "{{count}} unread messages",
      label: "$t(common:item)",
      label2_one: "$t(common:item)",
      label2_other: "$t(common:items)",
      blank_one: "",
      blank_other: " ",
      mixed_zero: "",
      mixed_one: "$t(a)",
      mixed_other: " $t(b) $t(c) ",
      place_ordinal_one: "$t(first)",
      place_ordinal_other: "$t(nth)",
    }),
  );
  expect(summary(entries)).toStrictEqual([
    'literal ["status"]',
    'plural ["unread"]',
    'reference ["label"]',
    'reference ["label2_one"]',
    'reference ["label2_other"]',
    'literal ["blank_one"]',
    'literal ["blank_other"]',
    'literal ["mixed_zero"]',
    'reference ["mixed_one"]',
    'reference ["mixed_other"]',
    'reference ["place_ordinal_one"]',
    'reference ["place_ordinal_other"]',
  ]);
  // The `_zero: ""` idiom keeps its group, with the blank form.
  expect((entries[1] as PluralEntry).forms).toStrictEqual({
    zero: "",
    one: "{{count}} unread message",
    other: "{{count}} unread messages",
  });
  // A reference next to text is still a group to translate.
  expect(summary(read('{"x_one": "$t(one)", "x_other": "{{count}} items"}'))).toStrictEqual([
    'plural ["x"]',
  ]);
});

test("parsePluralKey and pluralKeyName split and join plural keys", () => {
  expect(parsePluralKey("coins_few")).toStrictEqual({
    base: "coins",
    kind: "plural",
    category: "few",
  });
  expect(parsePluralKey("place_ordinal_one")).toStrictEqual({
    base: "place",
    kind: "ordinal",
    category: "one",
  });
  expect(parsePluralKey("friend_male_other")).toStrictEqual({
    base: "friend_male",
    kind: "plural",
    category: "other",
  });
  expect(parsePluralKey("x_ordinal_ordinal_two")?.base).toBe("x_ordinal");
  // With nothing before `_ordinal`, the key is a cardinal key of the base `_ordinal`.
  expect(parsePluralKey("_ordinal_one")).toStrictEqual({
    base: "_ordinal",
    kind: "plural",
    category: "one",
  });
  for (const key of ["coins", "_one", "one", "coins_", "coins_Few", "coins_1", "coins-one", ""]) {
    expect(parsePluralKey(key), key).toBe(undefined);
  }
  for (const base of ["coins", "a_b", "_", "\u{1f389}", "a.b", "x_ordinal_"]) {
    for (const kind of ["plural", "ordinal"] as const) {
      for (const category of PLURAL_CATEGORIES) {
        const key = pluralKeyName(base, kind, category);
        expect(parsePluralKey(key), key).toStrictEqual({ base, kind, category });
      }
    }
  }
  // A cardinal group can't have a base ending in `_ordinal`: its keys read as ordinal keys.
  expect(parsePluralKey(pluralKeyName("x_ordinal", "plural", "one"))).toStrictEqual({
    base: "x",
    kind: "ordinal",
    category: "one",
  });
  expect(parsePluralKey(pluralKeyName("x_ordinal", "ordinal", "one"))?.base).toStrictEqual(
    "x_ordinal",
  );
  expect(pluralKeyName("place", "ordinal", "two")).toBe("place_ordinal_two");
  expect(pluralKeyName("coins", "plural", "many")).toBe("coins_many");
});

// readSource: strings

test("readSource makes empty and whitespace-only strings literals", () => {
  const values = ["", " ", "\t", "\n  ", "\u00a0", "\u3000", "\u2028", " \r\n "];
  for (const value of values) {
    const entries = read(JSON.stringify({ s: value }));
    expect(summary(entries), JSON.stringify(value)).toStrictEqual(['literal ["s"]']);
    expect(literal(entries, ["s"])).toStrictEqual(JSON.stringify(value));
  }
  expect(summary(read('{"s": " x "}'))).toStrictEqual(['text ["s"]']);
  expect(summary(read('{"s": "\\u200b"}'))).toStrictEqual(['text ["s"]']);
});

test("readSource makes strings of only references and whitespace reference entries", () => {
  const references = [
    "$t(back)",
    "$t(common:back)",
    " $t(a) ",
    "$t(a)$t(b)",
    "$t(a)\n$t(b)",
    '$t(ns:key, {"count": {{n}}})',
    '$t(a, {"context": "male"}) \u00a0 $t(b)',
  ];
  for (const value of references) {
    expect(summary(read(JSON.stringify({ s: value }))), value).toStrictEqual(['reference ["s"]']);
    assert(isReferenceOnly(value), value);
  }
  const texts = ["$t(a)!", "$t(a) {{b}}", "$t(", "$t(a", "t(a)", "{{count}}", "Go: $t(a)", "$T(a)"];
  for (const value of texts) {
    expect(summary(read(JSON.stringify({ s: value }))), value).toStrictEqual(['text ["s"]']);
    assert(!isReferenceOnly(value), value);
  }
  assert(isReferenceOnly('$t(a, {"n": %{n}})', { prefix: "%{", suffix: "}" }));
  assert(!isReferenceOnly("$t(a) %{n}", { prefix: "%{", suffix: "}" }));
  assert(!isReferenceOnly("$t(a) {{n}}", { prefix: "%{", suffix: "}" }));
});

test("readSource passes the interpolation syntax to the tokenizer", () => {
  const syntax = { prefix: "__", suffix: "__" };
  expect(summary(read('{"s": "$t(a) __n__"}', { syntax }))).toStrictEqual(['text ["s"]']);
  expect(summary(read('{"s": "$t(a, {\\"n\\": __n__})"}', { syntax }))).toStrictEqual([
    'reference ["s"]',
  ]);
});

// readSource: literals and structure

test("readSource keeps number spelling and nested empty containers", () => {
  const entries = read(
    '{"n": [0, -0, 1.0, 1E-7, 123456789012345678901234567890, -12.5e+10], "a": {"b": {}, "c": [[]]}}',
  );
  expect(entries.map((entry) => (entry as LiteralEntry).raw)).toStrictEqual([
    "0",
    "-0",
    "1.0",
    "1E-7",
    "123456789012345678901234567890",
    "-12.5e+10",
    "{}",
    "[]",
  ]);
  expect(entries.at(-1)?.keyPath).toStrictEqual(["a", "c", 0]);
});

test("readSource gives no entries for an empty root object", () => {
  expect(readSource("{}").entries).toStrictEqual([]);
  expect(readSource("\ufeff{ }\r\n").entries).toStrictEqual([]);
  expect(readSource("{}").format).toStrictEqual({ indent: "", newline: "\n", finalNewline: false });
});

test("readSource entries are plain data", () => {
  const entries = read(enCommon);
  expect(JSON.parse(JSON.stringify(entries))).toStrictEqual(entries);
  expect(withoutLines(entries).length).toBe(35);
});

// readSource: errors

test("readSource refuses a root that isn't an object", async () => {
  const cases: [string, string, number, number][] = [
    ["[1, 2]", "an array", 1, 1],
    ['"text"', "a string", 1, 1],
    ["42", "a number", 1, 1],
    ["true", "a boolean", 1, 1],
    ["null", "null", 1, 1],
    ["\n\n   [\n]", "an array", 3, 4],
    ["\r\n  []", "an array", 2, 3],
  ];
  for (const [text, found, line, column] of cases) {
    const error = await Promise.try(() => readSource(text, { file: "en/x.json" })).catch(
      (error: unknown) => error,
    );
    assert(error instanceof SourceError);
    expect(error.code).toBe("not_an_object");
    expect(error.detail).toStrictEqual(`The file must contain a JSON object, not ${found}`);
    expect([error.file, error.line, error.column], text).toStrictEqual(["en/x.json", line, column]);
    expect(error.message).toStrictEqual(`en/x.json:${line}:${column}: ${error.detail}`);
  }
});

test("readSource reports JSON syntax errors with the file, line and column", async () => {
  const text = ["{", '  "a": "b",', '  "c" "d"', "}"];
  for (const newline of ["\n", "\r\n"]) {
    const error = await Promise.try(() =>
      readSource(text.join(newline), { file: "en/common.json" }),
    ).catch((error: unknown) => error);
    assert(error instanceof JsonSyntaxError);
    expect([error.code, error.file, error.line, error.column]).toStrictEqual([
      "syntax",
      "en/common.json",
      3,
      7,
    ]);
    assert(error.message.startsWith("en/common.json:3:7: "), error.message);
  }
  const emoji = await Promise.try(() => readSource('{"\u{1f600}": x}')).catch(
    (error: unknown) => error,
  );
  assert(emoji instanceof JsonSyntaxError);
  expect([emoji.line, emoji.column]).toStrictEqual([1, 8]);
  const end = await Promise.try(() => readSource('{"a": "b"')).catch((error: unknown) => error);
  assert(end instanceof JsonSyntaxError);
  expect(end.detail).toBe("Unexpected end of file");
  expect(() => readSource("")).toThrow(JsonSyntaxError);
});

test("readSource reports duplicate keys with their path", async () => {
  const text = ["{", '  "menu": {', '    "play": "Play",', '    "play": "Again"', "  }", "}"];
  const error = await Promise.try(() => readSource(text.join("\n"), { file: "en.json" })).catch(
    (error: unknown) => error,
  );
  assert(error instanceof JsonSyntaxError);
  expect(error.code).toBe("duplicate_key");
  expect(error.keyPath).toStrictEqual(["menu", "play"]);
  expect([error.file, error.line, error.column]).toStrictEqual(["en.json", 4, 5]);
  expect(error.detail).toBe('Duplicate key "play" at menu.play');
});

test("SourceError formats its position", () => {
  const error = new SourceError("key_conflict", "Two entries", {
    file: "a.json",
    keyPath: ["x"],
    line: 3,
    column: 4,
  });
  expect(error.message).toBe("a.json:3:4: Two entries");
  expect(error.name).toBe("SourceError");
  expect(new SourceError("key_conflict", "x", { line: 2 }).message).toBe("<input>:2:1: x");
  expect(new SourceError("not_an_object", "x", { file: "f" }).message).toBe("f: x");
});

test("entryValue gives the value of text and plural entries only", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  expect(entryValue(find(entries, "text", ["title"]))).toBe("Field Guide");
  expect(entryValue(find(entries, "plural", ["lap"]))).toStrictEqual({
    one: "{{count}} lap",
    other: "{{count}} laps",
  });
  expect(entryValue(find(entries, "reference", ["back"]))).toBe(undefined);
  expect(entryValue(find(entries, "literal", ["tags"]))).toBe(undefined);
});

// readTranslation

test("readTranslation reads an existing translation file for an import", () => {
  const english = read(enCommon);
  const result = readTranslation(importedPlCommon, english, {
    language: "pl",
    file: "pl/common.json",
  });
  expect(result.unknownKeys).toStrictEqual([
    "nav.help",
    "trip.stops_one",
    "trip.stops_few",
    "actions.archive",
    "footer.links.3",
    "legacy.banner",
    "legacy.empty",
  ]);
  const expected = new Map<string, TextValue>([
    ['["appName"]', "Wayfarer"],
    ['["nav","home"]', "Strona g\u0142\u00f3wna"],
    ['["nav","trips"]', "Podr\u00f3\u017ce"],
    ['["nav","settings"]', "Ustawienia"],
    ['["nav","signOut"]', "Wyloguj si\u0119"],
    ['["greeting"]', "Cze\u015b\u0107, {{name}}!"],
    ['["greeting_morning"]', "Dzie\u0144 dobry, {{name}}!"],
    ['["trip","title"]', "Twoje podr\u00f3\u017ce"],
    ['["trip","empty"]', "Nie masz jeszcze \u017cadnych podr\u00f3\u017cy. $t(trip.cta)"],
    ['["trip","cta"]', "Zaplanuj pierwsz\u0105!"],
    [
      '["trip","count"]#plural',
      {
        one: "{{count}} podr\u00f3\u017c",
        few: "{{count}} podr\u00f3\u017ce",
        other: "{{count}} podr\u00f3\u017cy",
      },
    ],
    [
      '["trip","daysLeft"]#plural',
      {
        one: "Wyjazd jutro",
        few: "Wyjazd za {{count}} dni",
        many: "Wyjazd za {{count}} dni",
        other: "Wyjazd za {{count}} dnia",
      },
    ],
    ['["trip","updated"]', "Zaktualizowano {{date, relativetime}}"],
    [
      '["invite"]#plural',
      {
        one: "{{name}} zaprasza {{count}} znajomego",
        few: "{{name}} zaprasza {{count}} znajomych",
        many: "{{name}} zaprasza {{count}} znajomych",
        other: "{{name}} zaprasza {{count}} znajomego",
      },
    ],
    [
      '["invite_male"]#plural',
      {
        one: "Zaprosi\u0142 {{count}} znajomego",
        few: "Zaprosi\u0142 {{count}} znajomych",
        many: "Zaprosi\u0142 {{count}} znajomych",
        other: "Zaprosi\u0142 {{count}} znajomego",
      },
    ],
    [
      '["invite_female"]#plural',
      {
        two: "Zaprosi\u0142a dwoje znajomych",
        other: "Zaprosi\u0142a {{count}} znajomego",
      },
    ],
    ['["actions","save"]', "Zapisz"],
    ['["actions","cancel"]', "Anuluj"],
    ['["actions","delete"]', "Usu\u0144"],
    [
      '["actions","confirmDelete"]',
      "Usun\u0105\u0107 \u201e{{- name}}\u201d? Tej operacji nie mo\u017cna cofn\u0105\u0107.",
    ],
    ['["actions","share"]', "Udost\u0119pnij"],
    ['["errors","required"]', "To pole jest wymagane."],
    ['["errors","minLength"]', "U\u017cyj co najmniej {{min}} znak\u00f3w."],
    [
      '["errors","network"]',
      "Nie uda\u0142o si\u0119 po\u0142\u0105czy\u0107 z serwerem. Sprawd\u017a po\u0142\u0105czenie i spr\u00f3buj ponownie.",
    ],
    ['["errors","generic"]', "Co\u015b posz\u0142o nie tak."],
    ['["footer","copyright"]', "\u00a9 {{year}} Wayfarer"],
    ['["footer","links",0]', "Prywatno\u015b\u0107"],
    ['["footer","links",1]', "Warunki"],
    ['["footer","links",2]', "Kontakt"],
  ]);
  expect([...result.values.keys()]).toStrictEqual([...expected.keys()]);
  expect(result.values).toStrictEqual(expected);
  const forms = result.values.get('["trip","daysLeft"]#plural') as Record<string, string>;
  expect(Object.keys(forms)).toStrictEqual(["one", "few", "many", "other"]);
});

test("readTranslation reads forms of any category, whatever the language needs", () => {
  const english = read(enAppendix, APPENDIX_OPTIONS);
  const withOne = jaAppendix.replace(
    '"coins_other": "\u30b3\u30a4\u30f3{{count}}\u679a",',
    '"coins_one": "\u30b3\u30a4\u30f31\u679a",\n    "coins_other": "\u30b3\u30a4\u30f3{{count}}\u679a",',
  );
  const result = readTranslation(withOne, english, { language: "ja" });
  expect(result.unknownKeys).toStrictEqual([]);
  expect(result.values.get('["inventory","coins"]#plural')).toStrictEqual({
    one: "\u30b3\u30a4\u30f31\u679a",
    other: "\u30b3\u30a4\u30f3{{count}}\u679a",
  });
  expect(result.values.get('["messages"]#plural')).toStrictEqual({
    zero: "\u65b0\u7740\u30e1\u30c3\u30bb\u30fc\u30b8\u306f\u3042\u308a\u307e\u305b\u3093",
    other:
      "\u65b0\u7740\u30e1\u30c3\u30bb\u30fc\u30b8\u304c{{count}}\u4ef6\u3042\u308a\u307e\u3059",
  });
  // The language and override don't change what is read.
  expect(
    readTranslation(withOne, english, { language: "ar", pluralOverride: { cardinal: ["other"] } }),
  ).toStrictEqual(result);
});

test("readTranslation skips values of the wrong type without reporting them", () => {
  const english = read([
    "{",
    '  "title": "Title",',
    '  "coins_one": "{{count}} coin",',
    '  "coins_other": "{{count}} coins",',
    '  "nav": { "home": "Home", "back": "Back" },',
    '  "hints": ["One", "Two"],',
    '  "grid": [["a"]]',
    "}",
  ]);
  const result = readPl(
    [
      "{",
      '  "title": 42,',
      '  "coins_one": null,',
      '  "coins_few": ["x"],',
      '  "coins_other": { "text": "y" },',
      '  "nav": "Home",',
      '  "hints": [true, { "a": "b" }],',
      '  "grid": [{}]',
      "}",
    ],
    english,
  );
  expect(result.values).toStrictEqual(new Map());
  expect(result.unknownKeys).toStrictEqual([]);
  const empty = readPl('{"nav": {}, "hints": [], "grid": [[]], "coins_one": "x"}', english);
  expect(empty.unknownKeys).toStrictEqual([]);
  expect(empty.values).toStrictEqual(new Map([['["coins"]#plural', { one: "x" }]]));
});

test("readTranslation skips an array where English has an object, and the reverse", () => {
  // Regression: the values were reported as unknown keys that display like English ones.
  const english = read('{"levels": {"0": "Easy", "1": "Hard"}, "hints": ["Easy", "Hard"]}');
  const swapped = readPl(
    '{"levels": ["Łatwy", "Trudny"], "hints": {"0": "Łatwy", "1": "Trudny"}}',
    english,
  );
  expect(swapped).toStrictEqual({ values: new Map(), unknownKeys: [] });
  // Deeper down too, and with the right types the values are read.
  const nested = read('{"a": {"b": {"0": "x"}, "c": [["y"]]}}');
  expect(readPl('{"a": {"b": ["x"], "c": [{"0": "y"}]}}', nested).unknownKeys).toStrictEqual([]);
  expect([
    ...readPl('{"a": {"b": {"0": "X"}, "c": [["Y"]]}}', nested).values.values(),
  ]).toStrictEqual(["X", "Y"]);
});

test("readTranslation reports what fills an object or array English has empty", () => {
  // Regression: values inside were silently ignored.
  const english = read('{"extra": {}, "list": [], "deep": {"x": [{}]}}');
  const result = readPl(
    '{"extra": {"a": "b", "c_one": "d", "c_few": "e"}, "list": ["x", []], "deep": {"x": [{"y": 1}]}}',
    english,
  );
  expect(result.unknownKeys).toStrictEqual([
    "extra.a",
    "extra.c_one",
    "extra.c_few",
    "list.0",
    "list.1",
    "deep.x.0.y",
  ]);
  expect(result.values).toStrictEqual(new Map());
  // Empty ones, or values of another type, are fine.
  expect(
    readPl('{"extra": {}, "list": {"a": 1}, "deep": {"x": [[]]}}', english).unknownKeys,
  ).toStrictEqual([]);
});

test("readTranslation doesn't report plural keys of a group English copies", () => {
  const english = read(
    JSON.stringify({
      label_one: "$t(common:item)",
      label_other: "$t(common:items)",
      blank_one: "",
      blank_other: " ",
      lone_other: "$t(x)",
    }),
  );
  const result = readPl(
    JSON.stringify({
      label_one: "$t(common:item)",
      label_few: "$t(common:items)",
      label_many: "$t(common:items)",
      label_other: "$t(common:items)",
      blank_few: "",
      lone_one: "$t(y)",
      other_one: "x",
    }),
    english,
  );
  expect(result).toStrictEqual({ values: new Map(), unknownKeys: ["other_one"] });
});

test("readTranslation reads deeply nested files in linear time", () => {
  // Regression: every entry's key path prefixes were serialized, O(n·d²).
  const depth = 250;
  const members = Array.from({ length: 20_000 }, (_, i) => `"k${i}": "v${i}"`).join(",");
  const text = '{"a":'.repeat(depth - 1) + `{${members}}` + "}".repeat(depth - 1);
  const { entries } = readSource(text);
  expect(entries.length).toBe(20_000);
  expect(entries[0].keyPath.length).toStrictEqual(depth);
  const started = performance.now();
  const result = readTranslation("{}", entries, { language: "pl" });
  const elapsed = performance.now() - started;
  expect(result).toStrictEqual({ values: new Map(), unknownKeys: [] });
  assert(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`);
});

test("readTranslation reports keys English doesn't have, by displayed path", () => {
  const english = read([
    "{",
    '  "coins": "Coins",',
    '  "gems_one": "{{count}} gem",',
    '  "gems_other": "{{count}} gems",',
    '  "place_ordinal_one": "{{count}}st",',
    '  "place_ordinal_other": "{{count}}th",',
    '  "hints": ["One"],',
    '  "menu": { "a.b": "Dotted" }',
    "}",
  ]);
  const result = readPl(
    [
      "{",
      '  "coins_one": "moneta",',
      '  "coins_few": "monety",',
      '  "gems": "Klejnoty",',
      '  "gems_ordinal_one": "1.",',
      '  "place_one": "miejsce",',
      '  "place_ordinal_few": "3.",',
      '  "hints": ["Jeden", "Dwa", ["Trzy"]],',
      '  "menu": { "a": { "b": "Kropka" }, "a.b": "Kropkowany", "c": {} },',
      '  "old": { "x": "1", "y": [2, null] },',
      '  "\u{1f389}_one": "impreza"',
      "}",
    ],
    english,
  );
  expect(result.unknownKeys).toStrictEqual([
    "coins_one",
    "coins_few",
    "gems",
    "gems_ordinal_one",
    "place_one",
    "hints.1",
    "hints.2.0",
    "menu.a.b",
    "menu.c",
    "old.x",
    "old.y.0",
    "old.y.1",
    "\u{1f389}_one",
  ]);
  expect(result.values).toStrictEqual(
    new Map<string, TextValue>([
      ['["place"]#ordinal', { few: "3." }],
      ['["hints",0]', "Jeden"],
      ['["menu","a.b"]', "Kropkowany"],
    ]),
  );
});

test("readTranslation ignores references and literals, and skips groups with no form", () => {
  const english = read(
    '{"back": "$t(common:back)", "n": 3, "e": "", "coins_one": "a", "coins_other": "b", "t": "T"}',
  );
  const result = readPl(
    '{"t": "Tekst", "back": "$t(common:wstecz)", "n": 4, "e": "x", "coins_other": 5}',
    english,
  );
  expect(result.unknownKeys).toStrictEqual([]);
  expect(result.values).toStrictEqual(new Map([['["t"]', "Tekst"]]));
});

test("readTranslation keeps empty strings and returns values in English order", () => {
  const english = read('{"a": "A", "b_one": "x", "b_other": "y", "c": "C"}');
  const result = readPl(
    '{"c": "", "b_other": "Y", "b_many": "M", "b_one": "X", "a": " "}',
    english,
  );
  expect([...result.values.entries()]).toStrictEqual([
    ['["a"]', " "],
    ['["b"]#plural', { one: "X", many: "M", other: "Y" }],
    ['["c"]', ""],
  ]);
  expect(Object.keys(result.values.get('["b"]#plural') as object)).toStrictEqual([
    "one",
    "many",
    "other",
  ]);
});

test("readTranslation reads CRLF files and Unicode keys", () => {
  const english = read(enAppendix, APPENDIX_OPTIONS);
  const crlf = jaAppendix.replaceAll("\n", "\r\n");
  const result = readTranslation(crlf, english, { language: "ja" });
  expect(result.unknownKeys).toStrictEqual([]);
  expect(result).toStrictEqual(readTranslation(jaAppendix, english, { language: "ja" }));
  expect(result.values.get('["\u65e5\u672c\u8a9e"]')).toBe("\u65e5\u672c\u8a9e");
  expect(result.values.get('["unicode","escapes"]')).toStrictEqual(
    "\u4e00\u884c\u76ee\n\u4e8c\u884c\u76ee\t\u30bf\u30d6 \u0001",
  );
});

test("readTranslation refuses files that aren't JSON objects", async () => {
  const english = read('{"a": "A"}');
  const root = await Promise.try(() =>
    readTranslation('["A"]', english, { language: "pl", file: "pl/a.json" }),
  ).catch((error: unknown) => error);
  assert(root instanceof SourceError);
  expect([root.code, root.message]).toStrictEqual([
    "not_an_object",
    "pl/a.json:1:1: The file must contain a JSON object, not an array",
  ]);
  const syntax = await Promise.try(() =>
    readTranslation('{\n  "a": "A",\n}', english, { language: "pl", file: "pl/a.json" }),
  ).catch((error: unknown) => error);
  assert(syntax instanceof JsonSyntaxError);
  expect([syntax.file, syntax.line, syntax.column]).toStrictEqual(["pl/a.json", 2, 11]);
  const duplicate = await Promise.try(() =>
    readTranslation('{"a": "A", "a": "B"}', english, { language: "pl" }),
  ).catch((error: unknown) => error);
  assert(duplicate instanceof JsonSyntaxError);
  expect(duplicate.code).toBe("duplicate_key");
});

// Size

test("readSource reads a file of several megabytes quickly", () => {
  const sections: string[] = [];
  for (let s = 0; s < 400; s++) {
    const members: string[] = [];
    for (let i = 0; i < 25; i++) {
      members.push(
        `    "text${i}": "Section ${s}, string ${i}: ${"lorem ipsum dolor ".repeat(12)}"`,
      );
      members.push(`    "items${i}_one": "{{count}} item in ${s}"`);
      members.push(`    "items${i}_other": "{{count}} items in ${s}"`);
    }
    sections.push(`  "section${s}": {\n${members.join(",\n")}\n  }`);
  }
  const text = `{\n${sections.join(",\n")}\n}\n`;
  assert(text.length > 2_500_000, String(text.length));
  const start = performance.now();
  const { entries } = readSource(text);
  const elapsed = performance.now() - start;
  expect(entries.length).toStrictEqual(400 * 50);
  assert(elapsed < 2000, `took ${elapsed} ms`);
  const translated = readTranslation(text, entries, { language: "pl" });
  expect(translated.values.size).toStrictEqual(entries.length);
  assert(performance.now() - start < 4000);
});
