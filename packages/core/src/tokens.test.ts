// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import {
  maskReferences,
  maskToken,
  placeholderKey,
  placeholdersOf,
  referencesOf,
  type Token,
  tokenize,
  unmaskReferences,
} from "./tokens.ts";

/** The raw text of a token, as it appears in the input. */
function rawOf(token: Token): string {
  return token.type === "text" ? token.text : token.raw;
}

/** Tokens as short strings, to keep expectations readable. */
function describe(tokens: Token[]): string[] {
  return tokens.map((token) => `${token.type}:${rawOf(token)}`);
}

/** Checks that the tokens cover the text exactly, in order, with correct offsets. */
function assertCovers(text: string, tokens: Token[]): void {
  let at = 0;
  for (const token of tokens) {
    if (
      token.start !== at ||
      token.end <= token.start ||
      text.slice(at, token.end) !== rawOf(token)
    ) {
      throw new Error(
        `token ${JSON.stringify(token)} doesn't follow ${at} in ${JSON.stringify(text)}`,
      );
    }
    at = token.end;
  }
  expect(at).toStrictEqual(text.length);
  for (let i = 1; i < tokens.length; i++) {
    assert(
      tokens[i].type !== "text" || tokens[i - 1].type !== "text",
      "adjacent text is one token",
    );
  }
}

test("tokenize: plain text is one token, empty text none", () => {
  expect(tokenize("")).toStrictEqual([]);
  expect(tokenize("Play")).toStrictEqual([{ type: "text", text: "Play", start: 0, end: 4 }]);
});

test("tokenize: placeholders and their offsets", () => {
  const text = "You have {{count}} coins, {{name}}!";
  expect(tokenize(text)).toStrictEqual([
    { type: "text", text: "You have ", start: 0, end: 9 },
    { type: "placeholder", raw: "{{count}}", name: "count", unescaped: false, start: 9, end: 18 },
    { type: "text", text: " coins, ", start: 18, end: 26 },
    { type: "placeholder", raw: "{{name}}", name: "name", unescaped: false, start: 26, end: 34 },
    { type: "text", text: "!", start: 34, end: 35 },
  ]);
});

test("tokenize: placeholder spacing, formats and unescaped variants", () => {
  const cases: [string, { name: string; format?: string; unescaped: boolean }][] = [
    ["{{count}}", { name: "count", unescaped: false }],
    ["{{ count }}", { name: "count", unescaped: false }],
    ["{{\tcount\t}}", { name: "count", unescaped: false }],
    ["{{count, number}}", { name: "count", format: "number", unescaped: false }],
    ["{{count,number}}", { name: "count", format: "number", unescaped: false }],
    ["{{ count ,  number }}", { name: "count", format: "number", unescaped: false }],
    [
      "{{date, datetime(format: short)}}",
      {
        name: "date",
        format: "datetime(format: short)",
        unescaped: false,
      },
    ],
    ["{{a, b, c}}", { name: "a", format: "b, c", unescaped: false }],
    ["{{count,}}", { name: "count", unescaped: false }],
    ["{{- html}}", { name: "html", unescaped: true }],
    ["{{-html}}", { name: "html", unescaped: true }],
    // i18next only unescapes with the "-" right after the prefix; otherwise it is part of
    // the name, and i18next looks up a variable named "- html".
    ["{{ - html }}", { name: "- html", unescaped: false }],
    ["{{ -html}}", { name: "-html", unescaped: false }],
    ["{{ - }}", { name: "-", unescaped: false }],
    ["{{- html, uppercase}}", { name: "html", format: "uppercase", unescaped: true }],
    ["{{--x}}", { name: "-x", unescaped: true }],
    ["{{user.name}}", { name: "user.name", unescaped: false }],
    ["{{a-b}}", { name: "a-b", unescaped: false }],
    ["{{\u00a0nbsp\u00a0}}", { name: "nbsp", unescaped: false }],
    ["{{名前}}", { name: "名前", unescaped: false }],
  ];
  for (const [text, expected] of cases) {
    const tokens = tokenize(text);
    expect(tokens.length, text).toBe(1);
    const [token] = tokens;
    assert(token.type === "placeholder", text);
    expect(
      { name: token.name, format: token.format, unescaped: token.unescaped },
      text,
    ).toStrictEqual({ format: undefined, ...expected });
    expect(token.raw).toStrictEqual(text);
    assert(!("format" in token) || token.format !== "", "an empty format is left out");
  }
});

