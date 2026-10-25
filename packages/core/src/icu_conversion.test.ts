// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { checkTranslation } from "./checks.ts";
import { type IcuNode, parseIcu } from "./icu.ts";
import { sourceFileToIcu, valueToIcu } from "./icu_conversion.ts";
import type { InterpolationSyntax, PluralForms } from "./types.ts";

const I18NEXT: InterpolationSyntax = { prefix: "{{", suffix: "}}" };
const BRACES: InterpolationSyntax = { ...I18NEXT, extra: [{ prefix: "{", suffix: "}" }] };
const ICU: InterpolationSyntax = { ...I18NEXT, icu: true };

function text(value: string, syntax = I18NEXT) {
  return valueToIcu("text", value, { syntax, language: "en" });
}

function plural(forms: PluralForms, language = "en") {
  return valueToIcu("plural", forms, { syntax: I18NEXT, language });
}

/**
 * What an ICU formatter shows for a message, read back with `parseIcu`: its text unquoted,
 * each argument as `<name>`, and each block as `[name type: key(…) key(…)]`.
 */
function shown(message: string): string {
  return showNodes(message, parseIcu(message), false);
}

function showNodes(message: string, nodes: IcuNode[], inPlural: boolean): string {
  const parts = nodes.map((node) => {
    if (node.type === "text") return unquote(message.slice(node.start, node.end), inPlural);
    if (node.type === "argument") return `<${node.name}>`;
    if (node.type === "pound") return "<#>";
    const cases = node.cases.map(
      (icuCase) =>
        `${icuCase.key}(${showNodes(message, icuCase.message, node.blockType !== "select")})`,
    );
    return `[${node.name} ${node.blockType}: ${cases.join(" ")}]`;
  });
  return parts.join("");
}

/** ICU's quoting undone: `''` is `'`, and `'` before syntax quotes up to the next lone `'`. */
function unquote(quoted: string, inPlural: boolean): string {
  let plain = "";
  let inQuote = false;
  for (let at = 0; at < quoted.length; at++) {
    const char = quoted[at];
    const next = quoted[at + 1];
    if (char !== "'") {
      plain += char;
    } else if (next === "'") {
      plain += "'";
      at++;
    } else if (inQuote) {
      inQuote = false;
    } else if (next === "{" || next === "}" || (next === "#" && inPlural)) {
      inQuote = true;
    } else {
      plain += "'";
    }
  }
  return plain;
}

test("ICU conversion: {{name}} and {{- name}} become {name}", () => {
  assertEquals(text("Hello {{name}}"), { ok: true, value: "Hello {name}", escapes: 0 });
  assertEquals(text("Hello {{- name}}"), { ok: true, value: "Hello {name}", escapes: 0 });
  assertEquals(text("Hello {{ name }}"), { ok: true, value: "Hello {name}", escapes: 0 });
  assertEquals(shown("Hello {name}"), "Hello <name>");
});

test("ICU conversion: the project's own prefix and suffix become braces", () => {
  const underscores = { prefix: "__", suffix: "__" };
  assertEquals(text("Hello __name__, {score}", underscores), {
    ok: true,
    value: "Hello {name}, '{'score'}'",
    escapes: 2,
  });
});

test("ICU conversion: placeholders in extra { and } delimiters stay as written", () => {
  const converted = text("{ companyName } hired {{name}}", BRACES);
  assertEquals(converted, { ok: true, value: "{ companyName } hired {name}", escapes: 0 });
  assertEquals(shown("{ companyName } hired {name}"), "<companyName> hired <name>");
});

test("ICU conversion: placeholders in other extra delimiters become {name}", () => {
  const brackets = { ...I18NEXT, extra: [{ prefix: "[[", suffix: "]]" }] };
  assertEquals(text("Ask [[advisor]]", brackets), { ok: true, value: "Ask {advisor}", escapes: 0 });
});

