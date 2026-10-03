// SPDX-License-Identifier: MIT
import { test } from "node:test";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@quaso/runtime/assert";
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
const enAppendix = await Bun.file(
  new URL("../testdata/i18next/en/appendix.json", import.meta.url),
).text();
const enCommon = await Bun.file(
  new URL("../testdata/i18next/en/common.json", import.meta.url),
).text();
const enMenus = await Bun.file(
  new URL("../testdata/i18next/en/menus.json.txt", import.meta.url),
).text();
const jaAppendix = await Bun.file(
  new URL("../testdata/i18next/ja/appendix.json", import.meta.url),
).text();
const importedPlCommon = await Bun.file(
  new URL("../testdata/i18next/import/pl/common.json.txt", import.meta.url),
).text();

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
  assertEquals(summary(entries), [
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
  assertEquals(new Set(keys).size, keys.length);
});

test("readSource reads plural and ordinal groups with their English forms", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const forms = (kind: string, keyPath: KeyPath) =>
    (find(entries, kind, keyPath) as PluralEntry).forms;
  assertEquals(forms("plural", ["inventory", "coins"]), {
    one: "{{count}} coin",
    other: "{{count}} coins",
  });
  assertEquals(forms("plural", ["messages"]), {
    zero: "No new messages",
    one: "One new message",
    other: "{{count}} new messages",
  });
  assertEquals(forms("ordinal", ["place"]), {
    one: "You finished {{count}}st",
    two: "You finished {{count}}nd",
    few: "You finished {{count}}rd",
    other: "You finished {{count}}th",
  });
  assertEquals(forms("plural", ["lap"]), { one: "{{count}} lap", other: "{{count}} laps" });
  assertEquals(Object.keys(forms("ordinal", ["lap"])), ["one", "two", "few", "other"]);
  assertEquals(forms("plural", ["ally_female"]), {
    one: "She travels with {{count}} ally.",
    other: "She travels with {{count}} allies.",
  });
  assertEquals(forms("plural", ["tutorial", 1, "offers"]), {
    one: "{{count}} offer",
    other: "{{count}} offers",
  });
});

test("readSource keeps text, references and literals as written", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const value = (kind: string, keyPath: KeyPath) =>
    (find(entries, kind, keyPath) as { value: string }).value;
  assertEquals(value("text", ["playAgain"]), "$t(play) again");
  assertEquals(value("reference", ["backOrQuit"]), "$t(common:back) $t(common:quit)");
  assertEquals(value("reference", ["coinsLabel"]), '$t(inventory.coins, {"count": {{total}}})');
  assertEquals(value("text", ["inventory", "coins"]), "Coins");
  assertEquals(value("text", ["inventory", "leftovers_other"]), "Leftovers");
  assertEquals(value("text", ["greeting_female"]), "Welcome back, madam.");
  assertEquals(value("text", ["hints", 1]), "Press {{key}} to open the map.");
  assertEquals(value("reference", ["hints", 2]), "$t(common:tip)");
  assertEquals(value("text", ["biomes", 1, 1, 0]), "Dunes");
  assertEquals(value("text", ["file.save"]), "Save file");
  assertEquals(value("text", ["v1.2", "changelog"]), "Fixed the ferry to the north island.");
  assertEquals(literal(entries, ["subtitle"]), '""');
  assertEquals(literal(entries, ["spacer"]), '" "');
  assertEquals(literal(entries, ["tutorial", 2]), "{}");
  assertEquals(literal(entries, ["biomes", 2]), "[]");
  assertEquals(literal(entries, ["stats", "version"]), "3");
  assertEquals(literal(entries, ["stats", "ratio"]), "1.50");
  assertEquals(literal(entries, ["stats", "scale"]), "1e3");
  assertEquals(literal(entries, ["stats", "drift"]), "-0.25");
  assertEquals(literal(entries, ["stats", "limit"]), "2E+5");
  assertEquals(literal(entries, ["stats", "zero"]), "0");
  assertEquals(literal(entries, ["stats", "thresholds", 1]), "2.50");
  assertEquals(literal(entries, ["stats", "beta"]), "true");
  assertEquals(literal(entries, ["stats", "hardcore"]), "false");
  assertEquals(literal(entries, ["stats", "legacy"]), "null");
  assertEquals(literal(entries, ["extras"]), "{}");
  assertEquals(literal(entries, ["tags"]), "[]");
});

