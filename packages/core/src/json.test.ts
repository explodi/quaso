// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { Command } from "@quaso/runtime/command";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@quaso/runtime/assert";
import {
  DEFAULT_FORMAT,
  detectJsonFormat,
  fromPlain,
  type JsonArray,
  type JsonFormat,
  type JsonNode,
  type JsonObject,
  JsonSyntaxError,
  MAX_JSON_DEPTH,
  parseJson,
  quoteJsonString,
  stringifyJson,
  toPlain,
} from "./json.ts";

// Helpers

/** Parses and writes back with the detected format. */
function rewrite(text: string): string {
  const { root, format } = parseJson(text);
  return stringifyJson(root, format);
}

/** The error `parseJson` throws for `text`. */
function parseError(text: string, file?: string): JsonSyntaxError {
  return assertThrows(() => parseJson(text, { file }), JsonSyntaxError);
}

/** Lines indented with two spaces per level, re-indented with `indent`. */
function reindent(lines: string[], indent: string): string[] {
  return lines.map((line) =>
    line.replace(/^(?: {2})+/, (spaces) => indent.repeat(spaces.length / 2)),
  );
}

/** A small deterministic pseudo-random generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code units that stress string handling: escapes, controls, surrogates, wide characters. */
const STRING_UNITS = [
  "a",
  "Z",
  " ",
  "0",
  '"',
  "\\",
  "/",
  "\n",
  "\r",
  "\t",
  "\b",
  "\f",
  "\u0000",
  "\u001f",
  "\u007f",
  "é",
  "ß",
  "ł",
  "語",
  "ع",
  "\u0301",
  "\u2028",
  "\u2029",
  "\ufeff",
  "😀",
  "\u200d",
  "\ud800",
  "\udfff",
];

function randomString(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    parts.push(STRING_UNITS[Math.floor(next() * STRING_UNITS.length)]);
  }
  return parts.join("");
}

const RANDOM_NUMBERS = [0, 1, -1, 42, 1.5, -2.25, 1e21, 1e-7, 123456789.125, 5e-324, 2 ** 53];

/** A random JSON-compatible value (no `-0`, which `assertEquals` tells apart from `0`). */
function randomValue(next: () => number, depth: number): unknown {
  const choice = Math.floor(next() * (depth > 3 ? 5 : 7));
  switch (choice) {
    case 0:
      return randomString(next, 12);
    case 1:
      return RANDOM_NUMBERS[Math.floor(next() * RANDOM_NUMBERS.length)] * (next() < 0.5 ? 1 : 3);
    case 2:
      return next() < 0.5;
    case 3:
      return null;
    case 4:
      return Math.floor(next() * 1e6) / 100;
    case 5: {
      const items: unknown[] = [];
      const length = Math.floor(next() * 4);
      for (let i = 0; i < length; i++) items.push(randomValue(next, depth + 1));
      return items;
    }
    default: {
      const object: Record<string, unknown> = {};
      const length = Math.floor(next() * 5);
      for (let i = 0; i < length; i++) {
        const key = next() < 0.2 ? String(Math.floor(next() * 20)) : randomString(next, 6);
        object[key] = randomValue(next, depth + 1);
      }
      return object;
    }
  }
}

// Round trips

/** A canonical English file, indented with two spaces. */
const CANONICAL = [
  "{",
  '  "menu": {',
  '    "play": "Play",',
  '    "settings": "Settings",',
  '    "quit": "Quit {{game}}?"',
  "  },",
  '  "coins_one": "{{count}} coin",',
  '  "coins_other": "{{count}} coins",',
  '  "hints": [',
  '    "Jump with the space bar",',
  '    "Collect every coin"',
  "  ],",
  '  "levels": [',
  "    {",
  '      "name": "Forest",',
  '      "stars": 3,',
  '      "tags": [',
  '        "easy",',
  "        []",
  "      ]",
  "    },",
  "    {",
  '      "name": "Cave",',
  '      "locked": true,',
  '      "secret": false,',
  '      "reward": null,',
  '      "extra": {}',
  "    }",
  "  ],",
  '  "b": 1,',
  '  "10": 2,',
  '  "2": 3,',
  '  "numbers": [',
  "    1.50,",
  "    -0,",
  "    1e3,",
  "    1E-7,",
  "    -12.5e+10,",
  "    0",
  "  ],",
  '  "unicode": {',
  '    "de": "Größe ändern",',
  '    "pl": "Zażółć gęślą jaźń",',
  '    "ja": "設定を保存しました",',
  '    "ar": "إعدادات الصوت",',
  '    "emoji": "👩‍💻 and 👨‍👩‍👧‍👦 and 🇵🇱",',
  '    "combining": "e\u0301 and a\u0308",',
  '    "separators": "a\u2028b\u2029c"',
  "  },",
  '  "escapes": {',
  '    "quote": "Say \\"hi\\"",',
  '    "backslash": "C:\\\\games\\\\save",',
  '    "slash": "a/b",',
  '    "lines": "Line 1\\nLine 2\\r\\n",',
  '    "controls": "\\b\\f\\t\\u0000\\u001f",',
  '    "lone": "\\ud800 and \\udfff"',
  "  },",
  '  "": "empty key",',
  '  "a.b": "dotted key",',
  '  "empty": {},',
  '  "none": []',
  "}",
];