test("ICU conversion: an extra-delimiter placeholder ICU can't name is refused", () => {
  assertEquals(text("{company name} hired you", BRACES), {
    ok: false,
    problems: ["{company name} can't become an ICU argument: names are letters, digits and _ only"],
  });
});

test("ICU conversion: literal braces are quoted, so they still show", () => {
  const converted = text("Press {Enter} or }");
  assertEquals(converted, { ok: true, value: "Press '{'Enter'}' or '}'", escapes: 3 });
  assertEquals(shown("Press '{'Enter'}' or '}'"), "Press {Enter} or }");
});

test("ICU conversion: a blank placeholder, which i18next shows, stays text", () => {
  assertEquals(text("{{ }} empty"), { ok: true, value: "'{{' '}}' empty", escapes: 4 });
  assertEquals(shown("'{{' '}}' empty"), "{{ }} empty");
});

test("ICU conversion: an apostrophe before an argument is doubled", () => {
  assertEquals(text("qu'{{article}} maire"), {
    ok: true,
    value: "qu''{article} maire",
    escapes: 1,
  });
  assertEquals(shown("qu''{article} maire"), "qu'<article> maire");
});

test("ICU conversion: an apostrophe before other text stays single", () => {
  assertEquals(text("l'alcalde d'{{city}}'s"), {
    ok: true,
    value: "l'alcalde d''{city}'s",
    escapes: 1,
  });
  assertEquals(shown("l'alcalde d''{city}'s"), "l'alcalde d'<city>'s");
});

test("ICU conversion: apostrophes next to braces and apostrophes stay text", () => {
  assertEquals(text("'{' and {'s and ''"), {
    ok: true,
    value: "'''{''' and '{'''s and '''",
    escapes: 6,
  });
  assertEquals(shown("'''{''' and '{'''s and '''"), "'{' and {'s and ''");
});

test("ICU conversion: # is text outside a plural case", () => {
  assertEquals(text("Room #{{number}}"), { ok: true, value: "Room #{number}", escapes: 0 });
});

test("ICU conversion: plural forms become one plural block with {count}", () => {
  const converted = plural({ one: "{{count}} coin", other: "{{count}} coins" });
  const block = "{count, plural, one {{count} coin} other {{count} coins}}";
  assertEquals(converted, { ok: true, value: block, escapes: 0 });
  assertEquals(shown(block), "[count plural: one(<count> coin) other(<count> coins)]");
});

test("ICU conversion: # and an apostrophe ending a plural case are quoted", () => {
  const converted = plural({ one: "Player #1's", other: "{{count}} players'" });
  const block = "{count, plural, one {Player '#'1's} other {{count} players''}}";
  assertEquals(converted, { ok: true, value: block, escapes: 2 });
  assertEquals(shown(block), "[count plural: one(Player #1's) other(<count> players')]");
});

test("ICU conversion: an apostrophe before # in a plural case is doubled", () => {
  const converted = plural({ one: "'#1", other: "'#{{count}}" });
  const block = "{count, plural, one {'''#'1} other {'''#'{count}}}";
  assertEquals(converted, { ok: true, value: block, escapes: 4 });
  assertEquals(shown(block), "[count plural: one('#1) other('#<count>)]");
});

test("ICU conversion: Polish keeps its four forms as cases", () => {
  const forms = {
    one: "{{count}} moneta",
    few: "{{count}} monety",
    many: "{{count}} monet",
    other: "{{count}} monety",
  };
  assertEquals(plural(forms, "pl"), {
    ok: true,
    value:
      "{count, plural, one {{count} moneta} few {{count} monety} many {{count} monet} other {{count} monety}}",
    escapes: 0,
  });
});

test("ICU conversion: Japanese keeps its one form", () => {
  assertEquals(plural({ other: "{{count}}枚" }, "ja"), {
    ok: true,
    value: "{count, plural, other {{count}枚}}",
    escapes: 0,
  });
});