test("readSource keeps Unicode text and keys exactly", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const value = (key: string) =>
    (find(entries, "text", ["unicode", key]) as { value: string }).value;
  assertEquals(value("emoji"), "Treasure found \u{1f389}\u{1f48e}");
  assertEquals(value("family"), "\u{1f469}\u200d\u{1f469}\u200d\u{1f467} Family mode");
  assertEquals(value("flags"), "Made in \u{1f1fa}\u{1f1e6} and \u{1f1f5}\u{1f1f9}");
  assertEquals(value("combining"), "Cafe\u0301 for Ame\u0301lie, man\u0303ana");
  assertEquals(value("surrogates"), "\ud835\udcb3 marks the spot \ud834\udd1e");
  assertEquals(value("cjk"), "\u65c5\u306e\u8a18\u9332");
  assertEquals(value("nbsp"), "10\u00a0km to go");
  assertEquals(value("zeroWidth"), "no\u200bbreak");
  assertEquals(value("quotes"), 'She said "run" and left \\o/');
  assertEquals(value("escapes"), "Line one\nLine two\tTabbed \u0001");
  find(entries, "text", ["\u65e5\u672c\u8a9e"]);
  find(entries, "text", ["emoji_\u{1f389}"]);
  find(entries, "text", ["\u043a\u043b\u044e\u0447"]);
});

test("readSource keeps integer-like keys in file order", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const chapters = entries.filter((entry) => entry.keyPath[0] === "chapters");
  assertEquals(
    chapters.map((entry) => entry.keyPath[1]),
    ["10", "2", "1", "1.5"],
  );
  assertEquals(
    read(['{"b": "x", "10": "y", "2": "z"}']).map((e) => e.keyPath[0]),
    ["b", "10", "2"],
  );
});

test("readSource gives each entry the line of its key", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  const line = (kind: string, keyPath: KeyPath) => find(entries, kind, keyPath).line;
  assertEquals(line("text", ["title"]), 2);
  assertEquals(line("plural", ["inventory", "coins"]), lineOf(enAppendix, '"coins_one"'));
  assertEquals(line("plural", ["messages"]), lineOf(enAppendix, '"messages_zero"'));
  assertEquals(line("ordinal", ["lap"]), lineOf(enAppendix, '"lap_ordinal_one"'));
  assertEquals(line("text", ["hints", 0]), lineOf(enAppendix, '"Hold Shift'));
  assertEquals(line("literal", ["tutorial", 2]), lineOf(enAppendix, "    {}"));
  assertEquals(line("text", ["biomes", 1, 1, 1]), lineOf(enAppendix, '"Oasis"'));
  assertEquals(line("literal", ["stats", "legacy"]), lineOf(enAppendix, '"legacy"'));
  assertEquals(line("text", ["\u043a\u043b\u044e\u0447"]), lineOf(enAppendix, '"\u043a'));
});

test("readSource reads CRLF files with 4-space indentation", () => {
  const { format, entries } = readSource(enMenus, { file: "en/menus.json" });
  assertEquals(format, { indent: "    ", newline: "\r\n", finalNewline: true });
  const lf = enMenus.replaceAll("\r\n", "\n");
  const rank = find(entries, "ordinal", ["results", "rank"]) as PluralEntry;
  assertEquals(rank.line, lineOf(lf, '"rank_ordinal_one"'));
  assertEquals(rank.forms.two, "Ranked {{count}}nd on today\u2019s board");
  assertEquals(
    find(entries, "text", ["options", "difficulty", "levels", 3]).line,
    lineOf(lf, "Inferno"),
  );
  assertEquals(literal(entries, ["options", "difficulty", "default"]), "1");
  assertEquals(find(entries, "reference", ["pause", "restart"]).line, lineOf(lf, '"restart"'));
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
  for (const [text, expected] of cases) assertEquals(summary(read(text)), expected, text);
});