const FORMATS: JsonFormat[] = [];
for (const indent of ["  ", "    ", "\t", " "]) {
  for (const newline of ["\n", "\r\n"] as const) {
    for (const finalNewline of [true, false]) FORMATS.push({ indent, newline, finalNewline });
  }
}

test("round-trips canonical files byte for byte in every format", () => {
  for (const format of FORMATS) {
    const text =
      reindent(CANONICAL, format.indent).join(format.newline) +
      (format.finalNewline ? format.newline : "");
    const parsed = parseJson(text);
    assertEquals(parsed.format, format);
    assertEquals(stringifyJson(parsed.root, parsed.format), text, JSON.stringify(format));
  }
});

test("round-trips what JSON.stringify writes", () => {
  const value = {
    menu: { play: "Play", nested: { deeper: ["a", { b: [] }, {}] } },
    list: [[1, 2], [], [[]], [{}]],
    text: 'Quotes " and \\ and \n and \u0001 and \ud83d and 😀',
  };
  for (const indent of ["", " ", "  ", "    ", "\t", "\t\t"]) {
    const text = JSON.stringify(value, null, indent);
    assertEquals(rewrite(text), text, `indent ${JSON.stringify(indent)}`);
    assertEquals(rewrite(`${text}\n`), `${text}\n`);
  }
});

test("round-trips files with only empty containers or a scalar", () => {
  for (const text of ["{}", "{}\n", "[]\r\n", '"text"', "42\n", "true", "null\n", '{"a":{}}']) {
    assertEquals(rewrite(text), text);
  }
  assertEquals(rewrite('{\n  "a": {},\n  "b": []\n}\n'), '{\n  "a": {},\n  "b": []\n}\n');
});

test("keeps keys in file order, including integer-like keys", () => {
  const text = '{"b":1,"10":2,"2":3}';
  const { root } = parseJson(text);
  assertEquals(
    (root as JsonObject).members.map((member) => member.key),
    ["b", "10", "2"],
  );
  assertEquals(stringifyJson(root, { ...DEFAULT_FORMAT, indent: "", finalNewline: false }), text);
  assertEquals(stringifyJson(root), '{\n  "b": 1,\n  "10": 2,\n  "2": 3\n}\n');
  // JSON.parse and toPlain reorder them, which is why the parser keeps members.
  assertEquals(Object.keys(toPlain(root) as object), ["2", "10", "b"]);
});

test("keeps numbers as written", () => {
  const raws = [
    "1.50",
    "-0",
    "1e3",
    "1E-7",
    "-12.5e+10",
    "0",
    "0.0",
    "123456789012345678901234567890",
  ];
  const { root } = parseJson(`[${raws.join(",")}]`);
  const items = (root as JsonArray).items;
  assertEquals(
    items.map((item) => (item.type === "number" ? item.raw : null)),
    raws,
  );
  assertEquals(rewrite(`[${raws.join(",")}]`), `[${raws.join(",")}]`);
  assert(Object.is(toPlain(items[1]), -0));
  assertEquals(toPlain(items[2]), 1000);
});

// Strings

test("decodes every escape, including surrogate pairs in either case", () => {
  const { root } = parseJson(
    '"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\u00C9\\ud83d\\ude00\\uD83D\\uDE00\\u0000"',
  );
  assertEquals(toPlain(root), '"\\/\b\f\n\r\t\u00e9\u00c9😀😀\u0000');
});

test("keeps lone surrogates and writes them as lowercase escapes", () => {
  const text = '["\\uD800", "x\\udc00y", "\\udbff\\ud800", "\\ude00\\ud83d"]';
  const { root } = parseJson(text);
  assertEquals(toPlain(root), ["\ud800", "x\udc00y", "\udbff\ud800", "\ude00\ud83d"]);
  assertEquals(
    stringifyJson(root, { indent: "", newline: "\n", finalNewline: false }),
    '["\\ud800","x\\udc00y","\\udbff\\ud800","\\ude00\\ud83d"]',
  );
  // A high surrogate escaped next to a raw low one still makes a pair.
  assertEquals(toPlain(parseJson('"\\ud83d\ude00"').root), "😀");
});

test("accepts any Unicode in strings, raw", () => {
  const text = '{"🎮 game":"Spiel ✓ «gra» ゲーム لعبة \u0301 \u200d \ufeff \u2028 \u007f"}';
  const { root } = parseJson(text);
  assertEquals(toPlain(root), JSON.parse(text));
  assertEquals(stringifyJson(root, { indent: "", newline: "\n", finalNewline: false }), text);
});

