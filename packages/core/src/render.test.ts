// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@quaso/runtime/assert";
import {
  parsePluralKey,
  type PluralEntry,
  readSource,
  readTranslation,
  type SourceEntry,
  SourceError,
} from "./entries.ts";
import {
  DEFAULT_FORMAT,
  type JsonFormat,
  type JsonMember,
  type JsonNode,
  type JsonObject,
  parseJson,
  stringifyJson,
  toPlain,
} from "./json.ts";
import { categoriesFor } from "./plurals.ts";
import { renderFile } from "./render.ts";
import {
  entryKey,
  type KeyPath,
  PLURAL_CATEGORIES,
  type PluralForms,
  type TextValue,
} from "./types.ts";
const arAppendix = await Bun.file(
  new URL("../testdata/i18next/ar/appendix.json", import.meta.url),
).text();
const enAppendix = await Bun.file(
  new URL("../testdata/i18next/en/appendix.json", import.meta.url),
).text();
const enCommon = await Bun.file(
  new URL("../testdata/i18next/en/common.json", import.meta.url),
).text();
const enHud = await Bun.file(
  new URL("../testdata/i18next/en/hud.json.txt", import.meta.url),
).text();
const enMenus = await Bun.file(
  new URL("../testdata/i18next/en/menus.json.txt", import.meta.url),
).text();
const enStore = await Bun.file(
  new URL("../testdata/i18next/en/store.json.txt", import.meta.url),
).text();
const frAppendix = await Bun.file(
  new URL("../testdata/i18next/fr/appendix.json", import.meta.url),
).text();
const frMenus = await Bun.file(
  new URL("../testdata/i18next/fr/menus.json.txt", import.meta.url),
).text();
const importedPlCommon = await Bun.file(
  new URL("../testdata/i18next/import/pl/common.json.txt", import.meta.url),
).text();
const jaAppendix = await Bun.file(
  new URL("../testdata/i18next/ja/appendix.json", import.meta.url),
).text();
const plAppendix = await Bun.file(
  new URL("../testdata/i18next/pl/appendix.json", import.meta.url),
).text();
const plCommon = await Bun.file(
  new URL("../testdata/i18next/pl/common.json", import.meta.url),
).text();
const plMenus = await Bun.file(
  new URL("../testdata/i18next/pl/menus.json.txt", import.meta.url),
).text();

/*
 * Golden files live in packages/core/testdata/i18next/<language>/. Files that `bun run fmt`
 * would reformat (4-space or tab indentation, CRLF, one line) end in `.json.txt` so that
 * their bytes stay as they are; testdata/.gitattributes keeps git from converting their line
 * endings.
 */

/** The English golden files, with the read options they need. */
const ENGLISH = {
  appendix: { text: enAppendix, options: { pluralExclusions: ["menu.player"] } },
  common: { text: enCommon, options: {} },
  menus: { text: enMenus, options: {} },
  hud: { text: enHud, options: {} },
  store: { text: enStore, options: {} },
};

// Helpers

/** Reads an English golden file. */
function english(name: keyof typeof ENGLISH) {
  const { text, options } = ENGLISH[name];
  return readSource(text, { file: `en/${name}.json`, ...options });
}

/** Renders `lines` (English, joined with `\n`) in a language with some translations. */
function render(
  lines: string[] | string,
  language: string,
  translations: [string, TextValue][] = [],
): string {
  const { entries, format } = readSource(typeof lines === "string" ? lines : lines.join("\n"));
  return renderFile(entries, new Map(translations), { language, format });
}

/** The keys of the object at `path` in a rendered file, in order. */
function keysAt(text: string, path: KeyPath = []): string[] {
  let node: JsonNode = parseJson(text).root;
  for (const segment of path) {
    if (node.type === "object") node = node.members.find((m) => m.key === segment)!.value;
    else if (node.type === "array") node = node.items[segment as number];
  }
  assert(node.type === "object");
  return node.members.map((member) => member.key);
}

/** A rendered file as a plain value. */
function plain(text: string): Record<string, unknown> {
  return toPlain(parseJson(text).root) as Record<string, unknown>;
}

// Golden files

