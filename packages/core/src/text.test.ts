// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@quaso/runtime/assert";
import {
  canonicalLanguageTag,
  countWords,
  graphemeLength,
  isValidLanguageTag,
  languageName,
  sourceWords,
  textDirection,
} from "./text.ts";

const COMBINING_ACUTE = String.fromCharCode(0x301);

test("graphemeLength: ASCII, line endings and empty text", () => {
  assertEquals(graphemeLength(""), 0);
  assertEquals(graphemeLength("Play"), 4);
  assertEquals(graphemeLength("{{count}} coins"), 15);
  assertEquals(graphemeLength("a\r\nb"), 3);
  assertEquals(graphemeLength("a\nb\rc"), 5);
  assertEquals(graphemeLength("\r\n\r\n"), 2);
  assertEquals(graphemeLength("\r\r\n\n"), 3);
  assertEquals(graphemeLength("\t "), 2);
});

test("graphemeLength: emoji, flags and combining marks count as one", () => {
  const cases: [string, number][] = [
    ["😀", 1], // a surrogate pair
    ["👍🏽", 1], // with a skin tone modifier
    ["👨‍👩‍👧‍👦", 1], // a ZWJ sequence
    ["🏳️‍🌈", 1],
    ["🇵🇱", 1], // a flag: two regional indicators
    ["🇵🇱🇩🇪", 2],
    ["1️⃣", 1], // a keycap
    [`e${COMBINING_ACUTE}`, 1],
    [`e${COMBINING_ACUTE}${String.fromCharCode(0x323)}`, 1],
    ["é", 1],
    ["Zażółć gęślą jaźń", 17],
    ["ที่", 1], // Thai with two combining marks
    [String.fromCharCode(0x1112, 0x1161, 0x11ab), 1], // decomposed Hangul
    ["한국어", 3],
    ["東京", 2],
    ["مرحبا", 5],
    ["😀 {{name}} 🇵🇱", 12],
  ];
  for (const [text, expected] of cases) {
    assertEquals(graphemeLength(text), expected, text);
  }
});

test("graphemeLength: Indic conjuncts vary with the runtime's Unicode version", () => {
  // Unicode 15.1 (ICU 74) keeps a conjunct such as स्ते in one cluster; older runtimes split it.
  const length = graphemeLength("नमस्ते");
  assert(length === 3 || length === 4, `${length}`);
});

test("graphemeLength: long text is fast", () => {
  const text = "👨‍👩‍👧 Zażółć {{name}}\r\n".repeat(50_000);
  const started = performance.now();
  assertEquals(graphemeLength(text), 50_000 * 18);
  assert(performance.now() - started < 5000);
});

test("countWords: English, without placeholders and references", () => {
  assertEquals(countWords("Play"), 1);
  assertEquals(countWords("Hello, world!"), 2);
  assertEquals(countWords("You have {{count}} coins"), 3);
  assertEquals(countWords("{{count}}"), 0);
  assertEquals(countWords("{{current}}/{{total}}"), 0);
  assertEquals(countWords("$t(play) again"), 1);
  assertEquals(countWords('Win $t(coins, {"count": {{n}}}) today'), 2);
  assertEquals(countWords("$t(common:back)"), 0);
  assertEquals(countWords("{{ user name }} left"), 1);
  assertEquals(countWords("{{- html}} and {{date, datetime}}"), 1);
  // A placeholder separates the words around it.
  assertEquals(countWords("a{{b}}c"), 2);
  assertEquals(countWords("{{count}}coins"), 1);
  assertEquals(countWords("It's 3.5 coins, don't worry"), 5);
  assertEquals(countWords("co-op"), 2);
});

test("countWords: empty text, punctuation, emoji and line endings", () => {
  assertEquals(countWords(""), 0);
  assertEquals(countWords("   \r\n\t"), 0);
  assertEquals(countWords("!!! … ?"), 0);
  assertEquals(countWords("👍 🇵🇱"), 0);
  assertEquals(countWords("one\r\ntwo\nthree"), 3);
  assertEquals(countWords(`cafe${COMBINING_ACUTE} au lait`), 3);
});

test("countWords: custom syntax", () => {
  const syntax = { prefix: "%{", suffix: "}" };
  assertEquals(countWords("%{count} coins", { syntax }), 1);
  assertEquals(countWords("%{count} coins"), 2);
  assertEquals(countWords("{{count}} coins", { syntax }), 2);
  assertEquals(countWords('Get $t(coins, {"n": %{n}}) now', { syntax }), 2);
});