test("writes raw Unicode and only the required escapes", () => {
  const compact: JsonFormat = { indent: "", newline: "\n", finalNewline: false };
  const write = (value: string) => stringifyJson(fromPlain(value), compact);
  assertEquals(write("é/😀 ß \u2028 \u2029 \u007f \u00a0"), '"é/😀 ß \u2028 \u2029 \u007f \u00a0"');
  assertEquals(write('"\\\b\f\n\r\t'), '"\\"\\\\\\b\\f\\n\\r\\t"');
  assertEquals(write("\u0000\u0001\u000b\u001a\u001f"), '"\\u0000\\u0001\\u000b\\u001a\\u001f"');
  assertEquals(write("\udc00\ud800 \udfff\udbff"), '"\\udc00\\ud800 \\udfff\\udbff"');
  assertEquals(write("\udbff\udc00 \ud800\udfff"), '"\udbff\udc00 \ud800\udfff"');
  assertEquals(write("\ud83d"), '"\\ud83d"');
});

test("quoteJsonString matches JSON.stringify for every UTF-16 code unit", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const char = String.fromCharCode(code);
    assertStrictEquals(quoteJsonString(char), JSON.stringify(char), `U+${code.toString(16)}`);
    assertStrictEquals(quoteJsonString(`ab${char}cd`), JSON.stringify(`ab${char}cd`));
  }
});

test("quoteJsonString matches JSON.stringify for random strings", () => {
  const next = random(7);
  for (let i = 0; i < 5000; i++) {
    const text = randomString(next, 20);
    assertStrictEquals(quoteJsonString(text), JSON.stringify(text), JSON.stringify(text));
  }
});

// Writing

test("stringifyJson matches JSON.stringify for random values in every indent", () => {
  const next = random(11);
  for (let i = 0; i < 2000; i++) {
    const value = randomValue(next, 0);
    for (const indent of ["", "  ", "    ", "\t", "ab"]) {
      const format: JsonFormat = { indent, newline: "\n", finalNewline: false };
      assertStrictEquals(
        stringifyJson(fromPlain(value), format),
        JSON.stringify(value, null, indent),
      );
    }
  }
});

test("stringifyJson uses the format's newline and final newline", () => {
  const node = fromPlain({ a: [1, { b: "x" }], c: {} });
  assertEquals(
    stringifyJson(node, { indent: "\t", newline: "\r\n", finalNewline: true }),
    '{\r\n\t"a": [\r\n\t\t1,\r\n\t\t{\r\n\t\t\t"b": "x"\r\n\t\t}\r\n\t],\r\n\t"c": {}\r\n}\r\n',
  );
  assertEquals(
    stringifyJson(node, { indent: "  ", newline: "\n", finalNewline: false }),
    JSON.stringify(toPlain(node), null, 2),
  );
  assertEquals(
    stringifyJson(node, { indent: "", newline: "\r\n", finalNewline: true }),
    '{"a":[1,{"b":"x"}],"c":{}}\r\n',
  );
  assertEquals(stringifyJson(node), `${JSON.stringify(toPlain(node), null, 2)}\n`);
});

test("stringifyJson writes scalar roots", () => {
  const compact: JsonFormat = { indent: "", newline: "\n", finalNewline: false };
  assertEquals(stringifyJson({ type: "number", raw: "1.50" }, compact), "1.50");
  assertEquals(stringifyJson({ type: "string", value: " " }, compact), '" "');
  assertEquals(stringifyJson({ type: "boolean", value: false }, compact), "false");
  assertEquals(stringifyJson({ type: "null" }), "null\n");
});

test("stringifyJson ignores positions and handles hand-built nodes", () => {
  const node: JsonNode = {
    type: "object",
    line: 9,
    column: 9,
    members: [{ key: "x", value: { type: "array", items: [{ type: "null" }] }, line: 3 }],
  };
  assertEquals(stringifyJson(node), '{\n  "x": [\n    null\n  ]\n}\n');
});

test("stringifyJson writes multi-line files without indentation", () => {
  const node = fromPlain({ a: [1, { b: "x" }], c: {} });
  const format: JsonFormat = { indent: "", newline: "\n", finalNewline: true, multiline: true };
  assertEquals(stringifyJson(node, format), '{\n"a": [\n1,\n{\n"b": "x"\n}\n],\n"c": {}\n}\n');
  // multiline changes nothing when there is an indent.
  assertEquals(
    stringifyJson(node, { ...format, indent: "  " }),
    stringifyJson(node, { ...format, indent: "  ", multiline: false }),
  );
  assertEquals(
    stringifyJson(node, { ...format, multiline: false }),
    '{"a":[1,{"b":"x"}],"c":{}}\n',
  );
});

test("round-trips files without indentation and files with lone CR line breaks", () => {
  // Regression: a multi-line file without indented lines came back as one line, and lone
  // CR line breaks came back as LF.
  const cases = [
    '{\n"play": "Play",\n"quit": "Quit"\n}\n',
    '{\r\n"play": "Play",\r\n"menu": {\r\n"a": 1\r\n}\r\n}\r\n',
    '{\n"list": [\n"a",\n[],\n{}\n]\n}',
    '{\r  "play": "Play",\r  "quit": "Quit"\r}\r',
    '{\r\t"a": [\r\t\t1\r\t]\r}',
    '{"a":1}\r',
  ];
  for (const text of cases) assertEquals(rewrite(text), text, JSON.stringify(text));
});