test("renderFile reproduces every English golden file byte for byte", () => {
  for (const name of Object.keys(ENGLISH) as (keyof typeof ENGLISH)[]) {
    const { text } = ENGLISH[name];
    const { entries, format } = english(name);
    const rendered = renderFile(entries, new Map(), { language: "en", format });
    const expected = format.finalNewline ? text : text + format.newline;
    assertStrictEquals(rendered, expected, name);
  }
  // The tab-indented file has no final newline and gains one; the others are unchanged.
  assert(!enHud.endsWith("\n"));
  assertEquals(english("menus").format, { indent: "    ", newline: "\r\n", finalNewline: true });
  assertEquals(english("store").format, { indent: "", newline: "\n", finalNewline: true });
});

test("renderFile writes the translation golden files from their own translations", () => {
  const cases: [string, keyof typeof ENGLISH, string][] = [
    ["pl", "appendix", plAppendix],
    ["ja", "appendix", jaAppendix],
    ["ar", "appendix", arAppendix],
    ["fr", "appendix", frAppendix],
    ["pl", "menus", plMenus],
    ["fr", "menus", frMenus],
  ];
  for (const [language, name, text] of cases) {
    const { entries, format } = english(name);
    const { values, unknownKeys } = readTranslation(text, entries, { language });
    assertEquals(unknownKeys, [], `${language}/${name}`);
    const rendered = renderFile(entries, values, { language, format });
    assertStrictEquals(rendered, text, `${language}/${name}`);
  }
});

test("renderFile writes an imported translation in the English structure", () => {
  const { entries, format } = english("common");
  const { values } = readTranslation(importedPlCommon, entries, { language: "pl" });
  const rendered = renderFile(entries, values, { language: "pl", format });
  assertStrictEquals(rendered, plCommon);
  // The import was 4-space indented, in another order; the output follows English.
  assertEquals(keysAt(rendered, ["nav"]), keysAt(enCommon, ["nav"]));
});

// Plural forms by language

test("renderFile writes Polish plural forms in CLDR order at the group's position", () => {
  const { entries, format } = english("appendix");
  const rendered = renderFile(entries, new Map(), { language: "pl", format });
  assertEquals(keysAt(rendered, ["inventory"]), [
    "coins",
    "coins_one",
    "coins_few",
    "coins_many",
    "coins_other",
    "gems_one",
    "gems_few",
    "gems_many",
    "gems_other",
    "leftovers_other",
  ]);
  const top = keysAt(rendered);
  const start = top.indexOf("collected");
  assertEquals(top.slice(start, start + 16), [
    "collected",
    "inventory",
    "messages_zero",
    "messages_one",
    "messages_few",
    "messages_many",
    "messages_other",
    "lap_one",
    "lap_few",
    "lap_many",
    "lap_other",
    "lap_ordinal_other",
    "place_ordinal_other",
    "greeting_male",
    "greeting_female",
    "ally_male_one",
  ]);
  assertEquals(keysAt(rendered, ["tutorial", 1]), [
    "title",
    "body",
    "offers_one",
    "offers_few",
    "offers_many",
    "offers_other",
  ]);
});

const PLURAL_SOURCE = [
  "{",
  '  "before": "Before",',
  '  "coins_one": "{{count}} coin",',
  '  "coins_other": "{{count}} coins",',
  '  "messages_zero": "No messages",',
  '  "messages_one": "One message",',
  '  "messages_other": "{{count}} messages",',
  '  "place_ordinal_one": "{{count}}st",',
  '  "place_ordinal_two": "{{count}}nd",',
  '  "place_ordinal_few": "{{count}}rd",',
  '  "place_ordinal_other": "{{count}}th",',
  '  "after": "After"',
  "}",
];