test("tokenize: a prefix without a name or suffix is text", () => {
  const texts = ["{{}}", "{{ }}", "{{-}}", "{{-  }}", "{{, number}}", "{{-, x}}", "{{name", "}}"];
  for (const text of texts) {
    expect(describe(tokenize(text)), text).toStrictEqual([`text:${text}`]);
  }
  expect(describe(tokenize("{{a {{b}}"))).toStrictEqual(["placeholder:{{a {{b}}"]);
  expect(tokenize("{{a {{b}}")[0]).toStrictEqual({
    type: "placeholder",
    raw: "{{a {{b}}",
    name: "a {{b",
    unescaped: false,
    start: 0,
    end: 9,
  });
  expect(describe(tokenize("{{{a}}}"))).toStrictEqual(["placeholder:{{{a}}", "text:}"]);
  expect(describe(tokenize("{{a}}{{b}}"))).toStrictEqual([
    "placeholder:{{a}}",
    "placeholder:{{b}}",
  ]);
  expect(describe(tokenize("{{a}} {{b"))).toStrictEqual(["placeholder:{{a}}", "text: {{b"]);
});

test("tokenize: placeholders follow i18next's pattern, {{(.+?)}}", () => {
  // Regression: an empty {{}} was skipped and the next {{count}} became a placeholder, but
  // i18next pairs the empty prefix with the next suffix and never fills {{count}} in.
  expect(describe(tokenize("Du hast {{}} {{count}} Münzen"))).toStrictEqual([
    "text:Du hast ",
    "placeholder:{{}} {{count}}",
    "text: Münzen",
  ]);
  expect(placeholdersOf("{{}} {{count}}")[0].name).toBe("}} {{count");
  expect(describe(tokenize("{{}}}"))).toStrictEqual(["placeholder:{{}}}"]);
  // A blank name is text, and so is every prefix inside it: i18next consumes the span.
  expect(describe(tokenize("{{ ,{{count}} {{x}}"))).toStrictEqual([
    "text:{{ ,{{count}} ",
    "placeholder:{{x}}",
  ]);
  expect(describe(tokenize("{{ }}count}}"))).toStrictEqual(["text:{{ }}count}}"]);
  // A reference inside a blank placeholder is still a reference.
  expect(describe(tokenize("{{ ,$t(a)}}"))).toStrictEqual([
    "text:{{ ,",
    "reference:$t(a)",
    "text:}}",
  ]);
  // Regression: placeholders spanned line breaks, which i18next's "." doesn't match.
  for (const text of [
    "{{\ncount}}",
    "{{count\r\n}}",
    "{{\rcount}}",
    "{{a\u2028}}",
    "{{\u2029a}}",
  ]) {
    expect(describe(tokenize(text)), JSON.stringify(text)).toStrictEqual([`text:${text}`]);
  }
  expect(describe(tokenize("{{a\n{{b}}"))).toStrictEqual(["text:{{a\n", "placeholder:{{b}}"]);
  expect(describe(tokenize("{{a\n}} {{b}}"))).toStrictEqual(["text:{{a\n}} ", "placeholder:{{b}}"]);
  // Other white space is fine.
  expect(placeholdersOf("{{\tcount\u00a0}}")[0].name).toBe("count");
  // With a one-character prefix and suffix, the inner text still needs a character.
  const single = { prefix: "_", suffix: "_" };
  expect(describe(tokenize("__a_", single))).toStrictEqual(["placeholder:__a_"]);
  expect(describe(tokenize("__", single))).toStrictEqual(["text:__"]);
});