// Format detection

test("detects indentation, line breaks and the final newline", () => {
  const cases: [string, JsonFormat][] = [
    ['{\n  "a": 1\n}\n', { indent: "  ", newline: "\n", finalNewline: true }],
    ['{\n    "a": 1\n}', { indent: "    ", newline: "\n", finalNewline: false }],
    ['{\n\t"a": 1\n}\n', { indent: "\t", newline: "\n", finalNewline: true }],
    ['{\r\n  "a": 1\r\n}\r\n', { indent: "  ", newline: "\r\n", finalNewline: true }],
    ['{"a":1}', { indent: "", newline: "\n", finalNewline: false }],
    ['{"a":1}\r\n', { indent: "", newline: "\r\n", finalNewline: true }],
    ["{}\n", { indent: "", newline: "\n", finalNewline: true }],
    ["", { indent: "", newline: "\n", finalNewline: false }],
    // The first line is never indentation, even with leading spaces.
    ['  {"a":1}\n', { indent: "", newline: "\n", finalNewline: true }],
    // Blank lines, even with spaces, are skipped; lines without indentation too.
    [
      '{\n   \n\n"x": 1,\n   "a": [\n      1\n   ]\n}\n',
      {
        indent: "   ",
        newline: "\n",
        finalNewline: true,
      },
    ],
    // The first line break decides, even when later ones differ.
    ['{\n  "a": 1\r\n}\r\n', { indent: "  ", newline: "\n", finalNewline: true }],
    ['{\r\n  "a": 1\n}\n', { indent: "  ", newline: "\r\n", finalNewline: true }],
    // A lone CR is a line break of its own (classic Mac OS).
    ['{\r  "a": 1\r}\r', { indent: "  ", newline: "\r", finalNewline: true }],
    ['{"a":1}\r', { indent: "", newline: "\r", finalNewline: true }],
    // Line breaks between tokens but no indented line: one member per line, unindented.
    ['{\n"a": 1\n}\n', { indent: "", newline: "\n", finalNewline: true, multiline: true }],
    ['{"a": 1,\r\n"b": 2}', { indent: "", newline: "\r\n", finalNewline: false, multiline: true }],
    ["\ufeff{\n}", { indent: "", newline: "\n", finalNewline: false, multiline: true }],
    // Line breaks only around the value don't make it multi-line.
    ['\n\n{"a":1}\n\n', { indent: "", newline: "\n", finalNewline: true }],
    ["\r\n[]\r\n", { indent: "", newline: "\r\n", finalNewline: true }],
    // Mixed indentation is kept as found.
    ['{\n \t"a": 1\n}', { indent: " \t", newline: "\n", finalNewline: false }],
    // A byte order mark doesn't change anything.
    ['\ufeff{\n  "a": 1\n}\n', { indent: "  ", newline: "\n", finalNewline: true }],
  ];
  for (const [text, format] of cases) {
    assertEquals(detectJsonFormat(text), format, JSON.stringify(text));
  }
  assertEquals(parseJson('{\r\n\t"a": 1\r\n}').format, {
    indent: "\t",
    newline: "\r\n",
    finalNewline: false,
  });
});

test("ignores a byte order mark and doesn't write it back", () => {
  const { root, format } = parseJson('\ufeff{\n  "a": 1\n}\n');
  assertEquals(toPlain(root), { a: 1 });
  assertEquals(stringifyJson(root, format), '{\n  "a": 1\n}\n');
  assertEquals(root.column, 1);
  const error = parseError("\ufeff{x}");
  assertEquals([error.line, error.column], [1, 2]);
  // Only at the start: elsewhere it is an unexpected character.
  assertEquals(parseError("{}\ufeff").detail, "Unexpected character U+FEFF after the JSON value");
});

// Positions

test("records the line and column of every node and key", () => {
  const text = '{\n  "menu": {\n    "play": "Play"\n  },\n  "list": [1, true, null]\n}';
  const root = parseJson(text).root as JsonObject;
  assertEquals([root.line, root.column], [1, 1]);
  const [menu, list] = root.members;
  assertEquals([menu.line, menu.column, menu.value.line, menu.value.column], [2, 3, 2, 11]);
  const play = (menu.value as JsonObject).members[0];
  assertEquals([play.line, play.column, play.value.line, play.value.column], [3, 5, 3, 13]);
  assertEquals([list.line, list.column], [5, 3]);
  const items = (list.value as JsonArray).items;
  assertEquals(
    items.map((item) => [item.line, item.column]),
    [
      [5, 12],
      [5, 15],
      [5, 21],
    ],
  );
});

test("counts columns in UTF-16 code units", () => {
  // The emoji is two code units, the combining mark and each CJK character one.
  const root = parseJson('{"😀": 1, "e\u0301": 2, "語語": 3}').root as JsonObject;
  assertEquals(
    root.members.map((member) => member.column),
    [2, 11, 20],
  );
  assertEquals(
    root.members.map((member) => member.value.column),
    [8, 17, 26],
  );
  const error = parseError('{"😀": "👩‍💻" x}');
  assertEquals([error.line, error.column], [1, 16]);
});