test("renderFile writes the plural forms each language needs", () => {
  const cardinal = (base: string, categories: string[]) => categories.map((c) => `${base}_${c}`);
  const ordinal = (categories: string[]) => categories.map((c) => `place_ordinal_${c}`);
  const all = ["zero", "one", "two", "few", "many", "other"];
  const cases: [string, string[]][] = [
    [
      "en",
      [
        ...cardinal("coins", ["one", "other"]),
        ...cardinal("messages", ["zero", "one", "other"]),
        ...ordinal(["one", "two", "few", "other"]),
      ],
    ],
    [
      "pl",
      [
        ...cardinal("coins", ["one", "few", "many", "other"]),
        ...cardinal("messages", ["zero", "one", "few", "many", "other"]),
        ...ordinal(["other"]),
      ],
    ],
    [
      "ja",
      [
        ...cardinal("coins", ["other"]),
        ...cardinal("messages", ["zero", "other"]),
        ...ordinal(["other"]),
      ],
    ],
    ["ar", [...cardinal("coins", all), ...cardinal("messages", all), ...ordinal(["other"])]],
    [
      "fr",
      [
        ...cardinal("coins", ["one", "many", "other"]),
        ...cardinal("messages", ["zero", "one", "many", "other"]),
        ...ordinal(["one", "other"]),
      ],
    ],
    ["cy", [...cardinal("coins", all), ...cardinal("messages", all), ...ordinal(all)]],
    [
      "pt-BR",
      [
        ...cardinal("coins", ["one", "many", "other"]),
        ...cardinal("messages", ["zero", "one", "many", "other"]),
        ...ordinal(["other"]),
      ],
    ],
  ];
  for (const [language, keys] of cases) {
    assertEquals(keysAt(render(PLURAL_SOURCE, language)), ["before", ...keys, "after"], language);
  }
});

test("renderFile gives every language a zero form when English has one", () => {
  for (const language of ["ja", "pl", "fr", "de", "ru", "zh", "ar", "lv"]) {
    const rendered = plain(render(PLURAL_SOURCE, language));
    assertEquals(rendered.messages_zero, "No messages", language);
    // Arabic and Latvian have a zero form of their own, filled from English `other`.
    const native = language === "ar" || language === "lv";
    assertStrictEquals(rendered.coins_zero, native ? "{{count}} coins" : undefined, language);
  }
  // An ordinal group never gets an extra zero form.
  const ordinal = render('{"x_ordinal_zero": "0th", "x_ordinal_other": "nth"}', "ja");
  assertEquals(keysAt(ordinal), ["x_ordinal_other"]);
});

test("renderFile follows a plural override", () => {
  const { entries, format } = readSource(PLURAL_SOURCE.join("\n"));
  const rendered = renderFile(entries, new Map(), {
    language: "pl",
    format,
    pluralOverride: { cardinal: ["one", "few", "other"], ordinal: ["one", "other"] },
  });
  assertEquals(keysAt(rendered), [
    "before",
    "coins_one",
    "coins_few",
    "coins_other",
    "messages_zero",
    "messages_one",
    "messages_few",
    "messages_other",
    "place_ordinal_one",
    "place_ordinal_other",
    "after",
  ]);
});

// Fallbacks (FMT-2)

test("renderFile fills missing forms from English: same category, then other", () => {
  const rendered = plain(
    render(PLURAL_SOURCE, "ar", [
      ['["coins"]#plural', { two: "\u0639\u0645\u0644\u062a\u0627\u0646", few: "" }],
      ['["messages"]#plural', { other: "{{count}} \u0631\u0633\u0627\u0644\u0629" }],
    ]),
  );
  assertEquals(rendered.coins_zero, "{{count}} coins");
  assertEquals(rendered.coins_one, "{{count}} coin");
  assertEquals(rendered.coins_two, "\u0639\u0645\u0644\u062a\u0627\u0646");
  assertEquals(rendered.coins_few, "");
  assertEquals(rendered.coins_many, "{{count}} coins");
  assertEquals(rendered.coins_other, "{{count}} coins");
  assertEquals(rendered.messages_zero, "No messages");
  assertEquals(rendered.messages_one, "One message");
  assertEquals(rendered.messages_many, "{{count}} messages");
  assertEquals(rendered.messages_other, "{{count}} \u0631\u0633\u0627\u0644\u0629");
});

test("renderFile uses English forms of categories English doesn't need", () => {
  // Written by hand with a `few` form English doesn't use: Polish gets it as its fallback.
  const source = '{"x_one": "one", "x_few": "few", "x_other": "other"}';
  assertEquals(plain(render(source, "pl", [['["x"]#plural', { one: "jeden" }]])), {
    x_one: "jeden",
    x_few: "few",
    x_many: "other",
    x_other: "other",
  });
  // English itself drops the form it doesn't need.
  assertEquals(keysAt(render(source, "en")), ["x_one", "x_other"]);
});