test("countWords: other languages", () => {
  assertEquals(countWords("Die Größe der Straße", { locale: "de" }), 4);
  assertEquals(countWords("Zażółć gęślą jaźń", { locale: "pl" }), 3);
  assertEquals(countWords("Masz {{count}} monet", { locale: "pl" }), 2);
  assertEquals(countWords("مرحبا بالعالم", { locale: "ar" }), 2);
  assertEquals(countWords("שלום עולם", { locale: "he" }), 2);
  assertEquals(countWords("سلام دنیا", { locale: "fa" }), 2);
  assertEquals(countWords("Olá, mundo", { locale: "pt-BR" }), 2);
  assertEquals(countWords("Zdravo svete", { locale: "sr-Latn" }), 2);
});

test("countWords: Japanese and Chinese are segmented by ICU's dictionaries", () => {
  // Dictionaries change between ICU versions, so only the bounds are fixed.
  assertEquals(countWords("東京", { locale: "ja" }), 1);
  const japanese = countWords("私は東京に住んでいます。", { locale: "ja" });
  assert(japanese >= 5 && japanese <= 10, `${japanese}`);
  const withPlaceholder = countWords("{{name}}さん、こんにちは", { locale: "ja" });
  assert(withPlaceholder >= 2 && withPlaceholder <= 4, `${withPlaceholder}`);
  const chinese = countWords("我喜欢玩游戏", { locale: "zh-Hans" });
  assert(chinese >= 3 && chinese <= 6, `${chinese}`);
});

test("countWords: invalid locales fall back to English", () => {
  assertEquals(countWords("Hello world", { locale: "en_US" }), 2);
  assertEquals(countWords("Hello world", { locale: "" }), 2);
});

test("sourceWords", () => {
  assertEquals(sourceWords("text", "Play again"), 2);
  assertEquals(sourceWords("text", "$t(play) again"), 1);
  assertEquals(sourceWords("plural", { one: "{{count}} coin", other: "{{count}} coins" }), 2);
  assertEquals(
    sourceWords("plural", { zero: "No coins", one: "One coin", other: "{{count}} coins" }),
    5,
  );
  assertEquals(sourceWords("ordinal", { one: "{{count}}st place", other: "{{count}}th place" }), 4);
  assertEquals(sourceWords("reference", "$t(common:back)"), 0);
  assertEquals(sourceWords("reference", "Words that don't count"), 0);
  assertEquals(sourceWords("literal", ""), 0);
  assertEquals(sourceWords("text", undefined), 0);
  assertEquals(sourceWords("plural", undefined), 0);
  assertEquals(sourceWords("text", "%{n} coins", { syntax: { prefix: "%{", suffix: "}" } }), 1);
  assertEquals(sourceWords("text", "東京", { locale: "ja" }), 1);
});

test("canonicalLanguageTag: canonical case and aliases", () => {
  const cases: [string, string][] = [
    ["en", "en"],
    ["EN", "en"],
    ["pt-br", "pt-BR"],
    ["PT-BR", "pt-BR"],
    ["zh-hans", "zh-Hans"],
    ["zh-hans-cn", "zh-Hans-CN"],
    ["sr-latn", "sr-Latn"],
    ["en-us", "en-US"],
    ["es-419", "es-419"],
    ["iw", "he"],
    ["de-DE-u-co-phonebk", "de-DE-u-co-phonebk"],
    ["und", "und"],
  ];
  for (const [tag, expected] of cases) {
    assertEquals(canonicalLanguageTag(tag), expected, tag);
    assertEquals(isValidLanguageTag(tag), true, tag);
  }
});

test("canonicalLanguageTag: invalid tags", () => {
  const invalid = [
    "",
    " ",
    "en_US",
    "pt_BR",
    " en",
    "en ",
    "en\n",
    "e n",
    "en-",
    "-en",
    "e",
    "en--US",
    "toolonglanguage",
    "x-private",
    "i-klingon",
    "root",
    "@",
    "en-US-u",
    "日本語",
  ];
  for (const tag of invalid) {
    assertEquals(canonicalLanguageTag(tag), null, JSON.stringify(tag));
    assertEquals(isValidLanguageTag(tag), false, JSON.stringify(tag));
  }
  assertEquals(canonicalLanguageTag(undefined as unknown as string), null);
});

const RTL = ["ar", "he", "fa", "ur", "ps", "sd", "yi", "dv", "ug", "ckb", "ar-EG", "iw", "pa-Arab"];
const LTR = [
  "en",
  "de",
  "pl",
  "ja",
  "zh-Hans",
  "pt-BR",
  "sr-Latn",
  "sr-Cyrl",
  "ar-Latn",
  "pa",
  "ku",
];