test("counts a CRLF as one line break, and a lone CR or LF as one too", () => {
  const crlf = parseError('{\r\n  "a": 1,\r\n\r\n  "b": 2\r\n  "c": 3\r\n}');
  assertEquals([crlf.line, crlf.column], [5, 3]);
  const lf = parseError('{\n  "a": 1,\n\n  "b": 2\n  "c": 3\n}');
  assertEquals([lf.line, lf.column], [5, 3]);
  const cr = parseError('{\r  "a": 1,\r\r  "b": 2\r  "c": 3\r}');
  assertEquals([cr.line, cr.column], [5, 3]);
  const mixed = parseError('{\r\n\n\r  "a" 1}');
  assertEquals([mixed.line, mixed.column], [4, 7]);
});

test("reports the position and a precise message for syntax errors", () => {
  const cases: [string, number, number, string][] = [
    ["", 1, 1, "The file is empty"],
    [" \n\t", 2, 2, "The file is empty"],
    ["{", 1, 2, "Unexpected end of file"],
    ['{\n  "a"', 2, 6, "Unexpected end of file"],
    ['{"a":', 1, 6, "Unexpected end of file"],
    ['{"a":1', 1, 7, "Unexpected end of file"],
    ['["abc', 1, 6, "Unexpected end of file"],
    ['["\\', 1, 4, "Unexpected end of file"],
    ['["\\u12', 1, 7, "Unexpected end of file"],
    ["[1,", 1, 4, "Unexpected end of file"],
    ["[-", 1, 3, "Unexpected end of file"],
    ['{\n  "a": 1\n  "b": 2\n}', 3, 3, 'Expected "," or "}" after a property value'],
    ['{"a": 1 "b": 2}', 1, 9, 'Expected "," or "}" after a property value'],
    ['{"a": "x"]', 1, 10, 'Expected "," or "}" after a property value'],
    ["[1 2]", 1, 4, 'Expected "," or "]" after an array item'],
    ['["a"}', 1, 5, 'Expected "," or "]" after an array item'],
    ['{"a" 1}', 1, 6, 'Expected ":" after a property name'],
    ['{"a"=1}', 1, 5, 'Expected ":" after a property name'],
    ["{,}", 1, 2, 'Expected a property name or "}"'],
    ['{"a":1,,}', 1, 8, "Expected a property name"],
    ["{a: 1}", 1, 2, "Property names must be in double quotes"],
    ["{'a': 1}", 1, 2, "Property names must be in double quotes"],
    ['{\n  "a": 1,\n}', 2, 9, "Trailing comma is not allowed"],
    ["[1, 2 ,\n]", 1, 7, "Trailing comma is not allowed"],
    ["[1,,2]", 1, 4, 'Unexpected character ","'],
    ["]", 1, 1, 'Unexpected character "]"'],
    ['{"a"::1}', 1, 6, 'Unexpected character ":"'],
    ['{"a": x}', 1, 7, 'Invalid value "x"'],
    ["[NaN]", 1, 2, 'Invalid value "NaN"'],
    ["[Infinity]", 1, 2, 'Invalid value "Infinity"'],
    ["[undefined]", 1, 2, 'Invalid value "undefined"'],
    ["[True]", 1, 2, 'Invalid value "True"'],
    ["[tru]", 1, 2, 'Invalid value "tru"'],
    ["[nullx]", 1, 2, 'Invalid value "nullx"'],
    [`[${"x".repeat(30)}]`, 1, 2, `Invalid value "${"x".repeat(20)}…"`],
    ["[-Infinity]", 1, 3, 'Expected a digit after "-"'],
    ["[-]", 1, 3, 'Expected a digit after "-"'],
    ["[- 1]", 1, 3, 'Expected a digit after "-"'],
    ["[01]", 1, 2, "Numbers must not have leading zeros"],
    ["[-007]", 1, 3, "Numbers must not have leading zeros"],
    ["[1.]", 1, 4, "Expected a digit after the decimal point"],
    ["[1.e5]", 1, 4, "Expected a digit after the decimal point"],
    ["[1e]", 1, 4, "Expected a digit in the exponent"],
    ["[1E+]", 1, 5, "Expected a digit in the exponent"],
    ["[.5]", 1, 2, "Numbers must start with a digit"],
    ["[+1]", 1, 2, 'Numbers must not start with "+"'],
    ["[0x10]", 1, 3, 'Expected "," or "]" after an array item'],
    ["['x']", 1, 2, "Strings must be in double quotes"],
    ["// comment\n{}", 1, 1, "Comments are not allowed in JSON"],
    ["{/* c */}", 1, 2, "Comments are not allowed in JSON"],
    ['{"a": 1 // c\n}', 1, 9, "Comments are not allowed in JSON"],
    ["{}\n// c", 2, 1, "Comments are not allowed in JSON"],
    ["[1 / 2]", 1, 4, 'Expected "," or "]" after an array item'],
    ['["a\tb"]', 1, 4, "Unescaped control character U+0009 in a string"],
    ['["a\u0000"]', 1, 4, "Unescaped control character U+0000 in a string"],
    ['["a\nb"]', 1, 4, "Unescaped line break in a string"],
    ['{\r\n  "a": "b\r\n"}', 2, 10, "Unescaped line break in a string"],
    ['["\\x"]', 1, 3, 'Invalid escape sequence "\\x"'],
    ['["\\é"]', 1, 3, 'Invalid escape sequence "\\é"'],
    ['["\\U0041"]', 1, 3, 'Invalid escape sequence "\\U"'],
    ['["\\\n"]', 1, 3, "Invalid escape sequence"],
    ['["\\u12"]', 1, 3, 'Invalid escape sequence: "\\u" must be followed by four hex digits'],
    ['["ab\\u00G0"]', 1, 5, 'Invalid escape sequence: "\\u" must be followed by four hex digits'],
    ["{} {}", 1, 4, 'Unexpected character "{" after the JSON value'],
    ['{"a":1}}', 1, 8, 'Unexpected character "}" after the JSON value'],
    ['"a" "b"', 1, 5, `Unexpected character '"' after the JSON value`],
    ["\u00a0{}", 1, 1, "Unexpected character U+00A0"],
    ["[\u200b]", 1, 2, "Unexpected character U+200B"],
    ["[\u3000]", 1, 2, "Unexpected character U+3000"],
    ["[😀]", 1, 2, 'Unexpected character "😀"'],
    ["[\ud800]", 1, 2, "Unexpected character U+D800"],
    ["[\u0301]", 1, 2, "Unexpected character U+0301"],
  ];
  for (const [text, line, column, detail] of cases) {
    const error = parseError(text);
    assertEquals(
      { code: error.code, line: error.line, column: error.column, detail: error.detail },
      { code: "syntax", line, column, detail },
      JSON.stringify(text),
    );
  }
});