test("renderFile ignores translation forms the language doesn't need", () => {
  const rendered = render(PLURAL_SOURCE, "ja", [
    ['["coins"]#plural', { one: "1\u679a", other: "{{count}}\u679a", few: "x" }],
  ]);
  assertEquals(plain(rendered).coins_other, "{{count}}\u679a");
  assert(!rendered.includes("1\u679a"));
});

test("renderFile keeps English for untranslated strings and values of the wrong shape", () => {
  const source = [
    "{",
    '  "title": "Title",',
    '  "subtitle": "Subtitle",',
    '  "body": "Body",',
    '  "coins_one": "{{count}} coin",',
    '  "coins_other": "{{count}} coins"',
    "}",
  ];
  const rendered = plain(
    render(source, "fr", [
      ['["title"]', "Titre"],
      ['["subtitle"]', { one: "Sous-titre" }],
      ['["coins"]#plural', "{{count}} pi\u00e8ces"],
      ['["coins"]', "Pi\u00e8ces"],
      ['["body"]#plural', { other: "Corps" }],
      ['["unknown"]', "Inconnu"],
    ]),
  );
  assertEquals(rendered, {
    title: "Titre",
    subtitle: "Subtitle",
    body: "Body",
    coins_one: "{{count}} coin",
    coins_many: "{{count}} coins",
    coins_other: "{{count}} coins",
  });
});

test("renderFile writes empty translations as they are", () => {
  assertEquals(plain(render('{"a": "A"}', "de", [['["a"]', ""]])), { a: "" });
});

// Structure, references and literals

test("renderFile keeps arrays' length and order, element by element", () => {
  const source = '{"hints": ["One", ["Two", {"t": "Three"}], "$t(tip)", 4, [], {}], "end": "End"}';
  const rendered = render(source, "de", [
    ['["hints",1,1,"t"]', "Drei"],
    ['["hints",0]', "Eins"],
  ]);
  assertEquals(plain(rendered), {
    hints: ["Eins", ["Two", { t: "Drei" }], "$t(tip)", 4, [], {}],
    end: "End",
  });
  assertEquals(keysAt(rendered), ["hints", "end"]);
});

test("renderFile copies references and literals from English", () => {
  const source = [
    "{",
    '  "back": "$t(common:back)",',
    '  "both": "$t(a) $t(b)",',
    '  "n": [',
    "    1.50,",
    "    1e3,",
    "    -0,",
    "    2E+5,",
    "    123456789012345678901234567890",
    "  ],",
    '  "flags": [',
    "    true,",
    "    false,",
    "    null",
    "  ],",
    '  "empty": "",',
    '  "blank": " \\t ",',
    '  "obj": {},',
    '  "arr": []',
    "}",
  ].join("\n");
  const rendered = render(source, "pl", [
    ['["back"]', "$t(common:wstecz)"],
    ['["n",0]', "2"],
    ['["empty"]', "pusty"],
    ['["obj"]', "x"],
  ]);
  assertStrictEquals(rendered, source + "\n");
});

test("renderFile keeps the English format and always ends with a newline", () => {
  const source = '{"a": {"b": ["c"]}}';
  const formats: [JsonFormat, string][] = [
    [DEFAULT_FORMAT, '{\n  "a": {\n    "b": [\n      "c"\n    ]\n  }\n}\n'],
    [
      { indent: "\t", newline: "\r\n", finalNewline: false },
      '{\r\n\t"a": {\r\n\t\t"b": [\r\n\t\t\t"c"\r\n\t\t]\r\n\t}\r\n}\r\n',
    ],
    [{ indent: "", newline: "\n", finalNewline: false }, '{"a":{"b":["c"]}}\n'],
    [
      { indent: "   ", newline: "\n", finalNewline: true },
      '{\n   "a": {\n      "b": [\n         "c"\n      ]\n   }\n}\n',
    ],
  ];
  const { entries } = readSource(source);
  for (const [format, expected] of formats) {
    assertStrictEquals(renderFile(entries, new Map(), { language: "en", format }), expected);
  }
});