test("readSource forms a group only when every key of it holds a string", () => {
  assertEquals(summary(read('{"x_one": "a", "x_other": 5}')), [
    'text ["x_one"]',
    'literal ["x_other"]',
  ]);
  assertEquals(summary(read('{"x_one": "a", "x_other": "b", "x_few": {"deep": "c"}}')), [
    'text ["x_one"]',
    'text ["x_other"]',
    'text ["x_few","deep"]',
  ]);
  assertEquals(summary(read('{"x_one": "a", "x_other": "b", "x_zero": ""}')), ['plural ["x"]']);
  assertEquals((read('{"x_one": "a", "x_other": "b", "x_zero": ""}')[0] as PluralEntry).forms, {
    zero: "",
    one: "a",
    other: "b",
  });
  // A non-string ordinal key doesn't stop the cardinal group of the same base.
  assertEquals(summary(read('{"x_one": "a", "x_other": "b", "x_ordinal_one": null}')), [
    'plural ["x"]',
    'literal ["x_ordinal_one"]',
  ]);
});

test("readSource puts a group at the position of its first key, forms in CLDR order", () => {
  const entries = read('{"x_other": "b", "y": "c", "x_one": "a", "z": "d", "x_zero": "e"}');
  assertEquals(summary(entries), ['plural ["x"]', 'text ["y"]', 'text ["z"]']);
  assertEquals(Object.keys((entries[0] as PluralEntry).forms), ["zero", "one", "other"]);
  assertEquals(entries[0].line, 1);
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
  assertEquals(summary(entries), [
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
  assertEquals(summary(entries), ['text ["place"]', 'plural ["place"]', 'ordinal ["place"]']);
  assertEquals(
    entries.map((entry) => entryKey(entry.kind, entry.keyPath)),
    ['["place"]', '["place"]#plural', '["place"]#ordinal'],
  );
});

test("readSource finds plural groups in objects inside arrays", () => {
  const entries = read(
    '{"list": [{"n_one": "a", "n_other": "b"}, [{"m_two": "c", "m_other": "d"}]]}',
  );
  assertEquals(summary(entries), ['plural ["list",0,"n"]', 'plural ["list",1,0,"m"]']);
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
  assertEquals(summary(read(text)), [
    'plural ["menu","player"]',
    'ordinal ["menu","power"]',
    'plural ["player"]',
    'plural ["a.b","c"]',
  ]);
  assertEquals((read(text)[0] as PluralEntry).forms, {
    one: "Player One",
    two: "Player Two",
    other: "Other players",
  });
  const excluded = read(text, {
    pluralExclusions: ["menu.player", "menu.power_ordinal", "a.b.c", "nope"],
  });
  assertEquals(summary(excluded), [
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
  assertEquals(groups([]), all);
  assertEquals(
    groups(["rank"]),
    all.filter((e) => e !== 'plural ["rank"]'),
  );
  assertEquals(
    groups(["rank_ordinal"]),
    all.filter((e) => e !== 'ordinal ["rank"]'),
  );
  assertEquals(groups(["a.b"]), ['plural ["rank"]', 'ordinal ["rank"]']);
  assertEquals(
    groups(['["a.b"]']),
    all.filter((e) => e !== 'plural ["a.b"]'),
  );
  assertEquals(
    groups(['["a", "b"]']),
    all.filter((e) => e !== 'plural ["a","b"]'),
  );
  assertEquals(
    groups(['["rank_ordinal"]', "[not json", "[]", '["x", -1]']),
    all.filter((e) => e !== 'ordinal ["rank"]'),
  );
  // Excluded keys become the entries plain strings would be.
  assertEquals(summary(read(text, { pluralExclusions: ["rank_ordinal"] })).slice(1, 5), [
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
  assertEquals(summary(entries), [
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
  assertEquals((entries[1] as PluralEntry).forms, {
    zero: "",
    one: "{{count}} unread message",
    other: "{{count}} unread messages",
  });
  // A reference next to text is still a group to translate.
  assertEquals(summary(read('{"x_one": "$t(one)", "x_other": "{{count}} items"}')), [
    'plural ["x"]',
  ]);
});

test("parsePluralKey and pluralKeyName split and join plural keys", () => {
  assertEquals(parsePluralKey("coins_few"), { base: "coins", kind: "plural", category: "few" });
  assertEquals(parsePluralKey("place_ordinal_one"), {
    base: "place",
    kind: "ordinal",
    category: "one",
  });
  assertEquals(parsePluralKey("friend_male_other"), {
    base: "friend_male",
    kind: "plural",
    category: "other",
  });
  assertEquals(parsePluralKey("x_ordinal_ordinal_two")?.base, "x_ordinal");
  // With nothing before `_ordinal`, the key is a cardinal key of the base `_ordinal`.
  assertEquals(parsePluralKey("_ordinal_one"), {
    base: "_ordinal",
    kind: "plural",
    category: "one",
  });
  for (const key of ["coins", "_one", "one", "coins_", "coins_Few", "coins_1", "coins-one", ""]) {
    assertStrictEquals(parsePluralKey(key), undefined, key);
  }
  for (const base of ["coins", "a_b", "_", "\u{1f389}", "a.b", "x_ordinal_"]) {
    for (const kind of ["plural", "ordinal"] as const) {
      for (const category of PLURAL_CATEGORIES) {
        const key = pluralKeyName(base, kind, category);
        assertEquals(parsePluralKey(key), { base, kind, category }, key);
      }
    }
  }
  // A cardinal group can't have a base ending in `_ordinal`: its keys read as ordinal keys.
  assertEquals(parsePluralKey(pluralKeyName("x_ordinal", "plural", "one")), {
    base: "x",
    kind: "ordinal",
    category: "one",
  });
  assertEquals(parsePluralKey(pluralKeyName("x_ordinal", "ordinal", "one"))?.base, "x_ordinal");
  assertEquals(pluralKeyName("place", "ordinal", "two"), "place_ordinal_two");
  assertEquals(pluralKeyName("coins", "plural", "many"), "coins_many");
});

// readSource: strings

test("readSource makes empty and whitespace-only strings literals", () => {
  const values = ["", " ", "\t", "\n  ", "\u00a0", "\u3000", "\u2028", " \r\n "];
  for (const value of values) {
    const entries = read(JSON.stringify({ s: value }));
    assertEquals(summary(entries), ['literal ["s"]'], JSON.stringify(value));
    assertEquals(literal(entries, ["s"]), JSON.stringify(value));
  }
  assertEquals(summary(read('{"s": " x "}')), ['text ["s"]']);
  assertEquals(summary(read('{"s": "\\u200b"}')), ['text ["s"]']);
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
    assertEquals(summary(read(JSON.stringify({ s: value }))), ['reference ["s"]'], value);
    assert(isReferenceOnly(value), value);
  }
  const texts = ["$t(a)!", "$t(a) {{b}}", "$t(", "$t(a", "t(a)", "{{count}}", "Go: $t(a)", "$T(a)"];
  for (const value of texts) {
    assertEquals(summary(read(JSON.stringify({ s: value }))), ['text ["s"]'], value);
    assert(!isReferenceOnly(value), value);
  }
  assert(isReferenceOnly('$t(a, {"n": %{n}})', { prefix: "%{", suffix: "}" }));
  assert(!isReferenceOnly("$t(a) %{n}", { prefix: "%{", suffix: "}" }));
  assert(!isReferenceOnly("$t(a) {{n}}", { prefix: "%{", suffix: "}" }));
});

test("readSource passes the interpolation syntax to the tokenizer", () => {
  const syntax = { prefix: "__", suffix: "__" };
  assertEquals(summary(read('{"s": "$t(a) __n__"}', { syntax })), ['text ["s"]']);
  assertEquals(summary(read('{"s": "$t(a, {\\"n\\": __n__})"}', { syntax })), ['reference ["s"]']);
});

// readSource: literals and structure

test("readSource keeps number spelling and nested empty containers", () => {
  const entries = read(
    '{"n": [0, -0, 1.0, 1E-7, 123456789012345678901234567890, -12.5e+10], "a": {"b": {}, "c": [[]]}}',
  );
  assertEquals(
    entries.map((entry) => (entry as LiteralEntry).raw),
    ["0", "-0", "1.0", "1E-7", "123456789012345678901234567890", "-12.5e+10", "{}", "[]"],
  );
  assertEquals(entries.at(-1)?.keyPath, ["a", "c", 0]);
});

test("readSource gives no entries for an empty root object", () => {
  assertEquals(readSource("{}").entries, []);
  assertEquals(readSource("\ufeff{ }\r\n").entries, []);
  assertEquals(readSource("{}").format, { indent: "", newline: "\n", finalNewline: false });
});

test("readSource entries are plain data", () => {
  const entries = read(enCommon);
  assertEquals(JSON.parse(JSON.stringify(entries)), entries);
  assertEquals(withoutLines(entries).length, 35);
});

// readSource: errors

test("readSource refuses a root that isn't an object", () => {
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
    const error = assertThrows(() => readSource(text, { file: "en/x.json" }), SourceError);
    assertEquals(error.code, "not_an_object");
    assertEquals(error.detail, `The file must contain a JSON object, not ${found}`);
    assertEquals([error.file, error.line, error.column], ["en/x.json", line, column], text);
    assertEquals(error.message, `en/x.json:${line}:${column}: ${error.detail}`);
  }
});

test("readSource reports JSON syntax errors with the file, line and column", () => {
  const text = ["{", '  "a": "b",', '  "c" "d"', "}"];
  for (const newline of ["\n", "\r\n"]) {
    const error = assertThrows(
      () => readSource(text.join(newline), { file: "en/common.json" }),
      JsonSyntaxError,
    );
    assertEquals(
      [error.code, error.file, error.line, error.column],
      ["syntax", "en/common.json", 3, 7],
    );
    assert(error.message.startsWith("en/common.json:3:7: "), error.message);
  }
  const emoji = assertThrows(() => readSource('{"\u{1f600}": x}'), JsonSyntaxError);
  assertEquals([emoji.line, emoji.column], [1, 8]);
  const end = assertThrows(() => readSource('{"a": "b"'), JsonSyntaxError);
  assertEquals(end.detail, "Unexpected end of file");
  assertInstanceOf(
    assertThrows(() => readSource("")),
    JsonSyntaxError,
  );
});

test("readSource reports duplicate keys with their path", () => {
  const text = ["{", '  "menu": {', '    "play": "Play",', '    "play": "Again"', "  }", "}"];
  const error = assertThrows(
    () => readSource(text.join("\n"), { file: "en.json" }),
    JsonSyntaxError,
  );
  assertEquals(error.code, "duplicate_key");
  assertEquals(error.keyPath, ["menu", "play"]);
  assertEquals([error.file, error.line, error.column], ["en.json", 4, 5]);
  assertEquals(error.detail, 'Duplicate key "play" at menu.play');
});

test("SourceError formats its position", () => {
  const error = new SourceError("key_conflict", "Two entries", {
    file: "a.json",
    keyPath: ["x"],
    line: 3,
    column: 4,
  });
  assertEquals(error.message, "a.json:3:4: Two entries");
  assertEquals(error.name, "SourceError");
  assertEquals(new SourceError("key_conflict", "x", { line: 2 }).message, "<input>:2:1: x");
  assertEquals(new SourceError("not_an_object", "x", { file: "f" }).message, "f: x");
});

test("entryValue gives the value of text and plural entries only", () => {
  const entries = read(enAppendix, APPENDIX_OPTIONS);
  assertEquals(entryValue(find(entries, "text", ["title"])), "Field Guide");
  assertEquals(entryValue(find(entries, "plural", ["lap"])), {
    one: "{{count}} lap",
    other: "{{count}} laps",
  });
  assertStrictEquals(entryValue(find(entries, "reference", ["back"])), undefined);
  assertStrictEquals(entryValue(find(entries, "literal", ["tags"])), undefined);
});

// readTranslation

test("readTranslation reads an existing translation file for an import", () => {
  const english = read(enCommon);
  const result = readTranslation(importedPlCommon, english, {
    language: "pl",
    file: "pl/common.json",
  });
  assertEquals(result.unknownKeys, [
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
  assertEquals([...result.values.keys()], [...expected.keys()]);
  assertEquals(result.values, expected);
  const forms = result.values.get('["trip","daysLeft"]#plural') as Record<string, string>;
  assertEquals(Object.keys(forms), ["one", "few", "many", "other"]);
});

test("readTranslation reads forms of any category, whatever the language needs", () => {
  const english = read(enAppendix, APPENDIX_OPTIONS);
  const withOne = jaAppendix.replace(
    '"coins_other": "\u30b3\u30a4\u30f3{{count}}\u679a",',
    '"coins_one": "\u30b3\u30a4\u30f31\u679a",\n    "coins_other": "\u30b3\u30a4\u30f3{{count}}\u679a",',
  );
  const result = readTranslation(withOne, english, { language: "ja" });
  assertEquals(result.unknownKeys, []);
  assertEquals(result.values.get('["inventory","coins"]#plural'), {
    one: "\u30b3\u30a4\u30f31\u679a",
    other: "\u30b3\u30a4\u30f3{{count}}\u679a",
  });
  assertEquals(result.values.get('["messages"]#plural'), {
    zero: "\u65b0\u7740\u30e1\u30c3\u30bb\u30fc\u30b8\u306f\u3042\u308a\u307e\u305b\u3093",
    other:
      "\u65b0\u7740\u30e1\u30c3\u30bb\u30fc\u30b8\u304c{{count}}\u4ef6\u3042\u308a\u307e\u3059",
  });
  // The language and override don't change what is read.
  assertEquals(
    readTranslation(withOne, english, { language: "ar", pluralOverride: { cardinal: ["other"] } }),
    result,
  );
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
  assertEquals(result.values, new Map());
  assertEquals(result.unknownKeys, []);
  const empty = readPl('{"nav": {}, "hints": [], "grid": [[]], "coins_one": "x"}', english);
  assertEquals(empty.unknownKeys, []);
  assertEquals(empty.values, new Map([['["coins"]#plural', { one: "x" }]]));
});

test("readTranslation skips an array where English has an object, and the reverse", () => {
  // Regression: the values were reported as unknown keys that display like English ones.
  const english = read('{"levels": {"0": "Easy", "1": "Hard"}, "hints": ["Easy", "Hard"]}');
  const swapped = readPl(
    '{"levels": ["Łatwy", "Trudny"], "hints": {"0": "Łatwy", "1": "Trudny"}}',
    english,
  );
  assertEquals(swapped, { values: new Map(), unknownKeys: [] });
  // Deeper down too, and with the right types the values are read.
  const nested = read('{"a": {"b": {"0": "x"}, "c": [["y"]]}}');
  assertEquals(readPl('{"a": {"b": ["x"], "c": [{"0": "y"}]}}', nested).unknownKeys, []);
  assertEquals(
    [...readPl('{"a": {"b": {"0": "X"}, "c": [["Y"]]}}', nested).values.values()],
    ["X", "Y"],
  );
});

test("readTranslation reports what fills an object or array English has empty", () => {
  // Regression: values inside were silently ignored.
  const english = read('{"extra": {}, "list": [], "deep": {"x": [{}]}}');
  const result = readPl(
    '{"extra": {"a": "b", "c_one": "d", "c_few": "e"}, "list": ["x", []], "deep": {"x": [{"y": 1}]}}',
    english,
  );
  assertEquals(result.unknownKeys, [
    "extra.a",
    "extra.c_one",
    "extra.c_few",
    "list.0",
    "list.1",
    "deep.x.0.y",
  ]);
  assertEquals(result.values, new Map());
  // Empty ones, or values of another type, are fine.
  assertEquals(
    readPl('{"extra": {}, "list": {"a": 1}, "deep": {"x": [[]]}}', english).unknownKeys,
    [],
  );
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
  assertEquals(result, { values: new Map(), unknownKeys: ["other_one"] });
});

test("readTranslation reads deeply nested files in linear time", () => {
  // Regression: every entry's key path prefixes were serialized, O(n·d²).
  const depth = 250;
  const members = Array.from({ length: 20_000 }, (_, i) => `"k${i}": "v${i}"`).join(",");
  const text = '{"a":'.repeat(depth - 1) + `{${members}}` + "}".repeat(depth - 1);
  const { entries } = readSource(text);
  assertEquals(entries.length, 20_000);
  assertEquals(entries[0].keyPath.length, depth);
  const started = performance.now();
  const result = readTranslation("{}", entries, { language: "pl" });
  const elapsed = performance.now() - started;
  assertEquals(result, { values: new Map(), unknownKeys: [] });
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
  assertEquals(result.unknownKeys, [
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
  assertEquals(
    result.values,
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
  assertEquals(result.unknownKeys, []);
  assertEquals(result.values, new Map([['["t"]', "Tekst"]]));
});

test("readTranslation keeps empty strings and returns values in English order", () => {
  const english = read('{"a": "A", "b_one": "x", "b_other": "y", "c": "C"}');
  const result = readPl(
    '{"c": "", "b_other": "Y", "b_many": "M", "b_one": "X", "a": " "}',
    english,
  );
  assertEquals(
    [...result.values.entries()],
    [
      ['["a"]', " "],
      ['["b"]#plural', { one: "X", many: "M", other: "Y" }],
      ['["c"]', ""],
    ],
  );
  assertEquals(Object.keys(result.values.get('["b"]#plural') as object), ["one", "many", "other"]);
});

test("readTranslation reads CRLF files and Unicode keys", () => {
  const english = read(enAppendix, APPENDIX_OPTIONS);
  const crlf = jaAppendix.replaceAll("\n", "\r\n");
  const result = readTranslation(crlf, english, { language: "ja" });
  assertEquals(result.unknownKeys, []);
  assertEquals(result, readTranslation(jaAppendix, english, { language: "ja" }));
  assertEquals(result.values.get('["\u65e5\u672c\u8a9e"]'), "\u65e5\u672c\u8a9e");
  assertEquals(
    result.values.get('["unicode","escapes"]'),
    "\u4e00\u884c\u76ee\n\u4e8c\u884c\u76ee\t\u30bf\u30d6 \u0001",
  );
});

test("readTranslation refuses files that aren't JSON objects", () => {
  const english = read('{"a": "A"}');
  const root = assertThrows(
    () => readTranslation('["A"]', english, { language: "pl", file: "pl/a.json" }),
    SourceError,
  );
  assertEquals(
    [root.code, root.message],
    ["not_an_object", "pl/a.json:1:1: The file must contain a JSON object, not an array"],
  );
  const syntax = assertThrows(
    () => readTranslation('{\n  "a": "A",\n}', english, { language: "pl", file: "pl/a.json" }),
    JsonSyntaxError,
  );
  assertEquals([syntax.file, syntax.line, syntax.column], ["pl/a.json", 2, 11]);
  const duplicate = assertThrows(
    () => readTranslation('{"a": "A", "a": "B"}', english, { language: "pl" }),
    JsonSyntaxError,
  );
  assertEquals(duplicate.code, "duplicate_key");
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
  assertEquals(entries.length, 400 * 50);
  assert(elapsed < 2000, `took ${elapsed} ms`);
  const translated = readTranslation(text, entries, { language: "pl" });
  assertEquals(translated.values.size, entries.length);
  assert(performance.now() - start < 4000);
});