test("error messages start with the file, line and column", () => {
  const error = parseError('{\n  "menu": {\n    "play" "Play"\n  }\n}\n', "en/common.json");
  assertEquals(error.message, 'en/common.json:3:12: Expected ":" after a property name');
  assertEquals(error.file, "en/common.json");
  assertEquals(error.name, "JsonSyntaxError");
  assertInstanceOf(error, Error);
  assertEquals(parseError("[1,]").message, "1:3: Trailing comma is not allowed");
  assertEquals(parseError("[1,]").file, undefined);
});

// Duplicate keys

test("rejects duplicate keys with their key path", () => {
  const text = '{\n  "menu": {\n    "play": "Play",\n    "play": "Start"\n  }\n}\n';
  const error = parseError(text, "en/common.json");
  assertEquals(error.code, "duplicate_key");
  assertEquals(error.keyPath, ["menu", "play"]);
  assertEquals([error.line, error.column], [4, 5]);
  assertEquals(error.detail, 'Duplicate key "play" at menu.play');
  assertEquals(error.message, 'en/common.json:4:5: Duplicate key "play" at menu.play');
});

test("finds duplicate keys at the root, in arrays and after escapes", () => {
  const root = parseError('{"a": 1, "b": 2, "a": 3}');
  assertEquals([root.keyPath, root.column, root.detail], [["a"], 18, 'Duplicate key "a" at a']);
  const array = parseError('{"hints": [{"x": 1}, {"x": 1, "x": 2}]}');
  assertEquals(array.keyPath, ["hints", 1, "x"]);
  assertEquals(array.detail, 'Duplicate key "x" at hints.1.x');
  // Keys are compared after decoding, so an escaped spelling is the same key.
  const escaped = parseError('{"é": 1, "\\u00e9": 2}');
  assertEquals(escaped.keyPath, ["é"]);
  const quoted = parseError('{"a\\"b": 1, "a\\"b": 2}');
  assertEquals(quoted.detail, 'Duplicate key "a\\"b" at a"b');
  const empty = parseError('{"": 1, "": 2}');
  assertEquals(empty.keyPath, [""]);
  const crlf = parseError('{\r\n  "a": 1,\r\n  "a": 2\r\n}');
  assertEquals([crlf.line, crlf.column], [3, 3]);
});

test("allows the same key in different objects", () => {
  const text = '{"a": {"x": 1}, "b": {"x": 2}, "c": [{"x": 3}, {"x": 4}]}';
  assertEquals(toPlain(parseJson(text).root), JSON.parse(text));
});

test("reports whichever error comes first", () => {
  assertEquals(parseError('{"a": 1, "a": }').code, "duplicate_key");
  assertEquals(parseError('{"a": [1,], "a": 2}').code, "syntax");
});

// Agreement with JSON.parse