test("tokenize: custom syntaxes", () => {
  expect(describe(tokenize("Hi {name}, {{x}}", { prefix: "{", suffix: "}" }))).toStrictEqual([
    "text:Hi ",
    "placeholder:{name}",
    "text:, ",
    "placeholder:{{x}",
    "text:}",
  ]);
  const percent = { prefix: "%{", suffix: "}" };
  expect(describe(tokenize("%{count} coins, {{count}}", percent))).toStrictEqual([
    "placeholder:%{count}",
    "text: coins, {{count}}",
  ]);
  expect(tokenize("%{ n, number }", percent)[0]).toStrictEqual({
    type: "placeholder",
    raw: "%{ n, number }",
    name: "n",
    format: "number",
    unescaped: false,
    start: 0,
    end: 14,
  });
  const same = { prefix: "__", suffix: "__" };
  expect(describe(tokenize("__a__ and __b__", same))).toStrictEqual([
    "placeholder:__a__",
    "text: and ",
    "placeholder:__b__",
  ]);
  expect(describe(tokenize("[[- x]]", { prefix: "[[", suffix: "]]" }))).toStrictEqual([
    "placeholder:[[- x]]",
  ]);
  // A syntax without delimiters finds no placeholders rather than looping.
  expect(describe(tokenize("{{a}}", { prefix: "", suffix: "}}" }))).toStrictEqual(["text:{{a}}"]);
  expect(describe(tokenize("{{a}}", { prefix: "{{", suffix: "" }))).toStrictEqual(["text:{{a}}"]);
});

test("tokenize: nesting references", () => {
  expect(tokenize("$t(play) again")).toStrictEqual([
    { type: "reference", raw: "$t(play)", key: "play", start: 0, end: 8 },
    { type: "text", text: " again", start: 8, end: 14 },
  ]);
  expect(tokenize("$t(common:back)")).toStrictEqual([
    {
      type: "reference",
      raw: "$t(common:back)",
      key: "back",
      namespace: "common",
      start: 0,
      end: 15,
    },
  ]);
  expect(tokenize('$t(coins, {"count": {{n}}})')).toStrictEqual([
    {
      type: "reference",
      raw: '$t(coins, {"count": {{n}}})',
      key: "coins",
      options: '{"count": {{n}}}',
      start: 0,
      end: 27,
    },
  ]);
  expect(tokenize("$t( ns : a.b:c ,  uppercase )")[0]).toStrictEqual({
    type: "reference",
    raw: "$t( ns : a.b:c ,  uppercase )",
    key: "a.b:c",
    namespace: "ns",
    options: "uppercase",
    start: 0,
    end: 29,
  });
  expect(tokenize("$t()")[0]).toStrictEqual({
    type: "reference",
    raw: "$t()",
    key: "",
    start: 0,
    end: 4,
  });
});

test("tokenize: reference options with quotes, brackets and placeholders", () => {
  const quoted = '$t(a, { "x": "a)b" })';
  expect(describe(tokenize(`${quoted}!`))).toStrictEqual([`reference:${quoted}`, "text:!"]);
  expect(referencesOf(quoted)[0].options).toBe('{ "x": "a)b" }');
  const single = "$t(a, { 'x': 'a)b, c' })";
  expect(describe(tokenize(single))).toStrictEqual([`reference:${single}`]);
  expect(referencesOf(single)[0].key).toBe("a");
  const mixed = `$t(a, {"x": "it's (fine"}) and more`;
  expect(describe(tokenize(mixed))).toStrictEqual([
    `reference:$t(a, {"x": "it's (fine"})`,
    "text: and more",
  ]);
  const parens = '$t(a, {"x": "(b)", "y": (1 + (2))}) z';
  expect(describe(tokenize(parens))).toStrictEqual([`reference:${parens.slice(0, -2)}`, "text: z"]);
  // A `)` inside braces is skipped with them; a stray `}` is ignored.
  expect(describe(tokenize("$t(a, {x: 1)}) z"))).toStrictEqual([
    "reference:$t(a, {x: 1)})",
    "text: z",
  ]);
  expect(describe(tokenize("$t(a}) z"))).toStrictEqual(["reference:$t(a})", "text: z"]);
  // Placeholders in the options belong to the reference.
  const options = 'Hi {{name}}, $t(coins, {"count": {{count}}, "x": "{{y}}"})';
  expect(describe(tokenize(options))).toStrictEqual([
    "text:Hi ",
    "placeholder:{{name}}",
    "text:, ",
    'reference:$t(coins, {"count": {{count}}, "x": "{{y}}"})',
  ]);
  expect(placeholdersOf(options).map((p) => p.name)).toStrictEqual(["name"]);
  // The same with a custom syntax.
  const percent = { prefix: "%{", suffix: "}" };
  expect(describe(tokenize('%{a} $t(k, {"n": %{n}}) %{b}', percent))).toStrictEqual([
    "placeholder:%{a}",
    "text: ",
    'reference:$t(k, {"n": %{n}})',
    "text: ",
    "placeholder:%{b}",
  ]);
  // Commas inside the options' brackets or quotes don't split the key.
  expect(referencesOf('$t(k, {"a": "x,y", "b": [1, 2]})')[0].options).toStrictEqual(
    '{"a": "x,y", "b": [1, 2]}',
  );
  expect(referencesOf('$t("a,b", c)')[0].key).toBe('"a,b"');
});