function assertDirections(): void {
  for (const tag of RTL) assertEquals(textDirection(tag), "rtl", tag);
  for (const tag of LTR) assertEquals(textDirection(tag), "ltr", tag);
}

test("textDirection", () => {
  assertDirections();
  assertEquals(textDirection("xyz"), "ltr");
  assertEquals(textDirection(""), "ltr");
  assertEquals(textDirection("en_US"), "ltr");
  assertEquals(textDirection("not a tag"), "ltr");
});

/** Runs `body` with a property of `Intl.Locale.prototype` replaced, then restores it. */
function withLocaleProperty(name: string, descriptor: PropertyDescriptor, body: () => void): void {
  const prototype = Intl.Locale.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, name);
  Object.defineProperty(prototype, name, { configurable: true, ...descriptor });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(prototype, name, original);
    else delete (prototype as unknown as Record<string, unknown>)[name];
  }
}

const ABSENT: PropertyDescriptor = { value: undefined, writable: true };

test("textDirection: runtimes without text info use scripts and languages", () => {
  withLocaleProperty("getTextInfo", ABSENT, () => {
    withLocaleProperty("textInfo", ABSENT, () => {
      assertDirections();
      assertEquals(textDirection("und-Arab"), "rtl");
      assertEquals(textDirection("tr-Arab"), "rtl");
      assertEquals(textDirection("ff-Adlm"), "rtl");
      assertEquals(textDirection("xyz"), "ltr");
      // Without likely subtags either, the language list decides.
      withLocaleProperty(
        "maximize",
        {
          value: function (this: Intl.Locale) {
            return this;
          },
          writable: true,
        },
        () => {
          for (const tag of ["ar", "he", "fa", "ur", "ckb", "yi", "dv"]) {
            assertEquals(textDirection(tag), "rtl", tag);
          }
          assertEquals(textDirection("ar-Latn"), "ltr");
          assertEquals(textDirection("en"), "ltr");
        },
      );
    });
  });
});

test("textDirection: the textInfo getter of older runtimes (Node 22)", () => {
  withLocaleProperty("getTextInfo", ABSENT, () => {
    withLocaleProperty(
      "textInfo",
      {
        get(this: Intl.Locale) {
          return { direction: this.language === "en" ? "rtl" : "ltr" };
        },
      },
      () => {
        // The stub's deliberately wrong answers show that the getter is used.
        assertEquals(textDirection("en"), "rtl");
        assertEquals(textDirection("ar"), "ltr");
      },
    );
  });
});

test("languageName: English names", () => {
  const cases: [string, string][] = [
    ["en", "English"],
    ["de", "German"],
    ["pl", "Polish"],
    ["ja", "Japanese"],
    ["ar", "Arabic"],
    ["he", "Hebrew"],
    ["fa", "Persian"],
    ["ur", "Urdu"],
    ["pt-BR", "Portuguese (Brazil)"],
    ["pt-br", "Portuguese (Brazil)"],
    ["sr-Latn", "Serbian (Latin)"],
  ];
  for (const [tag, expected] of cases) assertEquals(languageName(tag), expected, tag);
});

test("languageName: other display languages", () => {
  assertEquals(languageName("pl", "de"), "Polnisch");
  assertEquals(languageName("de", "fr"), "allemand");
  assertEquals(languageName("pl", "pl"), "polski");
  assertEquals(languageName("en", "ja"), "英語");
  assert(["português (Brasil)", "Português (Brasil)"].includes(languageName("pt-BR", "pt-BR")));
});

test("languageName: falls back to the tag", () => {
  assertEquals(languageName("xyz"), "xyz");
  assertEquals(languageName("en_US"), "en_US");
  assertEquals(languageName(""), "");
  assertEquals(languageName("not a tag"), "not a tag");
  assertEquals(languageName("de", "@@"), "de");
});

test("canonicalLanguageTag: legacy aliases retain their region and explicit script", () => {
  assertEquals(canonicalLanguageTag("tl-PH"), "fil-PH");
  assertEquals(canonicalLanguageTag("sh-RS"), "sr-Latn-RS");
  assertEquals(canonicalLanguageTag("sh-Cyrl-BA"), "sr-Cyrl-BA");
});

test("languageName: regional and script names follow the runtime's CLDR data", () => {
  assert(["Chinese (Simplified)", "Chinese, Simplified"].includes(languageName("zh-Hans")));
  assert(["English (United States)", "English (US)"].includes(languageName("en-US")));
});