test("parses valid JSON like JSON.parse", () => {
  const texts = [
    "{}",
    "[]",
    "0",
    "-0.5e-3",
    '"x"',
    ' \t\r\n {"a" \t:\r\n [ 1 , 2 ] } \n',
    '{"a":{"b":{"c":[[],[{}],[[null]]]}}}',
    '{"__proto__": {"x": 1}, "constructor": 2, "toString": 3}',
    '{"1": 1, "0": 0, "-1": -1, "01": 1, "4294967295": 5, "a": [true, false, null]}',
    '["\\u0041\\u00df\\u6f22\\ud834\\udd1e"]',
    "[1E400, -1e-400, 12345678901234567890]",
  ];
  for (const text of texts) {
    assertEquals(toPlain(parseJson(text).root), JSON.parse(text), text);
  }
});

test("toPlain keeps __proto__ as an own property, like JSON.parse", () => {
  const plain = toPlain(parseJson('{"__proto__": {"polluted": true}}').root) as Record<
    string,
    unknown
  >;
  assertEquals(Object.getPrototypeOf(plain), Object.prototype);
  assertEquals(Object.keys(plain), ["__proto__"]);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
  assertEquals(plain, JSON.parse('{"__proto__": {"polluted": true}}'));
});

test("parses random values like JSON.parse and writes them back like JSON.stringify", () => {
  const next = random(3);
  for (let i = 0; i < 2000; i++) {
    const value = randomValue(next, 0);
    const indent = ["", "  ", "\t"][i % 3];
    const text = JSON.stringify(value, null, indent);
    const { root } = parseJson(text);
    assertEquals(toPlain(root), JSON.parse(text));
    assertStrictEquals(stringifyJson(root, { indent, newline: "\n", finalNewline: false }), text);
  }
});

test("accepts and rejects the same mutated texts as JSON.parse", () => {
  const seeds = [
    JSON.stringify(JSON.parse(CANONICAL.join("\n")), null, 2),
    '{"a":[1,-2.5e+3,true,false,null,"x\\u00e9\\n"],"b":{"c":{}},"d":[]}',
    '[0, 10, "\\ud83d\\ude00", {"k": "v"}]',
  ];
  const pool = "{}[],:\"\\ 0123456789-+.eEtrufalsn\n\r\tx'/*u\u0000é😀".split("");
  const next = random(5);
  let checked = 0;
  for (const seed of seeds) {
    for (let i = 0; i < 3000; i++) {
      const position = Math.floor(next() * seed.length);
      const char = pool[Math.floor(next() * pool.length)];
      const operation = Math.floor(next() * 3);
      const text =
        operation === 0
          ? seed.slice(0, position) + char + seed.slice(position + 1)
          : operation === 1
            ? seed.slice(0, position) + char + seed.slice(position)
            : seed.slice(0, position) + seed.slice(position + 1);
      let expected: unknown;
      let valid = true;
      try {
        expected = JSON.parse(text);
      } catch {
        valid = false;
      }
      try {
        const { root } = parseJson(text);
        assert(valid, `accepted invalid JSON: ${JSON.stringify(text)}`);
        assertEquals(toPlain(root), expected);
      } catch (error) {
        assertInstanceOf(error, JsonSyntaxError, JSON.stringify(text));
        assert(
          !valid || error.code === "duplicate_key",
          `rejected valid JSON: ${JSON.stringify(text)}: ${error.message}`,
        );
      }
      checked++;
    }
  }
  assertEquals(checked, 9000);
});

// Nesting

test("accepts nesting up to MAX_JSON_DEPTH levels and rejects deeper nesting cleanly", () => {
  assertEquals(MAX_JSON_DEPTH, 256);
  const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
  const { root, format } = parseJson(nested(256));
  assertEquals(stringifyJson(root, format), nested(256));
  const error = parseError(nested(257));
  assertEquals(
    [error.line, error.column, error.detail],
    [1, 257, "Nesting is deeper than 256 levels"],
  );
  assertEquals(parseError("[".repeat(100_000)).detail, "Nesting is deeper than 256 levels");
  assertEquals(parseError('{"a":'.repeat(2000)).detail, "Nesting is deeper than 256 levels");
});