test("ICU conversion: a zero form becomes the exact case =0", () => {
  const converted = plural({ zero: "No coins", one: "One coin", other: "{{count}} coins" });
  const block = "{count, plural, =0 {No coins} one {One coin} other {{count} coins}}";
  assertEquals(converted, { ok: true, value: block, escapes: 0 });
});

test("ICU conversion: a language with a zero category keeps a zero case too", () => {
  const converted = plural({ zero: "{{count}} monētu", one: "{{count}} monēta", other: "x" }, "lv");
  assertEquals(converted, {
    ok: true,
    value:
      "{count, plural, =0 {{count} monētu} zero {{count} monētu} one {{count} monēta} other {x}}",
    escapes: 0,
  });
});

test("ICU conversion: ordinal forms become a selectordinal block", () => {
  const forms = {
    one: "{{count}}st",
    two: "{{count}}nd",
    few: "{{count}}rd",
    other: "{{count}}th",
  };
  assertEquals(valueToIcu("ordinal", forms, { syntax: I18NEXT, language: "en" }), {
    ok: true,
    value:
      "{count, selectordinal, one {{count}st} two {{count}nd} few {{count}rd} other {{count}th}}",
    escapes: 0,
  });
});

test("ICU conversion: an i18next format is refused", () => {
  assertEquals(text("Costs {{price, number}}"), {
    ok: false,
    problems: [
      "{{price, number}} has an i18next format, which ICU MessageFormat writes differently",
    ],
  });
});

test("ICU conversion: a nesting reference is refused", () => {
  assertEquals(text("$t(common:back) now"), {
    ok: false,
    problems: ["$t(common:back) is an i18next nesting reference; ICU MessageFormat has no nesting"],
  });
});

test("ICU conversion: a name ICU can't hold is refused", () => {
  assertEquals(text("Hi {{user.name}}"), {
    ok: false,
    problems: ["{{user.name}} can't become an ICU argument: names are letters, digits and _ only"],
  });
});

test("ICU conversion: a problem in several forms is reported once", () => {
  assertEquals(plural({ one: "{{n, number}} coin", other: "{{n, number}} coins" }), {
    ok: false,
    problems: ["{{n, number}} has an i18next format, which ICU MessageFormat writes differently"],
  });
});

test("ICU conversion: a value of the wrong shape is refused", () => {
  assertEquals(valueToIcu("text", { other: "x" }, { syntax: I18NEXT, language: "en" }), {
    ok: false,
    problems: ["It has plural forms, but its string is a text"],
  });
});

test("ICU conversion: a value already in ICU stays as it is", () => {
  assertEquals(text("qu''{article} '{'", ICU), {
    ok: true,
    value: "qu''{article} '{'",
    escapes: 0,
  });
});

const FILE = [
  "{",
  '\t"title": "Hello {{name}}",',
  '\t"coins_one": "{{count}} coin",',
  '\t"hint": "Press {Enter}",',
  '\t"coins_other": "{{count}} coins",',
  '\t"menu": { "power_one": "{{count}} power", "power_other": "{{count}} powers" }',
  "}",
  "",
].join("\n");

test("ICU conversion: a JSON file keeps its formatting, with plural groups merged in place", () => {
  const converted = sourceFileToIcu(FILE, {
    syntax: I18NEXT,
    language: "en",
    pluralExclusions: ["menu.power"],
  });
  const expected = [
    "{",
    '\t"title": "Hello {name}",',
    '\t"coins": "{count, plural, one {{count} coin} other {{count} coins}}",',
    "\t\"hint\": \"Press '{'Enter'}'\",",
    '\t"menu": {',
    '\t\t"power_one": "{count} power",',
    '\t\t"power_other": "{count} powers"',
    "\t}",
    "}",
    "",
  ].join("\n");
  assertEquals(converted, { text: expected, merged: ["coins"], escapes: 2, refusals: [] });
});