test("tokenize: an unmatched $t( is text", () => {
  expect(describe(tokenize("$t(b"))).toStrictEqual(["text:$t(b"]);
  expect(describe(tokenize("$t("))).toStrictEqual(["text:$t("]);
  expect(describe(tokenize("$t(a {{n}}"))).toStrictEqual(["text:$t(a ", "placeholder:{{n}}"]);
  expect(describe(tokenize("$t($t(a)"))).toStrictEqual(["text:$t(", "reference:$t(a)"]);
  expect(describe(tokenize("$t($t($t(a)"))).toStrictEqual(["text:$t($t(", "reference:$t(a)"]);
  expect(describe(tokenize("$t(x, (y) $t(z)"))).toStrictEqual([
    "text:$t(x, (y) ",
    "reference:$t(z)",
  ]);
  // An apostrophe opens a quote that never closes, so the first reference has no `)`.
  expect(describe(tokenize("$t(don't) $t(ok)"))).toStrictEqual([
    "text:$t(don't) ",
    "reference:$t(ok)",
  ]);
  expect(describe(tokenize('$t(a, "x) $t(b)'))).toStrictEqual([
    'text:$t(a, "x) ',
    "reference:$t(b)",
  ]);
  expect(describe(tokenize("$t(a, {) $t(b)"))).toStrictEqual(["text:$t(a, {) ", "reference:$t(b)"]);
  expect(describe(tokenize("$t (a) t(a) $(a) $T(a)"))).toStrictEqual([
    "text:$t (a) t(a) $(a) $T(a)",
  ]);
});

test("tokenize: references nested inside references", () => {
  const nested = '$t(a, {"x": "$t(b)"}) $t(c, ($t(d)))';
  expect(describe(tokenize(nested))).toStrictEqual([
    'reference:$t(a, {"x": "$t(b)"})',
    "text: ",
    "reference:$t(c, ($t(d)))",
  ]);
});

test("tokenize: Unicode, surrogate pairs and CRLF keep UTF-16 offsets", () => {
  const text = "👨‍👩‍👧 {{name}}\r\n$t(e\u0301)🇵🇱{{ 😀 }}";
  const tokens = tokenize(text);
  assertCovers(text, tokens);
  expect(describe(tokens)).toStrictEqual([
    "text:👨‍👩‍👧 ",
    "placeholder:{{name}}",
    "text:\r\n",
    "reference:$t(e\u0301)",
    "text:🇵🇱",
    "placeholder:{{ 😀 }}",
  ]);
  expect(tokens[1].start).toBe(9);
  expect(placeholdersOf(text)[1].name).toBe("😀");
  expect(referencesOf(text)[0].key).toBe("e\u0301");
  // References may span lines, as in files with CRLF line endings; placeholders may not.
  const lines = '{{\r\n  count\r\n}} $t(k, {\r\n  "n": 1\r\n})';
  expect(describe(tokenize(lines))).toStrictEqual([
    "text:{{\r\n  count\r\n}} ",
    'reference:$t(k, {\r\n  "n": 1\r\n})',
  ]);
  expect(placeholdersOf(lines)).toStrictEqual([]);
});

