// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@quaso/runtime/assert";
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
  assertEquals(at, text.length);
  for (let i = 1; i < tokens.length; i++) {
    assert(
      tokens[i].type !== "text" || tokens[i - 1].type !== "text",
      "adjacent text is one token",
    );
  }
}

test("tokenize: plain text is one token, empty text none", () => {
  assertEquals(tokenize(""), []);
  assertEquals(tokenize("Play"), [{ type: "text", text: "Play", start: 0, end: 4 }]);
});

test("tokenize: placeholders and their offsets", () => {
  const text = "You have {{count}} coins, {{name}}!";
  assertEquals(tokenize(text), [
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
    assertEquals(tokens.length, 1, text);
    const [token] = tokens;
    assert(token.type === "placeholder", text);
    assertEquals(
      { name: token.name, format: token.format, unescaped: token.unescaped },
      { format: undefined, ...expected },
      text,
    );
    assertEquals(token.raw, text);
    assert(!("format" in token) || token.format !== "", "an empty format is left out");
  }
});

test("tokenize: a prefix without a name or suffix is text", () => {
  const texts = ["{{}}", "{{ }}", "{{-}}", "{{-  }}", "{{, number}}", "{{-, x}}", "{{name", "}}"];
  for (const text of texts) {
    assertEquals(describe(tokenize(text)), [`text:${text}`], text);
  }
  assertEquals(describe(tokenize("{{a {{b}}")), ["placeholder:{{a {{b}}"]);
  assertEquals(tokenize("{{a {{b}}")[0], {
    type: "placeholder",
    raw: "{{a {{b}}",
    name: "a {{b",
    unescaped: false,
    start: 0,
    end: 9,
  });
  assertEquals(describe(tokenize("{{{a}}}")), ["placeholder:{{{a}}", "text:}"]);
  assertEquals(describe(tokenize("{{a}}{{b}}")), ["placeholder:{{a}}", "placeholder:{{b}}"]);
  assertEquals(describe(tokenize("{{a}} {{b")), ["placeholder:{{a}}", "text: {{b"]);
});

test("tokenize: placeholders follow i18next's pattern, {{(.+?)}}", () => {
  // Regression: an empty {{}} was skipped and the next {{count}} became a placeholder, but
  // i18next pairs the empty prefix with the next suffix and never fills {{count}} in.
  assertEquals(describe(tokenize("Du hast {{}} {{count}} Münzen")), [
    "text:Du hast ",
    "placeholder:{{}} {{count}}",
    "text: Münzen",
  ]);
  assertEquals(placeholdersOf("{{}} {{count}}")[0].name, "}} {{count");
  assertEquals(describe(tokenize("{{}}}")), ["placeholder:{{}}}"]);
  // A blank name is text, and so is every prefix inside it: i18next consumes the span.
  assertEquals(describe(tokenize("{{ ,{{count}} {{x}}")), [
    "text:{{ ,{{count}} ",
    "placeholder:{{x}}",
  ]);
  assertEquals(describe(tokenize("{{ }}count}}")), ["text:{{ }}count}}"]);
  // A reference inside a blank placeholder is still a reference.
  assertEquals(describe(tokenize("{{ ,$t(a)}}")), ["text:{{ ,", "reference:$t(a)", "text:}}"]);
  // Regression: placeholders spanned line breaks, which i18next's "." doesn't match.
  for (const text of [
    "{{\ncount}}",
    "{{count\r\n}}",
    "{{\rcount}}",
    "{{a\u2028}}",
    "{{\u2029a}}",
  ]) {
    assertEquals(describe(tokenize(text)), [`text:${text}`], JSON.stringify(text));
  }
  assertEquals(describe(tokenize("{{a\n{{b}}")), ["text:{{a\n", "placeholder:{{b}}"]);
  assertEquals(describe(tokenize("{{a\n}} {{b}}")), ["text:{{a\n}} ", "placeholder:{{b}}"]);
  // Other white space is fine.
  assertEquals(placeholdersOf("{{\tcount\u00a0}}")[0].name, "count");
  // With a one-character prefix and suffix, the inner text still needs a character.
  const single = { prefix: "_", suffix: "_" };
  assertEquals(describe(tokenize("__a_", single)), ["placeholder:__a_"]);
  assertEquals(describe(tokenize("__", single)), ["text:__"]);
});

test("tokenize: custom syntaxes", () => {
  assertEquals(describe(tokenize("Hi {name}, {{x}}", { prefix: "{", suffix: "}" })), [
    "text:Hi ",
    "placeholder:{name}",
    "text:, ",
    "placeholder:{{x}",
    "text:}",
  ]);
  const percent = { prefix: "%{", suffix: "}" };
  assertEquals(describe(tokenize("%{count} coins, {{count}}", percent)), [
    "placeholder:%{count}",
    "text: coins, {{count}}",
  ]);
  assertEquals(tokenize("%{ n, number }", percent)[0], {
    type: "placeholder",
    raw: "%{ n, number }",
    name: "n",
    format: "number",
    unescaped: false,
    start: 0,
    end: 14,
  });
  const same = { prefix: "__", suffix: "__" };
  assertEquals(describe(tokenize("__a__ and __b__", same)), [
    "placeholder:__a__",
    "text: and ",
    "placeholder:__b__",
  ]);
  assertEquals(describe(tokenize("[[- x]]", { prefix: "[[", suffix: "]]" })), [
    "placeholder:[[- x]]",
  ]);
  // A syntax without delimiters finds no placeholders rather than looping.
  assertEquals(describe(tokenize("{{a}}", { prefix: "", suffix: "}}" })), ["text:{{a}}"]);
  assertEquals(describe(tokenize("{{a}}", { prefix: "{{", suffix: "" })), ["text:{{a}}"]);
});

test("tokenize: nesting references", () => {
  assertEquals(tokenize("$t(play) again"), [
    { type: "reference", raw: "$t(play)", key: "play", start: 0, end: 8 },
    { type: "text", text: " again", start: 8, end: 14 },
  ]);
  assertEquals(tokenize("$t(common:back)"), [
    {
      type: "reference",
      raw: "$t(common:back)",
      key: "back",
      namespace: "common",
      start: 0,
      end: 15,
    },
  ]);
  assertEquals(tokenize('$t(coins, {"count": {{n}}})'), [
    {
      type: "reference",
      raw: '$t(coins, {"count": {{n}}})',
      key: "coins",
      options: '{"count": {{n}}}',
      start: 0,
      end: 27,
    },
  ]);
  assertEquals(tokenize("$t( ns : a.b:c ,  uppercase )")[0], {
    type: "reference",
    raw: "$t( ns : a.b:c ,  uppercase )",
    key: "a.b:c",
    namespace: "ns",
    options: "uppercase",
    start: 0,
    end: 29,
  });
  assertEquals(tokenize("$t()")[0], { type: "reference", raw: "$t()", key: "", start: 0, end: 4 });
});

test("tokenize: reference options with quotes, brackets and placeholders", () => {
  const quoted = '$t(a, { "x": "a)b" })';
  assertEquals(describe(tokenize(`${quoted}!`)), [`reference:${quoted}`, "text:!"]);
  assertEquals(referencesOf(quoted)[0].options, '{ "x": "a)b" }');
  const single = "$t(a, { 'x': 'a)b, c' })";
  assertEquals(describe(tokenize(single)), [`reference:${single}`]);
  assertEquals(referencesOf(single)[0].key, "a");
  const mixed = `$t(a, {"x": "it's (fine"}) and more`;
  assertEquals(describe(tokenize(mixed)), [
    `reference:$t(a, {"x": "it's (fine"})`,
    "text: and more",
  ]);
  const parens = '$t(a, {"x": "(b)", "y": (1 + (2))}) z';
  assertEquals(describe(tokenize(parens)), [`reference:${parens.slice(0, -2)}`, "text: z"]);
  // A `)` inside braces is skipped with them; a stray `}` is ignored.
  assertEquals(describe(tokenize("$t(a, {x: 1)}) z")), ["reference:$t(a, {x: 1)})", "text: z"]);
  assertEquals(describe(tokenize("$t(a}) z")), ["reference:$t(a})", "text: z"]);
  // Placeholders in the options belong to the reference.
  const options = 'Hi {{name}}, $t(coins, {"count": {{count}}, "x": "{{y}}"})';
  assertEquals(describe(tokenize(options)), [
    "text:Hi ",
    "placeholder:{{name}}",
    "text:, ",
    'reference:$t(coins, {"count": {{count}}, "x": "{{y}}"})',
  ]);
  assertEquals(
    placeholdersOf(options).map((p) => p.name),
    ["name"],
  );
  // The same with a custom syntax.
  const percent = { prefix: "%{", suffix: "}" };
  assertEquals(describe(tokenize('%{a} $t(k, {"n": %{n}}) %{b}', percent)), [
    "placeholder:%{a}",
    "text: ",
    'reference:$t(k, {"n": %{n}})',
    "text: ",
    "placeholder:%{b}",
  ]);
  // Commas inside the options' brackets or quotes don't split the key.
  assertEquals(
    referencesOf('$t(k, {"a": "x,y", "b": [1, 2]})')[0].options,
    '{"a": "x,y", "b": [1, 2]}',
  );
  assertEquals(referencesOf('$t("a,b", c)')[0].key, '"a,b"');
});

test("tokenize: an unmatched $t( is text", () => {
  assertEquals(describe(tokenize("$t(b")), ["text:$t(b"]);
  assertEquals(describe(tokenize("$t(")), ["text:$t("]);
  assertEquals(describe(tokenize("$t(a {{n}}")), ["text:$t(a ", "placeholder:{{n}}"]);
  assertEquals(describe(tokenize("$t($t(a)")), ["text:$t(", "reference:$t(a)"]);
  assertEquals(describe(tokenize("$t($t($t(a)")), ["text:$t($t(", "reference:$t(a)"]);
  assertEquals(describe(tokenize("$t(x, (y) $t(z)")), ["text:$t(x, (y) ", "reference:$t(z)"]);
  // An apostrophe opens a quote that never closes, so the first reference has no `)`.
  assertEquals(describe(tokenize("$t(don't) $t(ok)")), ["text:$t(don't) ", "reference:$t(ok)"]);
  assertEquals(describe(tokenize('$t(a, "x) $t(b)')), ['text:$t(a, "x) ', "reference:$t(b)"]);
  assertEquals(describe(tokenize("$t(a, {) $t(b)")), ["text:$t(a, {) ", "reference:$t(b)"]);
  assertEquals(describe(tokenize("$t (a) t(a) $(a) $T(a)")), ["text:$t (a) t(a) $(a) $T(a)"]);
});

test("tokenize: references nested inside references", () => {
  const nested = '$t(a, {"x": "$t(b)"}) $t(c, ($t(d)))';
  assertEquals(describe(tokenize(nested)), [
    'reference:$t(a, {"x": "$t(b)"})',
    "text: ",
    "reference:$t(c, ($t(d)))",
  ]);
});

test("tokenize: Unicode, surrogate pairs and CRLF keep UTF-16 offsets", () => {
  const text = "👨‍👩‍👧 {{name}}\r\n$t(e\u0301)🇵🇱{{ 😀 }}";
  const tokens = tokenize(text);
  assertCovers(text, tokens);
  assertEquals(describe(tokens), [
    "text:👨‍👩‍👧 ",
    "placeholder:{{name}}",
    "text:\r\n",
    "reference:$t(e\u0301)",
    "text:🇵🇱",
    "placeholder:{{ 😀 }}",
  ]);
  assertEquals(tokens[1].start, 9);
  assertEquals(placeholdersOf(text)[1].name, "😀");
  assertEquals(referencesOf(text)[0].key, "e\u0301");
  // References may span lines, as in files with CRLF line endings; placeholders may not.
  const lines = '{{\r\n  count\r\n}} $t(k, {\r\n  "n": 1\r\n})';
  assertEquals(describe(tokenize(lines)), [
    "text:{{\r\n  count\r\n}} ",
    'reference:$t(k, {\r\n  "n": 1\r\n})',
  ]);
  assertEquals(placeholdersOf(lines), []);
});

test("placeholderKey normalizes to the default delimiters", () => {
  const keys = (text: string, syntax?: { prefix: string; suffix: string }) =>
    placeholdersOf(text, syntax).map(placeholderKey);
  assertEquals(keys("{{count}} {{ count }} {{\tcount}}"), ["{{count}}", "{{count}}", "{{count}}"]);
  assertEquals(keys("{{- html}} {{-html}} {{-  html }}"), [
    "{{- html}}",
    "{{- html}}",
    "{{- html}}",
  ]);
  // Regression: a "-" after white space isn't i18next's unescape, so the keys differ.
  assertEquals(keys("{{ - html }} {{ -html}} {{--x}}"), ["{{ - html}}", "{{ -html}}", "{{- -x}}"]);
  assertEquals(keys("{{count, number}} {{count,number}} {{ count ,number }}"), [
    "{{count, number}}",
    "{{count, number}}",
    "{{count, number}}",
  ]);
  assertEquals(keys("{{-x,y}}"), ["{{- x, y}}"]);
  assertEquals(keys("%{count} %{ date, datetime }", { prefix: "%{", suffix: "}" }), [
    "{{count}}",
    "{{date, datetime}}",
  ]);
  assertEquals(keys("{{count,}}"), ["{{count}}"]);
  // Regression: formats are normalized as i18next reads them.
  assertEquals(keys("{{val, Number}} {{val,NUMBER }} {{val, number, uppercase}}"), [
    "{{val, number}}",
    "{{val, number}}",
    "{{val, number, uppercase}}",
  ]);
  assertEquals(
    keys(
      "{{val, number(minimumFractionDigits: 2)}} {{val, Number( minimumFractionDigits:2 )}} " +
        "{{val,number(minimumFractionDigits:'2';)}}",
    ),
    Array(3).fill("{{val, number(minimumFractionDigits: 2)}}"),
  );
  assertEquals(
    keys("{{d, datetime(year: numeric; month: long)}} {{d, DateTime(year:numeric;month:long)}}"),
    Array(2).fill("{{d, datetime(year: numeric; month: long)}}"),
  );
  assertEquals(keys("{{v, currency( EUR ),uppercase}} {{v,, currency(EUR) ,}}"), [
    "{{v, currency(EUR), uppercase}}",
    "{{v, currency(EUR)}}",
  ]);
  assertEquals(keys("{{v, number(a: 1)x}} {{v, list(a: 1, b)}}"), [
    "{{v, number(a: 1)x}}",
    "{{v, list(a: 1, b)}}",
  ]);
  // Names and option keys stay case-sensitive.
  assertEquals(
    new Set(keys("{{Val, number}} {{val, number(A: 1)}} {{val, number(a: 1)}}")).size,
    3,
  );
  // Different names, formats or escaping are different placeholders.
  assertEquals(new Set(keys("{{a}} {{A}} {{- a}} {{a, x}}")).size, 4);
});

test("placeholdersOf and referencesOf", () => {
  const text = '{{a}} $t(x) {{b}} $t(ns:y, {"n": {{c}}})';
  assertEquals(
    placeholdersOf(text).map((p) => p.name),
    ["a", "b"],
  );
  assertEquals(
    referencesOf(text).map((r) => [r.namespace, r.key]),
    [
      [undefined, "x"],
      ["ns", "y"],
    ],
  );
  assertEquals(placeholdersOf("no tokens"), []);
  assertEquals(referencesOf("no tokens"), []);
});

test("maskReferences numbers each reference in order", () => {
  const text = 'Go $t(a) and $t(b, {"n": {{n}}}), then $t(a) with {{name}}';
  const masked = maskReferences(text);
  assertEquals(masked, {
    text: "Go ⟦1⟧ and ⟦2⟧, then ⟦3⟧ with {{name}}",
    references: ["$t(a)", '$t(b, {"n": {{n}}})', "$t(a)"],
  });
  assertEquals(unmaskReferences(masked.text, masked.references), text);
  assertEquals(maskReferences("No references"), { text: "No references", references: [] });
  assertEquals(maskReferences(""), { text: "", references: [] });
  assertEquals(maskToken(12), "⟦12⟧");
  const percent = maskReferences('%{a} $t(k, {"n": %{n}})', { prefix: "%{", suffix: "}" });
  assertEquals(percent.text, "%{a} ⟦1⟧");
});

test("maskReferences locks text that already looks like a masked reference", () => {
  // Regression: a literal ⟦1⟧ in the text came back as the first reference.
  const text = "Press ⟦1⟧ then $t(keys.jump)";
  const masked = maskReferences(text);
  assertEquals(masked, { text: "Press ⟦1⟧ then ⟦2⟧", references: ["⟦1⟧", "$t(keys.jump)"] });
  assertEquals(unmaskReferences(masked.text, masked.references), text);
  const twice = "⟦2⟧ $t(a) $t(b) {{x⟦1⟧}} ⟦0⟧ ⟦x⟧";
  const again = maskReferences(twice);
  assertEquals(again.text, "⟦1⟧ ⟦2⟧ ⟦3⟧ {{x⟦4⟧}} ⟦0⟧ ⟦x⟧");
  assertEquals(unmaskReferences(again.text, again.references), twice);
});

test("unmaskReferences: moved references, unknown tokens and special characters", () => {
  const references = ["$t(a)", "$t(b)"];
  assertEquals(unmaskReferences("⟦2⟧ before ⟦1⟧", references), "$t(b) before $t(a)");
  assertEquals(unmaskReferences("⟦1⟧⟦1⟧", references), "$t(a)$t(a)");
  assertEquals(
    unmaskReferences("⟦9⟧ ⟦0⟧ ⟦01⟧ ⟦-1⟧ ⟦ 1 ⟧ ⟦x⟧ ⟦1", references),
    "⟦9⟧ ⟦0⟧ ⟦01⟧ ⟦-1⟧ ⟦ 1 ⟧ ⟦x⟧ ⟦1",
  );
  assertEquals(unmaskReferences("⟦99999999999999999999⟧", references), "⟦99999999999999999999⟧");
  // Replacement patterns in a reference are inserted literally.
  assertEquals(unmaskReferences("x⟦1⟧y", ['$t(a, "$&$\'$`$1")']), 'x$t(a, "$&$\'$`$1")y');
  assertEquals(unmaskReferences("no tokens", references), "no tokens");
  assertEquals(unmaskReferences("", []), "");
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
        assertEquals(rawOf(first), token.raw, JSON.stringify(text));
        assertEquals(first.type, token.type);
        continue;
      }
      for (let at = token.start; at < token.end; at++) {
        if (!text.startsWith("$t(", at) && !text.startsWith(prefix, at)) continue;
        const [first] = tokenize(text.slice(at), syntax);
        if (first.type === "placeholder" && inBlankPlaceholder(text, token.start, at, syntax)) {
          continue;
        }
        assertEquals(first.type, "text", `${JSON.stringify(text)} at ${at}`);
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
    assertEquals(found, expected, JSON.stringify(text));
  }
});

test("property: masking and unmasking give the text back", () => {
  const next = random(7);
  for (let i = 0; i < 3000; i++) {
    const text = randomText(next, Math.floor(next() * 30));
    const masked = maskReferences(text);
    assert(masked.references.length >= referencesOf(text).length);
    assertEquals(referencesOf(masked.text), []);
    assertEquals(unmaskReferences(masked.text, masked.references), text);
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