test("ICU conversion: a file with nothing to convert stays byte for byte", () => {
  const file = '{ "play" :   "Play",\r\n "count": 3 }';
  assertEquals(sourceFileToIcu(file, { syntax: I18NEXT, language: "en" }), {
    text: file,
    merged: [],
    escapes: 0,
    refusals: [],
  });
});

test("ICU conversion: a plural group whose base is another key is refused", () => {
  const file =
    '{"coins": "Coins", "coins_one": "{{count}} coin", "coins_other": "{{count}} coins"}';
  assertEquals(sourceFileToIcu(file, { syntax: I18NEXT, language: "en" }), {
    text: file,
    merged: [],
    escapes: 0,
    refusals: [
      {
        key: "coins",
        message:
          "Its forms would become one string named coins, but another key has that name: rename one of them first",
      },
    ],
  });
});

test("ICU conversion: a plural and an ordinal group with the same base are refused", () => {
  const file =
    '{"place_one": "{{count}} place", "place_other": "{{count}} places", "place_ordinal_one": "{{count}}st", "place_ordinal_other": "{{count}}th"}';
  assertEquals(sourceFileToIcu(file, { syntax: I18NEXT, language: "en" }).refusals, [
    {
      key: "place",
      message:
        "Its forms would become one string named place, but another key has that name: rename one of them first",
    },
  ]);
});

test("ICU conversion: refusals in a file are listed by key, and nothing changes", () => {
  const file = '{"back": "$t(common:back)", "price": "{{price, number}}", "fine": "{{name}}"}';
  assertEquals(sourceFileToIcu(file, { syntax: I18NEXT, language: "en" }), {
    text: file,
    merged: [],
    escapes: 0,
    refusals: [
      {
        key: "back",
        message: "It is made of i18next nesting references only; ICU MessageFormat has no nesting",
      },
      {
        key: "price",
        message:
          "{{price, number}} has an i18next format, which ICU MessageFormat writes differently",
      },
    ],
  });
});

test("ICU conversion: descriptions of keys stay as written", () => {
  const file = '{"title": "{{name}}", "title_note": "Use {{name}} as is"}';
  const converted = sourceFileToIcu(file, {
    syntax: I18NEXT,
    language: "en",
    descriptionSuffix: "_note",
  });
  assertEquals(converted.text, '{"title":"{name}","title_note":"Use {{name}} as is"}');
});

test("ICU conversion: a Markdown document is converted whole, its line endings kept", () => {
  const document = "# {{cityName}}\r\n\r\nCode: `{ a: 1 }`\r\n";
  assertEquals(sourceFileToIcu(document, { file: "news.md", syntax: I18NEXT, language: "en" }), {
    text: "# {cityName}\r\n\r\nCode: `'{' a: 1 '}'`\r\n",
    merged: [],
    escapes: 2,
    refusals: [],
  });
});

test("ICU conversion: converting a converted file again changes nothing", () => {
  const once = sourceFileToIcu(FILE, { syntax: I18NEXT, language: "en" }).text;
  assertEquals(sourceFileToIcu(once, { syntax: ICU, language: "en" }).text, once);
});

test("ICU conversion: converted Polish forms pass the ICU checks", () => {
  const results = checkTranslation({
    kind: "text",
    source: "{count, plural, one {{count} coin} other {{count} coins}}",
    translation:
      "{count, plural, one {{count} moneta} few {{count} monety} many {{count} monet} other {{count} monety}}",
    language: "pl",
    syntax: ICU,
  });
  assertEquals(results, []);
});

test("ICU conversion: converted Latvian forms with a zero form pass the ICU checks", () => {
  const results = checkTranslation({
    kind: "text",
    source: "{count, plural, =0 {No coins} one {{count} coin} other {{count} coins}}",
    translation:
      "{count, plural, =0 {Nav monētu} zero {{count} monētu} one {{count} monēta} other {{count} monētas}}",
    language: "lv",
    syntax: ICU,
  });
  assertEquals(results, []);
});