test("renderFile keeps the lines of English files without indentation", () => {
  // Regression: a multi-line English file without indented lines was written on one line.
  const cases: [string, string][] = [
    ['{\n"play": "Play",\n"menu": {\n"quit": "Quit"\n}\n}\n', "pl"],
    ['{\r\n"play": "Play",\r\n"quit": "Quit"\r\n}\r\n', "ja"],
    [
      '{\r  "play": "Play",\r  "coins_one": "{{count}} coin",\r  "coins_other": "{{count}} coins"\r}\r',
      "en",
    ],
  ];
  for (const [text, language] of cases) {
    assertStrictEquals(render(text, "en"), text, JSON.stringify(text));
    const rendered = render(text, language, [['["play"]', "Graj"]]);
    assertEquals(plain(rendered).play, "Graj");
    const newline = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
    assertEquals(rendered.split(newline).length, text.split(newline).length);
  }
  assertStrictEquals(
    render('{\n"coins_one": "{{count}} coin",\n"coins_other": "{{count}} coins"\n}', "pl"),
    '{\n"coins_one": "{{count}} coin",\n"coins_few": "{{count}} coins",\n' +
      '"coins_many": "{{count}} coins",\n"coins_other": "{{count}} coins"\n}\n',
  );
});

test("renderFile writes raw Unicode and escapes only what JSON needs", () => {
  const rendered = render('{\n  "a": "A",\n  "b": "B"\n}', "ja", [
    ['["a"]', "\u{1f389} Cafe\u0301 \u65e5\u672c \u0645\u0631\u062d\u0628\u0627 \u00a0\u2028"],
    ['["b"]', 'q"\\\n\t\u0001 \ud800'],
  ]);
  assertStrictEquals(
    rendered,
    '{\n  "a": "\u{1f389} Cafe\u0301 \u65e5\u672c \u0645\u0631\u062d\u0628\u0627 \u00a0\u2028",\n  "b": "q\\"\\\\\\n\\t\\u0001 \\ud800"\n}\n',
  );
});

test("renderFile writes an empty object when there are no entries", () => {
  assertStrictEquals(renderFile([], new Map(), { language: "pl", format: DEFAULT_FORMAT }), "{}\n");
  assertStrictEquals(render("{}", "pl"), "{}\n");
});

test("renderFile is deterministic, whatever the order of the translations", () => {
  const { entries, format } = english("appendix");
  const { values } = readTranslation(plAppendix, entries, { language: "pl" });
  const reversed = new Map([...values.entries()].reverse());
  const first = renderFile(entries, values, { language: "pl", format });
  assertStrictEquals(renderFile(entries, reversed, { language: "pl", format }), first);
  assertStrictEquals(renderFile(entries, values, { language: "pl", format }), first);
});

test("renderFile places array elements by index and fills gaps with null", () => {
  const entries: SourceEntry[] = [
    { kind: "text", keyPath: ["list", 2], value: "c" },
    { kind: "text", keyPath: ["list", 0], value: "a" },
    { kind: "text", keyPath: ["title"], value: "T" },
  ];
  assertStrictEquals(
    renderFile(entries, new Map(), { language: "en", format: { ...DEFAULT_FORMAT, indent: "" } }),
    '{"list":["a",null,"c"],"title":"T"}\n',
  );
});

test("renderFile refuses entries whose key paths clash", () => {
  const text = (keyPath: KeyPath): SourceEntry => ({ kind: "text", keyPath, value: "x" });
  const plural = (keyPath: KeyPath): SourceEntry => ({
    kind: "plural",
    keyPath,
    forms: { one: "a", other: "b" },
  });
  const cases: SourceEntry[][] = [
    [text(["a"]), text(["a"])],
    [text(["a"]), text(["a", "b"])],
    [text(["a", "b"]), text(["a"])],
    [text(["a", 0]), text(["a", "b"])],
    [text(["a", "b"]), text(["a", 0])],
    [text([0])],
    [text([])],
    [plural(["list", 0])],
    [text(["coins_few"]), plural(["coins"])],
    [{ kind: "literal", keyPath: ["a"], raw: "[]" }, text(["a", "b"])],
  ];
  for (const entries of cases) {
    const error = assertThrows(
      () => renderFile(entries, new Map(), { language: "pl", format: DEFAULT_FORMAT }),
      SourceError,
    );
    assertEquals(error.code, "key_conflict", JSON.stringify(entries));
  }
  // English's `coins_few` is fine when the language doesn't write that key.
  assertStrictEquals(
    renderFile([text(["coins_few"]), plural(["coins"])], new Map(), {
      language: "en",
      format: { ...DEFAULT_FORMAT, indent: "" },
    }),
    '{"coins_few":"x","coins_one":"a","coins_other":"b"}\n',
  );
});