test("placeholderKey normalizes to the default delimiters", () => {
  const keys = (text: string, syntax?: { prefix: string; suffix: string }) =>
    placeholdersOf(text, syntax).map(placeholderKey);
  expect(keys("{{count}} {{ count }} {{\tcount}}")).toStrictEqual([
    "{{count}}",
    "{{count}}",
    "{{count}}",
  ]);
  expect(keys("{{- html}} {{-html}} {{-  html }}")).toStrictEqual([
    "{{- html}}",
    "{{- html}}",
    "{{- html}}",
  ]);
  // Regression: a "-" after white space isn't i18next's unescape, so the keys differ.
  expect(keys("{{ - html }} {{ -html}} {{--x}}")).toStrictEqual([
    "{{ - html}}",
    "{{ -html}}",
    "{{- -x}}",
  ]);
  expect(keys("{{count, number}} {{count,number}} {{ count ,number }}")).toStrictEqual([
    "{{count, number}}",
    "{{count, number}}",
    "{{count, number}}",
  ]);
  expect(keys("{{-x,y}}")).toStrictEqual(["{{- x, y}}"]);
  expect(keys("%{count} %{ date, datetime }", { prefix: "%{", suffix: "}" })).toStrictEqual([
    "{{count}}",
    "{{date, datetime}}",
  ]);
  expect(keys("{{count,}}")).toStrictEqual(["{{count}}"]);
  // Regression: formats are normalized as i18next reads them.
  expect(keys("{{val, Number}} {{val,NUMBER }} {{val, number, uppercase}}")).toStrictEqual([
    "{{val, number}}",
    "{{val, number}}",
    "{{val, number, uppercase}}",
  ]);
  expect(
    keys(
      "{{val, number(minimumFractionDigits: 2)}} {{val, Number( minimumFractionDigits:2 )}} " +
        "{{val,number(minimumFractionDigits:'2';)}}",
    ),
  ).toStrictEqual(Array(3).fill("{{val, number(minimumFractionDigits: 2)}}"));
  expect(
    keys("{{d, datetime(year: numeric; month: long)}} {{d, DateTime(year:numeric;month:long)}}"),
  ).toStrictEqual(Array(2).fill("{{d, datetime(year: numeric; month: long)}}"));
  expect(keys("{{v, currency( EUR ),uppercase}} {{v,, currency(EUR) ,}}")).toStrictEqual([
    "{{v, currency(EUR), uppercase}}",
    "{{v, currency(EUR)}}",
  ]);
  expect(keys("{{v, number(a: 1)x}} {{v, list(a: 1, b)}}")).toStrictEqual([
    "{{v, number(a: 1)x}}",
    "{{v, list(a: 1, b)}}",
  ]);
  // Names and option keys stay case-sensitive.
  expect(new Set(keys("{{Val, number}} {{val, number(A: 1)}} {{val, number(a: 1)}}")).size).toBe(3);
  // Different names, formats or escaping are different placeholders.
  expect(new Set(keys("{{a}} {{A}} {{- a}} {{a, x}}")).size).toBe(4);
});

test("placeholdersOf and referencesOf", () => {
  const text = '{{a}} $t(x) {{b}} $t(ns:y, {"n": {{c}}})';
  expect(placeholdersOf(text).map((p) => p.name)).toStrictEqual(["a", "b"]);
  expect(referencesOf(text).map((r) => [r.namespace, r.key])).toStrictEqual([
    [undefined, "x"],
    ["ns", "y"],
  ]);
  expect(placeholdersOf("no tokens")).toStrictEqual([]);
  expect(referencesOf("no tokens")).toStrictEqual([]);
});

test("maskReferences numbers each reference in order", () => {
  const text = 'Go $t(a) and $t(b, {"n": {{n}}}), then $t(a) with {{name}}';
  const masked = maskReferences(text);
  expect(masked).toStrictEqual({
    text: "Go ⟦1⟧ and ⟦2⟧, then ⟦3⟧ with {{name}}",
    references: ["$t(a)", '$t(b, {"n": {{n}}})', "$t(a)"],
  });
  expect(unmaskReferences(masked.text, masked.references)).toStrictEqual(text);
  expect(maskReferences("No references")).toStrictEqual({ text: "No references", references: [] });
  expect(maskReferences("")).toStrictEqual({ text: "", references: [] });
  expect(maskToken(12)).toBe("⟦12⟧");
  const percent = maskReferences('%{a} $t(k, {"n": %{n}})', { prefix: "%{", suffix: "}" });
  expect(percent.text).toBe("%{a} ⟦1⟧");
});

test("maskReferences locks text that already looks like a masked reference", () => {
  // Regression: a literal ⟦1⟧ in the text came back as the first reference.
  const text = "Press ⟦1⟧ then $t(keys.jump)";
  const masked = maskReferences(text);
  expect(masked).toStrictEqual({
    text: "Press ⟦1⟧ then ⟦2⟧",
    references: ["⟦1⟧", "$t(keys.jump)"],
  });
  expect(unmaskReferences(masked.text, masked.references)).toStrictEqual(text);
  const twice = "⟦2⟧ $t(a) $t(b) {{x⟦1⟧}} ⟦0⟧ ⟦x⟧";
  const again = maskReferences(twice);
  expect(again.text).toBe("⟦1⟧ ⟦2⟧ ⟦3⟧ {{x⟦4⟧}} ⟦0⟧ ⟦x⟧");
  expect(unmaskReferences(again.text, again.references)).toStrictEqual(twice);
});

