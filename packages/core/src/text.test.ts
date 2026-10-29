// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(graphemeLength("")).toBe(0);
  expect(graphemeLength("Play")).toBe(4);
  expect(graphemeLength("{{count}} coins")).toBe(15);
  expect(graphemeLength("a\r\nb")).toBe(3);
  expect(graphemeLength("a\nb\rc")).toBe(5);
  expect(graphemeLength("\r\n\r\n")).toBe(2);
  expect(graphemeLength("\r\r\n\n")).toBe(3);
  expect(graphemeLength("\t ")).toBe(2);
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
    expect(graphemeLength(text), text).toStrictEqual(expected);
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
  expect(graphemeLength(text)).toStrictEqual(50_000 * 18);
  assert(performance.now() - started < 5000);
});

test("countWords: English, without placeholders and references", () => {
  expect(countWords("Play")).toBe(1);
  expect(countWords("Hello, world!")).toBe(2);
  expect(countWords("You have {{count}} coins")).toBe(3);
  expect(countWords("{{count}}")).toBe(0);
  expect(countWords("{{current}}/{{total}}")).toBe(0);
  expect(countWords("$t(play) again")).toBe(1);
  expect(countWords('Win $t(coins, {"count": {{n}}}) today')).toBe(2);
  expect(countWords("$t(common:back)")).toBe(0);
  expect(countWords("{{ user name }} left")).toBe(1);
  expect(countWords("{{- html}} and {{date, datetime}}")).toBe(1);
  // A placeholder separates the words around it.
  expect(countWords("a{{b}}c")).toBe(2);
  expect(countWords("{{count}}coins")).toBe(1);
  expect(countWords("It's 3.5 coins, don't worry")).toBe(5);
  expect(countWords("co-op")).toBe(2);
});

test("countWords: empty text, punctuation, emoji and line endings", () => {
  expect(countWords("")).toBe(0);
  expect(countWords("   \r\n\t")).toBe(0);
  expect(countWords("!!! … ?")).toBe(0);
  expect(countWords("👍 🇵🇱")).toBe(0);
  expect(countWords("one\r\ntwo\nthree")).toBe(3);
  expect(countWords(`cafe${COMBINING_ACUTE} au lait`)).toBe(3);
});

test("countWords: custom syntax", () => {
  const syntax = { prefix: "%{", suffix: "}" };
  expect(countWords("%{count} coins", { syntax })).toBe(1);
  expect(countWords("%{count} coins")).toBe(2);
  expect(countWords("{{count}} coins", { syntax })).toBe(2);
  expect(countWords('Get $t(coins, {"n": %{n}}) now', { syntax })).toBe(2);
});

test("countWords: other languages", () => {
  expect(countWords("Die Größe der Straße", { locale: "de" })).toBe(4);
  expect(countWords("Zażółć gęślą jaźń", { locale: "pl" })).toBe(3);
  expect(countWords("Masz {{count}} monet", { locale: "pl" })).toBe(2);
  expect(countWords("مرحبا بالعالم", { locale: "ar" })).toBe(2);
  expect(countWords("שלום עולם", { locale: "he" })).toBe(2);
  expect(countWords("سلام دنیا", { locale: "fa" })).toBe(2);
  expect(countWords("Olá, mundo", { locale: "pt-BR" })).toBe(2);
  expect(countWords("Zdravo svete", { locale: "sr-Latn" })).toBe(2);
});

test("countWords: Japanese and Chinese are segmented by ICU's dictionaries", () => {
  // Dictionaries change between ICU versions, so only the bounds are fixed.
  expect(countWords("東京", { locale: "ja" })).toBe(1);
  const japanese = countWords("私は東京に住んでいます。", { locale: "ja" });
  assert(japanese >= 5 && japanese <= 10, `${japanese}`);
  const withPlaceholder = countWords("{{name}}さん、こんにちは", { locale: "ja" });
  assert(withPlaceholder >= 2 && withPlaceholder <= 4, `${withPlaceholder}`);
  const chinese = countWords("我喜欢玩游戏", { locale: "zh-Hans" });
  assert(chinese >= 3 && chinese <= 6, `${chinese}`);
});