test("renderFile extends objects and arrays that came from literals", () => {
  const entries: SourceEntry[] = [
    { kind: "literal", keyPath: ["a"], raw: "{}" },
    { kind: "text", keyPath: ["a", "b"], value: "B" },
    { kind: "literal", keyPath: ["c"], raw: "[]" },
    { kind: "text", keyPath: ["c", 0], value: "C" },
  ];
  assertStrictEquals(
    renderFile(entries, new Map(), { language: "en", format: { ...DEFAULT_FORMAT, indent: "" } }),
    '{"a":{"b":"B"},"c":["C"]}\n',
  );
});

// Property tests

/** A small deterministic pseudo-random generator (xorshift32). */
class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 1;
  }

  /** A number in [0, 1). */
  next(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;
    return this.#state / 4294967296;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

/** Pieces of strings: words, tokens, escapes, controls, combining marks, surrogates. */
const TEXT_PIECES = [
  "Play",
  "coins",
  "the ",
  " ",
  "  ",
  "{{count}}",
  "{{name, uppercase}}",
  "{{- html}}",
  "$t(common:back)",
  '$t(key, {"count": {{n}}})',
  "$t(",
  "\u00e9",
  "e\u0301",
  "\u{1f389}",
  "\u{1f469}\u200d\u{1f467}",
  "\ud835\udcb3",
  "\u65e5\u672c",
  "\u0645\u0631\u062d\u0628\u0627",
  '"',
  "\\",
  "\n",
  "\r\n",
  "\t",
  "\u0001",
  "\u001f",
  "\u00a0",
  "\u2028",
  "\ud800",
  "\u27e61\u27e7",
  "_other",
  ".",
];

/** Pieces of keys, including dots, digits, Unicode and near-plural suffixes. */
const KEY_PIECES = [
  "a",
  "title",
  "menu",
  "x",
  "\u65e5\u672c",
  "\u043a\u043b\u044e\u0447",
  "\u{1f389}",
  "a.b",
  "v1.2",
  "10",
  "2",
  "0",
  "_",
  "-",
  " ",
  "e\u0301",
  "ordinal",
  "one",
  "few",
  '"',
  "\\",
];

const NUMBERS = ["0", "-0", "1", "1.50", "1e3", "2E+5", "-0.25", "1E-7", "123456789012345678901"];
const LANGUAGES = ["en", "pl", "ja", "ar", "fr", "ru", "cy", "de", "it", "lv", "zh", "pt-BR"];
const FORMATS: JsonFormat[] = [
  { indent: "  ", newline: "\n", finalNewline: true },
  { indent: "    ", newline: "\r\n", finalNewline: true },
  { indent: "\t", newline: "\n", finalNewline: false },
  { indent: "", newline: "\n", finalNewline: true },
  { indent: "", newline: "\n", finalNewline: false },
  { indent: "", newline: "\r\n", finalNewline: true, multiline: true },
  { indent: " ", newline: "\r", finalNewline: true },
];

function randomString(random: Random): string {
  const parts: string[] = [];
  const count = random.int(6);
  for (let i = 0; i < count; i++) parts.push(random.pick(TEXT_PIECES));
  return parts.join("");
}

/** A key that isn't named like a plural key. */
function randomKey(random: Random): string {
  const parts: string[] = [];
  const count = 1 + random.int(3);
  for (let i = 0; i < count; i++) parts.push(random.pick(KEY_PIECES));
  const key = parts.join("");
  return parsePluralKey(key) === undefined ? key : `${key}~`;
}

function stringNode(value: string): JsonNode {
  return { type: "string", value };
}

/** Builds random English documents whose plural groups are as English needs them. */
class DocumentGenerator {
  readonly #random: Random;
  #lone = 0;

  constructor(random: Random) {
    this.#random = random;
  }

  document(): JsonObject {
    return this.object(0, this.#random.int(8));
  }

  private value(depth: number): JsonNode {
    const random = this.#random;
    const roll = random.next();
    if (depth < 4 && roll < 0.2) return this.object(depth + 1, random.int(5));
    if (depth < 4 && roll < 0.35) return this.array(depth + 1);
    if (roll < 0.75) return stringNode(randomString(random));
    return this.literal();
  }

  private literal(): JsonNode {
    const random = this.#random;
    const roll = random.int(5);
    if (roll === 0) return { type: "boolean", value: random.chance(0.5) };
    if (roll === 1) return { type: "null" };
    return { type: "number", raw: random.pick(NUMBERS) };
  }

  private array(depth: number): JsonNode {
    const items: JsonNode[] = [];
    const count = this.#random.int(4);
    for (let i = 0; i < count; i++) items.push(this.value(depth));
    return { type: "array", items };
  }

  /** An object with plain members, plural groups and keys that only look like plurals. */
  private object(depth: number, size: number): JsonObject {
    const random = this.#random;
    const members: JsonMember[] = [];
    const used = new Set<string>();
    for (let i = 0; i < size; i++) {
      const roll = random.next();
      if (roll < 0.2) this.group(members, used);
      else if (roll < 0.28) this.lookalike(members);
      else {
        const key = randomKey(random);
        if (used.has(key)) continue;
        used.add(key);
        members.push({ key, value: this.value(depth) });
      }
    }
    return { type: "object", members };
  }

  /** A plural or ordinal group with the categories English needs, in CLDR order. */
  private group(members: JsonMember[], used: Set<string>): void {
    const random = this.#random;
    const ordinal = random.chance(0.3);
    const base = randomKey(random);
    const id = `${ordinal ? "ordinal" : "plural"}:${base}`;
    if (base.endsWith("_ordinal") || used.has(id)) return;
    used.add(id);
    const categories = ordinal
      ? ["one", "two", "few", "other"]
      : random.chance(0.3)
        ? ["zero", "one", "other"]
        : ["one", "other"];
    for (const category of categories) {
      const key = ordinal ? `${base}_ordinal_${category}` : `${base}_${category}`;
      members.push({ key, value: stringNode(randomString(random)) });
    }
  }

  /** Keys named like plural keys that don't form a group: they stay text. */
  private lookalike(members: JsonMember[]): void {
    const random = this.#random;
    const base = `lone${this.#lone++}`;
    const keys = random.pick([
      [`${base}_other`],
      [`${base}_one`, `${base}_few`],
      [`${base}_ordinal_other`],
    ]);
    for (const key of keys) members.push({ key, value: stringNode(randomString(random)) });
  }
}

/** Random translations for some entries, some of them of the wrong shape. */
function randomTranslations(random: Random, entries: readonly SourceEntry[]) {
  const translations = new Map<string, TextValue>();
  for (const entry of entries) {
    const key = entryKey(entry.kind, entry.keyPath);
    const roll = random.next();
    if (entry.kind === "text") {
      if (roll < 0.6) translations.set(key, randomString(random));
      else if (roll < 0.7) translations.set(key, { other: randomString(random) });
    } else if (entry.kind === "plural" || entry.kind === "ordinal") {
      if (roll < 0.6) translations.set(key, randomForms(random));
      else if (roll < 0.7) translations.set(key, randomString(random));
    } else if (roll < 0.2) {
      translations.set(key, randomString(random));
    }
  }
  return translations;
}

function randomForms(random: Random): PluralForms {
  const forms: PluralForms = {};
  for (const category of PLURAL_CATEGORIES) {
    if (random.chance(0.5)) forms[category] = randomString(random);
  }
  return forms;
}

/** What `readTranslation` should find in a rendered file: every value, fallbacks filled in. */
function expectedValues(
  entries: readonly SourceEntry[],
  translations: ReadonlyMap<string, TextValue>,
  language: string,
): Map<string, TextValue> {
  const values = new Map<string, TextValue>();
  for (const entry of entries) {
    const key = entryKey(entry.kind, entry.keyPath);
    const translation = translations.get(key);
    if (entry.kind === "text") {
      values.set(key, typeof translation === "string" ? translation : entry.value);
    } else if (entry.kind === "plural" || entry.kind === "ordinal") {
      values.set(key, expectedForms(entry, translation, language));
    }
  }
  return values;
}

function expectedForms(
  entry: PluralEntry,
  translation: TextValue | undefined,
  language: string,
): PluralForms {
  const forms: PluralForms = {};
  for (const category of categoriesFor(language, entry.kind, entry.forms)) {
    const translated = typeof translation === "object" ? translation[category] : undefined;
    forms[category] = translated ?? entry.forms[category] ?? entry.forms.other;
  }
  return forms;
}

test("property: rendering English gives the same file and entries back, every time", () => {
  const random = new Random(0x5eed);
  const generator = new DocumentGenerator(random);
  let groups = 0;
  for (let run = 0; run < 400; run++) {
    const format = random.pick(FORMATS);
    const text = stringifyJson(generator.document(), format);
    const source = readSource(text);
    const options = { language: "en", format: source.format };
    const rendered = renderFile(source.entries, new Map(), options);
    const expected = source.format.finalNewline ? text : text + source.format.newline;
    assertStrictEquals(rendered, expected, `run ${run}`);
    assertStrictEquals(renderFile(source.entries, new Map(), options), rendered);
    assertEquals(readSource(rendered).entries, source.entries, `run ${run}`);
    groups += source.entries.filter((e) => e.kind === "plural" || e.kind === "ordinal").length;
  }
  assert(groups > 200, `only ${groups} plural groups were generated`);
});

test("property: reading a rendered translation gives back what was rendered", () => {
  const random = new Random(20260924);
  const generator = new DocumentGenerator(random);
  for (let run = 0; run < 400; run++) {
    const format = random.pick(FORMATS);
    const language = random.pick(LANGUAGES);
    const { entries } = readSource(stringifyJson(generator.document(), format));
    const translations = randomTranslations(random, entries);
    const rendered = renderFile(entries, translations, { language, format });
    assertStrictEquals(renderFile(entries, translations, { language, format }), rendered);
    const result = readTranslation(rendered, entries, { language });
    assertEquals(result.unknownKeys, [], `run ${run} (${language})`);
    assertEquals(result.values, expectedValues(entries, translations, language), `run ${run}`);
  }
});

// Performance

/** An English file with `count` strings, a sixth of them plural or ordinal groups. */
function syntheticSource(count: number): string {
  const sections: string[] = [];
  const perSection = 50;
  for (let s = 0; s * perSection < count; s++) {
    const members: string[] = [];
    for (let i = 0; i < perSection; i++) {
      const key = `string${i}`;
      if (i % 12 === 0) {
        members.push(`"${key}_one": "{{count}} item"`, `"${key}_other": "{{count}} items"`);
      } else if (i % 12 === 6) {
        members.push(
          `"${key}_ordinal_one": "{{count}}st"`,
          `"${key}_ordinal_two": "{{count}}nd"`,
          `"${key}_ordinal_few": "{{count}}rd"`,
          `"${key}_ordinal_other": "{{count}}th"`,
        );
      } else {
        members.push(`"${key}": "Section ${s}, string ${i}: {{name}} found the \u{1f511} key."`);
      }
    }
    sections.push(`"section${s}": {${members.join(", ")}}`);
  }
  return stringifyJson(parseJson(`{${sections.join(", ")}}`).root, DEFAULT_FORMAT);
}

test("renderFile renders 3000 strings into 10 languages well under a second", () => {
  const { entries, format } = readSource(syntheticSource(3000));
  assertEquals(entries.length, 3000);
  const languages = ["pl", "ja", "ar", "fr", "de", "ru", "cy", "zh", "pt-BR", "tr"];
  const translations = languages.map((language) => {
    const values = new Map<string, TextValue>();
    for (const entry of entries) {
      const key = entryKey(entry.kind, entry.keyPath);
      if (entry.kind === "text") values.set(key, `[${language}] ${entry.value}`);
      else if (entry.kind === "plural" || entry.kind === "ordinal") {
        const forms: PluralForms = {};
        for (const category of categoriesFor(language, entry.kind, entry.forms)) {
          forms[category] = `[${language}:${category}] ${entry.forms.other}`;
        }
        values.set(key, forms);
      }
    }
    return values;
  });
  const start = performance.now();
  let bytes = 0;
  for (let i = 0; i < languages.length; i++) {
    bytes += renderFile(entries, translations[i], { language: languages[i], format }).length;
  }
  const elapsed = performance.now() - start;
  assert(bytes > 1_000_000, String(bytes));
  assert(elapsed < 1000, `rendering took ${elapsed.toFixed(0)} ms`);
});