test("unmaskReferences: moved references, unknown tokens and special characters", () => {
  const references = ["$t(a)", "$t(b)"];
  expect(unmaskReferences("⟦2⟧ before ⟦1⟧", references)).toBe("$t(b) before $t(a)");
  expect(unmaskReferences("⟦1⟧⟦1⟧", references)).toBe("$t(a)$t(a)");
  expect(unmaskReferences("⟦9⟧ ⟦0⟧ ⟦01⟧ ⟦-1⟧ ⟦ 1 ⟧ ⟦x⟧ ⟦1", references)).toStrictEqual(
    "⟦9⟧ ⟦0⟧ ⟦01⟧ ⟦-1⟧ ⟦ 1 ⟧ ⟦x⟧ ⟦1",
  );
  expect(unmaskReferences("⟦99999999999999999999⟧", references)).toStrictEqual(
    "⟦99999999999999999999⟧",
  );
  // Replacement patterns in a reference are inserted literally.
  expect(unmaskReferences("x⟦1⟧y", ['$t(a, "$&$\'$`$1")'])).toBe('x$t(a, "$&$\'$`$1")y');
  expect(unmaskReferences("no tokens", references)).toBe("no tokens");
  expect(unmaskReferences("", [])).toBe("");
});

/** A small deterministic random number generator (mulberry32), for reproducible tests. */
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

const FRAGMENTS = [
  "{{",
  "}}",
  "$t(",
  ")",
  "(",
  "{",
  "}",
  '"',
  "'",
  ",",
  ":",
  "-",
  " ",
  "a",
  "count",
  "ns",
  "😀",
  "👨‍👩‍👧",
  "e\u0301",
  "\r\n",
  "$",
  "t",
  "%{",
  "⟦",
  "⟧",
  "1",
  "\n",
  "\u2028",
];

function randomText(next: () => number, length: number): string {
  const parts: string[] = [];
  for (let i = 0; i < length; i++) parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]);
  return parts.join("");
}

test("property: tokens cover random text exactly", () => {
  const next = random(20260924);
  const syntaxes = [
    undefined,
    { prefix: "{", suffix: "}" },
    { prefix: "%{", suffix: "}" },
    { prefix: "__", suffix: "__" },
  ];
  for (let i = 0; i < 3000; i++) {
    const text = randomText(next, Math.floor(next() * 30));
    const syntax = syntaxes[i % syntaxes.length];
    const tokens = tokenize(text, syntax);
    assertCovers(text, tokens);
    for (const token of tokens) {
      if (token.type === "placeholder") {
        assert(token.name !== "" && token.name === token.name.trim());
      }
      if (token.type === "reference") {
        assert(token.raw.startsWith("$t(") && token.raw.endsWith(")"));
      }
    }
  }
});

test("property: each token is what a fresh tokenizer finds at its position", () => {
  // Checks the remembered reference ends against tokenizing from each position afresh.
  const next = random(42);
  const syntaxes = [undefined, { prefix: "%{", suffix: "}" }];
  for (let i = 0; i < 2000; i++) {
    const text = randomText(next, Math.floor(next() * 40));
    const syntax = syntaxes[i % syntaxes.length];
    const prefix = syntax?.prefix ?? "{{";
    for (const token of tokenize(text, syntax)) {
      if (token.type !== "text") {
        const [first] = tokenize(text.slice(token.start), syntax);
        expect(rawOf(first), JSON.stringify(text)).toStrictEqual(token.raw);
        expect(first.type).toStrictEqual(token.type);
        continue;
      }
      for (let at = token.start; at < token.end; at++) {
        if (!text.startsWith("$t(", at) && !text.startsWith(prefix, at)) continue;
        const [first] = tokenize(text.slice(at), syntax);
        if (first.type === "placeholder" && inBlankPlaceholder(text, token.start, at, syntax)) {
          continue;
        }
        expect(first.type, `${JSON.stringify(text)} at ${at}`).toBe("text");
      }
    }
  }
});