test("the deepest accepted nesting runs in a Bun subprocess", async () => {
  // Exercise parsing and conversion at the supported depth in a fresh runtime.
  const depth = MAX_JSON_DEPTH;
  const objects = '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
  const arrays = "[".repeat(depth) + "]".repeat(depth);
  const script = `
    import { fromPlain, parseJson, stringifyJson, toPlain } from ${JSON.stringify(
      import.meta.resolve("./json.ts"),
    )};
    for (const text of ${JSON.stringify([objects, arrays])}) {
      const { root, format } = parseJson(text);
      if (stringifyJson(root, format) !== text) throw new Error("round trip");
      if (stringifyJson(fromPlain(toPlain(root)), format) !== text) throw new Error("plain");
    }
    console.log("ok");
  `;
  const command = new Command(process.execPath, {
    args: ["--eval", script],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  assertEquals(code, 0, decoder.decode(stderr));
  assertEquals(decoder.decode(stdout).trim(), "ok");
});

// fromPlain and toPlain

test("fromPlain builds nodes in property order", () => {
  const node = fromPlain({ b: 1, 10: [true, null, "x"], 2: { c: 1.5 }, d: -0 });
  assertEquals(node, {
    type: "object",
    members: [
      {
        key: "2",
        value: { type: "object", members: [{ key: "c", value: { type: "number", raw: "1.5" } }] },
      },
      {
        key: "10",
        value: {
          type: "array",
          items: [
            { type: "boolean", value: true },
            { type: "null" },
            {
              type: "string",
              value: "x",
            },
          ],
        },
      },
      { key: "b", value: { type: "number", raw: "1" } },
      { key: "d", value: { type: "number", raw: "0" } },
    ],
  });
  assertEquals(fromPlain(1e21), { type: "number", raw: "1e+21" });
  assertEquals(fromPlain(5e-7), { type: "number", raw: "5e-7" });
});

test("fromPlain rejects values JSON can't hold, naming where", () => {
  const sparse = [1];
  sparse[2] = 3;
  const cases: [unknown, string][] = [
    [undefined, "Cannot write undefined as JSON"],
    [{ menu: { play: undefined } }, "Cannot write undefined as JSON at menu.play"],
    [[1, () => 1], "Cannot write a function as JSON at 1"],
    [{ n: NaN }, "Cannot write NaN as JSON at n"],
    [[Infinity], "Cannot write Infinity as JSON at 0"],
    [{ x: [-Infinity] }, "Cannot write -Infinity as JSON at x.0"],
    [Symbol("s"), "Cannot write a symbol as JSON"],
    [{ big: 10n }, "Cannot write a bigint as JSON at big"],
    [sparse, "Cannot write undefined as JSON at 1"],
  ];
  for (const [value, message] of cases) {
    assertThrows(() => fromPlain(value), TypeError, message);
  }
});

test("fromPlain rejects values nested deeper than the parser accepts", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = i % 2 === 0 ? [value] : { a: value };
    return value;
  };
  assertEquals(toPlain(fromPlain(nest(MAX_JSON_DEPTH))), nest(MAX_JSON_DEPTH));
  assertThrows(
    () => fromPlain(nest(MAX_JSON_DEPTH + 1)),
    TypeError,
    "Cannot write JSON nested deeper than 256 levels",
  );
  assertThrows(() => fromPlain(nest(100_000)), TypeError, "deeper than 256 levels");
});

test("fromPlain rejects circular structures but allows shared ones", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = { back: circular };
  assertThrows(() => fromPlain(circular), TypeError, "circular structure as JSON at self.back");
  const shared = { x: 1 };
  assertEquals(toPlain(fromPlain({ a: shared, b: [shared, shared] })), {
    a: { x: 1 },
    b: [{ x: 1 }, { x: 1 }],
  });
});

test("fromPlain uses toJSON like JSON.stringify", () => {
  const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const value = { when: date, custom: { toJSON: (key: string) => `key ${key}` } };
  assertEquals(toPlain(fromPlain(value)), JSON.parse(JSON.stringify(value)));
});

test("toPlain and fromPlain round-trip plain values", () => {
  const value = { a: [1, "two", { three: [null, false] }], "": {}, "a.b": [] };
  assertEquals(toPlain(fromPlain(value)), value);
});

// Performance

/** A large i18next-like file as JSON.stringify writes it. */
function largeFile(targetLength: number): string {
  const root: Record<string, unknown> = {};
  let length = 0;
  for (let i = 0; length < targetLength; i++) {
    const section = {
      title: `Section ${i}: Größe ändern – 設定 – ${"😀".repeat(i % 3)}`,
      description: `Line one of ${i}\nLine "two" with {{count}} and $t(common:back)`,
      [`coins_one`]: "{{count}} coin",
      [`coins_other`]: "{{count}} coins",
      hints: ["Zażółć gęślą jaźń", "إعدادات الصوت", `hint ${i}`],
      value: i * 1.5,
      enabled: i % 2 === 0,
      nothing: null,
    };
    root[`section${i}`] = section;
    length += JSON.stringify(section, null, 2).length + 20;
  }
  return JSON.stringify(root, null, 2) + "\n";
}

test("parses and writes a 5 MB file in well under a second", () => {
  const text = largeFile(5 * 1024 * 1024);
  assert(text.length >= 5 * 1024 * 1024, `only ${text.length} characters`);
  let start = performance.now();
  const { root, format } = parseJson(text);
  const parseTime = performance.now() - start;
  start = performance.now();
  const written = stringifyJson(root, format);
  const writeTime = performance.now() - start;
  assertStrictEquals(written, text);
  assert(parseTime < 1000, `parsing took ${parseTime.toFixed(0)} ms`);
  assert(writeTime < 1000, `writing took ${writeTime.toFixed(0)} ms`);
});

test("handles a long string full of escapes in linear time", () => {
  const value = 'a\n"é\\\u0001😀'.repeat(200_000);
  const text = JSON.stringify([value]);
  const start = performance.now();
  const { root } = parseJson(text);
  const written = stringifyJson(root, { indent: "", newline: "\n", finalNewline: false });
  const elapsed = performance.now() - start;
  assertEquals(toPlain(root), [value]);
  assertStrictEquals(written, text);
  assert(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});