test("countWords: invalid locales fall back to English", () => {
  expect(countWords("Hello world", { locale: "en_US" })).toBe(2);
  expect(countWords("Hello world", { locale: "" })).toBe(2);
});

test("sourceWords", () => {
  expect(sourceWords("text", "Play again")).toBe(2);
  expect(sourceWords("text", "$t(play) again")).toBe(1);
  expect(sourceWords("plural", { one: "{{count}} coin", other: "{{count}} coins" })).toStrictEqual(
    2,
  );
  expect(
    sourceWords("plural", { zero: "No coins", one: "One coin", other: "{{count}} coins" }),
  ).toBe(5);
  expect(sourceWords("ordinal", { one: "{{count}}st place", other: "{{count}}th place" })).toBe(4);
  expect(sourceWords("reference", "$t(common:back)")).toBe(0);
  expect(sourceWords("reference", "Words that don't count")).toBe(0);
  expect(sourceWords("literal", "")).toBe(0);
  expect(sourceWords("text", undefined)).toBe(0);
  expect(sourceWords("plural", undefined)).toBe(0);
  expect(sourceWords("text", "%{n} coins", { syntax: { prefix: "%{", suffix: "}" } })).toBe(1);
  expect(sourceWords("text", "東京", { locale: "ja" })).toBe(1);
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
    expect(canonicalLanguageTag(tag), tag).toStrictEqual(expected);
    expect(isValidLanguageTag(tag), tag).toBe(true);
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
    expect(canonicalLanguageTag(tag), JSON.stringify(tag)).toBe(null);
    expect(isValidLanguageTag(tag), JSON.stringify(tag)).toBe(false);
  }
  expect(canonicalLanguageTag(undefined as unknown as string)).toBe(null);
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
  for (const tag of RTL) expect(textDirection(tag), tag).toBe("rtl");
  for (const tag of LTR) expect(textDirection(tag), tag).toBe("ltr");
}

test("textDirection", () => {
  assertDirections();
  expect(textDirection("xyz")).toBe("ltr");
  expect(textDirection("")).toBe("ltr");
  expect(textDirection("en_US")).toBe("ltr");
  expect(textDirection("not a tag")).toBe("ltr");
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
      expect(textDirection("und-Arab")).toBe("rtl");
      expect(textDirection("tr-Arab")).toBe("rtl");
      expect(textDirection("ff-Adlm")).toBe("rtl");
      expect(textDirection("xyz")).toBe("ltr");
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
            expect(textDirection(tag), tag).toBe("rtl");
          }
          expect(textDirection("ar-Latn")).toBe("ltr");
          expect(textDirection("en")).toBe("ltr");
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
        expect(textDirection("en")).toBe("rtl");
        expect(textDirection("ar")).toBe("ltr");
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
  for (const [tag, expected] of cases) expect(languageName(tag), tag).toStrictEqual(expected);
});

test("languageName: other display languages", () => {
  expect(languageName("pl", "de")).toBe("Polnisch");
  expect(languageName("de", "fr")).toBe("allemand");
  expect(languageName("pl", "pl")).toBe("polski");
  expect(languageName("en", "ja")).toBe("英語");
  assert(["português (Brasil)", "Português (Brasil)"].includes(languageName("pt-BR", "pt-BR")));
});

test("languageName: falls back to the tag", () => {
  expect(languageName("xyz")).toBe("xyz");
  expect(languageName("en_US")).toBe("en_US");
  expect(languageName("")).toBe("");
  expect(languageName("not a tag")).toBe("not a tag");
  expect(languageName("de", "@@")).toBe("de");
});

test("canonicalLanguageTag: legacy aliases retain their region and explicit script", () => {
  expect(canonicalLanguageTag("tl-PH")).toBe("fil-PH");
  expect(canonicalLanguageTag("sh-RS")).toBe("sr-Latn-RS");
  expect(canonicalLanguageTag("sh-Cyrl-BA")).toBe("sr-Cyrl-BA");
});

test("languageName: regional and script names follow the runtime's CLDR data", () => {
  assert(["Chinese (Simplified)", "Chinese, Simplified"].includes(languageName("zh-Hans")));
  assert(["English (United States)", "English (US)"].includes(languageName("en-US")));
});