/** i18next's interpolation pattern, `{{(.+?)}}` for the default syntax. */
function interpolationPattern(syntax = { prefix: "{{", suffix: "}}" }, flags = "g"): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escape(syntax.prefix)}(.+?)${escape(syntax.suffix)}`, flags);
}

/** Whether a name, as i18next splits it, is blank: `{{ }}`, `{{, x}}`, `{{-}}`. */
function isBlankName(inner: string): boolean {
  const body = inner.startsWith("-") ? inner.slice(1) : inner;
  return body.split(",")[0].trim() === "";
}

/**
 * Whether `at` lies inside a blank placeholder (which i18next consumes without filling it)
 * that starts in the same text token, at or after `from`.
 */
function inBlankPlaceholder(
  text: string,
  from: number,
  at: number,
  syntax?: { prefix: string; suffix: string },
): boolean {
  const pattern = interpolationPattern(syntax, "y");
  for (let start = from; start < at; start++) {
    pattern.lastIndex = start;
    const match = pattern.exec(text);
    if (match && isBlankName(match[1]) && start + match[0].length > at) return true;
  }
  return false;
}

test("property: placeholders are what i18next's interpolation pattern matches", () => {
  const next = random(2026);
  const syntaxes = [undefined, { prefix: "%{", suffix: "}" }, { prefix: "__", suffix: "__" }];
  for (let i = 0; i < 3000; i++) {
    // Without references, which take their text away from placeholders.
    const text = randomText(next, Math.floor(next() * 30)).replaceAll("$t(", "$t");
    const syntax = syntaxes[i % syntaxes.length];
    const expected = [...text.matchAll(interpolationPattern(syntax))]
      .filter((match) => !isBlankName(match[1]))
      .map((match) => `${match.index}:${match[0]}`);
    const found = placeholdersOf(text, syntax).map((token) => `${token.start}:${token.raw}`);
    expect(found, JSON.stringify(text)).toStrictEqual(expected);
  }
});

test("property: masking and unmasking give the text back", () => {
  const next = random(7);
  for (let i = 0; i < 3000; i++) {
    const text = randomText(next, Math.floor(next() * 30));
    const masked = maskReferences(text);
    assert(masked.references.length >= referencesOf(text).length);
    expect(referencesOf(masked.text)).toStrictEqual([]);
    expect(unmaskReferences(masked.text, masked.references)).toStrictEqual(text);
  }
});

test("tokenize stays linear on adversarial input", () => {
  const inputs = [
    "$t(".repeat(100_000),
    `$t(" $t(' `.repeat(40_000),
    "$t(a, {".repeat(50_000),
    "{{-,x".repeat(100_000) + "}}",
    "{{".repeat(100_000),
    "{{ ".repeat(100_000) + "}}",
    "{{\n".repeat(100_000) + "}}",
    "{{ ,".repeat(100_000) + "}}",
    "{{}".repeat(100_000),
    "{{}} ".repeat(100_000) + "\n}}",
    'Hello {{name}}, $t(coins, {"count": {{n}}}) left. '.repeat(20_000),
  ];
  for (const text of inputs) {
    const started = performance.now();
    assertCovers(text, tokenize(text));
    const elapsed = performance.now() - started;
    assert(elapsed < 2000, `${elapsed} ms for ${text.slice(0, 20)}…`);
  }
});

const BRACES = { prefix: "{{", suffix: "}}", extra: [{ prefix: "{", suffix: "}" }] };

test("extra delimiters: the app's {name} beside i18next's {{count}}", () => {
  const text = "{companyName} has {{count}} jobs";
  const tokens = tokenize(text, BRACES);
  expect(describe(tokens)).toStrictEqual([
    "placeholder:{companyName}",
    "text: has ",
    "placeholder:{{count}}",
    "text: jobs",
  ]);
  assertCovers(text, tokens);
  expect(tokens[0]).toStrictEqual({
    type: "placeholder",
    raw: "{companyName}",
    name: "companyName",
    unescaped: false,
    delimiters: { prefix: "{", suffix: "}" },
    start: 0,
    end: 13,
  });
});

test("extra delimiters: without them, {name} is plain text", () => {
  expect(describe(tokenize("{companyName} has {{count}} jobs"))).toStrictEqual([
    "text:{companyName} has ",
    "placeholder:{{count}}",
    "text: jobs",
  ]);
});

test("extra delimiters: the prefix nearest the suffix starts the placeholder", () => {
  const text = "{a {b} c";
  expect(describe(tokenize(text, BRACES))).toStrictEqual([
    "text:{a ",
    "placeholder:{b}",
    "text: c",
  ]);
  assertCovers(text, tokenize(text, BRACES));
});

test("extra delimiters: a blank name or a line break is plain text", () => {
  expect(describe(tokenize("{ } and {a\nb}", BRACES))).toStrictEqual(["text:{ } and {a\nb}"]);
  expect(describe(tokenize("{a\n{b}", BRACES))).toStrictEqual(["text:{a\n", "placeholder:{b}"]);
});

test("extra delimiters: a reference's options stay in the reference", () => {
  const text = '$t(key, {"count": 3}) {name}';
  expect(describe(tokenize(text, BRACES))).toStrictEqual([
    'reference:$t(key, {"count": 3})',
    "text: ",
    "placeholder:{name}",
  ]);
});

test("extra delimiters: the key keeps them and trims the name", () => {
  const [spaced, braced] = placeholdersOf("{ name } {{name}}", BRACES);
  expect([placeholderKey(spaced), placeholderKey(braced)]).toStrictEqual(["{name}", "{{name}}"]);
});

test("extra delimiters: many prefixes without a suffix stay linear", () => {
  const text = "{".repeat(200_000) + "x";
  const started = performance.now();
  expect(describe(tokenize(text, BRACES))).toStrictEqual([`text:${text}`]);
  assert(performance.now() - started < 2000);
});

// --- ICU MessageFormat.

const ICU = { prefix: "{{", suffix: "}}", icu: true };

const MAYOR = `{style, select,
  masculine {El alcalde {name} ha comenzado su nuevo mandato.}
  other {Ha comenzado el nuevo mandato de {name}.}
}`;

test("tokenize, ICU: arguments are placeholders, with their format", () => {
  const tokens = tokenize("Hi {name}, you have {n, number} points", ICU);
  assertCovers("Hi {name}, you have {n, number} points", tokens);
  expect(describe(tokens)).toStrictEqual([
    "text:Hi ",
    "placeholder:{name}",
    "text:, you have ",
    "placeholder:{n, number}",
    "text: points",
  ]);
  expect(placeholdersOf("{n,number}", ICU).map(placeholderKey)).toStrictEqual(["{n, number}"]);
});

test("tokenize, ICU: a select block's syntax is apart from the text of its cases", () => {
  const tokens = tokenize(MAYOR, ICU);
  assertCovers(MAYOR, tokens);
  expect(describe(tokens)).toStrictEqual([
    "syntax:{style, select,\n  masculine {",
    "text:El alcalde ",
    "placeholder:{name}",
    "text: ha comenzado su nuevo mandato.",
    "syntax:}\n  other {",
    "text:Ha comenzado el nuevo mandato de ",
    "placeholder:{name}",
    "text:.",
    "syntax:}\n}",
  ]);
});

test("tokenize, ICU: # is a placeholder in plural cases only", () => {
  expect(describe(tokenize("{n, plural, offset:1 =0 {none} other {# items}}", ICU))).toStrictEqual([
    "syntax:{n, plural, offset:1 =0 {",
    "text:none",
    "syntax:} other {",
    "placeholder:#",
    "text: items",
    "syntax:}}",
  ]);
  expect(describe(tokenize("Step #1 of {n}", ICU))).toStrictEqual([
    "text:Step #1 of ",
    "placeholder:{n}",
  ]);
});

test("tokenize, ICU: a brace that starts no argument is text, and the rest is still read", () => {
  const text = "Code: `{ a: 1 }`, {#anchor}, {name}";
  expect(describe(tokenize(text, ICU))).toStrictEqual([
    "text:Code: `{ a: 1 }`, {#anchor}, ",
    "placeholder:{name}",
  ]);
});

test("tokenize, ICU: a broken block is text", () => {
  expect(describe(tokenize("{n, plural, one {# item} other {# items}", ICU))).toStrictEqual([
    "text:{n, plural, one {# item} other {# items}",
  ]);
});

test("tokenize, ICU: quoted braces are text; a lone apostrophe is an apostrophe", () => {
  expect(describe(tokenize("'{name}' l'alcalde {name}", ICU))).toStrictEqual([
    "text:'{name}' l'alcalde ",
    "placeholder:{name}",
  ]);
});

test("tokenize, ICU: i18next nesting is text", () => {
  expect(describe(tokenize("$t(key)", ICU))).toStrictEqual(["text:$t(key)"]);
});
