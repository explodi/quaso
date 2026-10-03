// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "@quaso/runtime/assert";
import {
  categoriesFor,
  coversExactlyOne,
  exampleNumbers,
  hasPluralRules,
  pluralCategories,
  sortCategories,
} from "./plurals.ts";
import type { PluralCategory } from "./types.ts";

test("sortCategories: CLDR order, without duplicates or unknown names", () => {
  assertEquals(sortCategories(["other", "many", "one", "few"]), ["one", "few", "many", "other"]);
  assertEquals(sortCategories(["other", "zero", "two", "other", "plural", ""]), [
    "zero",
    "two",
    "other",
  ]);
  assertEquals(sortCategories([]), []);
});

test("pluralCategories: cardinal categories in CLDR order", () => {
  assertEquals(pluralCategories("en"), ["one", "other"]);
  assertEquals(pluralCategories("en-GB"), ["one", "other"]);
  assertEquals(pluralCategories("pl"), ["one", "few", "many", "other"]);
  assertEquals(pluralCategories("ru"), ["one", "few", "many", "other"]);
  assertEquals(pluralCategories("fr"), ["one", "many", "other"]);
  assertEquals(pluralCategories("ja"), ["other"]);
  assertEquals(pluralCategories("zh-Hans"), ["other"]);
  assertEquals(pluralCategories("ar"), ["zero", "one", "two", "few", "many", "other"]);
  assertEquals(pluralCategories("pt-BR"), ["one", "many", "other"]);
  assertEquals(pluralCategories("sr-Latn"), ["one", "few", "other"]);
});

test("pluralCategories: ordinal categories", () => {
  const ordinal = { ordinal: true };
  assertEquals(pluralCategories("en", ordinal), ["one", "two", "few", "other"]);
  assertEquals(pluralCategories("pl", ordinal), ["other"]);
  assertEquals(pluralCategories("fr", ordinal), ["one", "other"]);
  assertEquals(pluralCategories("ja", ordinal), ["other"]);
  assertEquals(pluralCategories("cy", ordinal), ["zero", "one", "two", "few", "many", "other"]);
});

test("pluralCategories: zero is added when English has a zero form", () => {
  assertEquals(pluralCategories("en", { zero: true }), ["zero", "one", "other"]);
  assertEquals(pluralCategories("ja", { zero: true }), ["zero", "other"]);
  assertEquals(pluralCategories("pl", { zero: true }), ["zero", "one", "few", "many", "other"]);
  assertEquals(pluralCategories("ar", { zero: true }), [
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
  assertEquals(pluralCategories("en", { zero: false }), ["one", "other"]);
});

test("pluralCategories: an override replaces the categories, sorted, with other", () => {
  const override = { cardinal: ["other", "one"] as PluralCategory[] };
  assertEquals(pluralCategories("fr", { override }), ["one", "other"]);
  assertEquals(pluralCategories("fr", { override: { cardinal: ["one"] } }), ["one", "other"]);
  assertEquals(pluralCategories("fr", { override: { cardinal: [] } }), ["other"]);
  assertEquals(pluralCategories("fr", { override: { cardinal: ["one", "one"] }, zero: true }), [
    "zero",
    "one",
    "other",
  ]);
  // Each list replaces only its own type.
  const ordinalOnly = { ordinal: ["other", "one", "few"] as PluralCategory[] };
  assertEquals(pluralCategories("fr", { override: ordinalOnly }), ["one", "many", "other"]);
  assertEquals(pluralCategories("fr", { override: ordinalOnly, ordinal: true }), [
    "one",
    "few",
    "other",
  ]);
  // Names that aren't categories are dropped.
  const unknown = { cardinal: ["one", "plural"] as unknown as PluralCategory[] };
  assertEquals(pluralCategories("en", { override: unknown }), ["one", "other"]);
});

test("pluralCategories: invalid tags throw a RangeError", () => {
  for (const tag of ["", "en_US", " en", "e", "en-", "@"]) {
    assertThrows(() => pluralCategories(tag), RangeError, undefined, JSON.stringify(tag));
    assertThrows(() => exampleNumbers(tag, "other"), RangeError);
    assertThrows(() => coversExactlyOne(tag, "other"), RangeError);
  }
  assertThrows(() => pluralCategories("en_US", { override: { cardinal: ["other"] } }), RangeError);
});

test("pluralCategories: aliases and languages the runtime doesn't know", () => {
  assertEquals(pluralCategories("iw"), pluralCategories("he"));
  assertEquals(pluralCategories("he"), ["one", "two", "other"]);
  assertEquals(pluralCategories("tl"), ["one", "other"]);
  assertEquals(pluralCategories("sh"), ["one", "few", "other"]);
  // Not the runtime's default locale, which changes from one machine to the next: CLDR root.
  for (const tag of ["xyz", "tlh", "und", "zzz-Latn"]) {
    assertEquals(hasPluralRules(tag), false, tag);
    assertEquals(hasPluralRules(tag, { ordinal: true }), false, tag);
    assertEquals(pluralCategories(tag), ["other"], tag);
    assertEquals(pluralCategories(tag, { ordinal: true }), ["other"], tag);
    assertEquals(exampleNumbers(tag, "other"), "0–1000, …, 1.5");
    assertEquals(exampleNumbers(tag, "one"), "");
    assertEquals(coversExactlyOne(tag, "other"), false);
  }
});

test("hasPluralRules: whether the runtime's ICU data knows the language", () => {
  for (const tag of ["en", "pl", "pt-br", "zh-Hans", "iw", "ar-EG"]) {
    assertEquals(hasPluralRules(tag), true, tag);
    assertEquals(hasPluralRules(tag, { ordinal: true }), true, tag);
  }
  assertThrows(() => hasPluralRules("en_US"), RangeError);
});

test("pluralCategories: tags that differ only in case share rules", () => {
  assertEquals(pluralCategories("PT-br"), pluralCategories("pt-BR"));
  assertEquals(exampleNumbers("SR-latn", "few"), exampleNumbers("sr-Latn", "few"));
});

test("plural rules stay cached when cycling through many languages", () => {
  // Regression: the cache emptied itself at 200 entries, so cycling through more than 100
  // languages with cardinal and ordinal strings rebuilt the rules on every call.
  const languages = Intl.PluralRules.supportedLocalesOf(
    [..."abcdefghijklmnopqrstuvwxyz"].flatMap((a) =>
      [..."abcdefghijklmnopqrstuvwxyz"].map((b) => a + b),
    ),
  );
  assert(languages.length > 110, `only ${languages.length} languages`);
  const round = () => {
    for (let i = 0; i < 20; i++) {
      for (const language of languages) {
        coversExactlyOne(language, "one");
        coversExactlyOne(language, "one", { ordinal: true });
      }
    }
  };
  round();
  const started = performance.now();
  round();
  const elapsed = performance.now() - started;
  const calls = 40 * languages.length;
  assert(elapsed < 200, `${elapsed.toFixed(0)} ms for ${calls} cached calls`);
});

test("pluralCategories: returns a fresh list each time", () => {
  const first = pluralCategories("pl");
  first.pop();
  assertEquals(pluralCategories("pl"), ["one", "few", "many", "other"]);
});

test("pluralCategories: never relies on the order the runtime lists categories in", () => {
  const prototype = Intl.PluralRules.prototype;
  const original = prototype.resolvedOptions;
  // Node lists `few, many, one, other` for Polish; simulate a runtime that reverses them.
  prototype.resolvedOptions = function (this: Intl.PluralRules) {
    const options = original.call(this);
    return { ...options, pluralCategories: [...options.pluralCategories].reverse() };
  };
  try {
    // Tags used by no other test, so the results aren't cached yet.
    assertEquals(pluralCategories("uk-UA"), ["one", "few", "many", "other"]);
    assertEquals(pluralCategories("cy-GB"), ["zero", "one", "two", "few", "many", "other"]);
    assertEquals(pluralCategories("ga-IE", { ordinal: true }), ["one", "other"]);
  } finally {
    prototype.resolvedOptions = original;
  }
});

test("categoriesFor: zero only for cardinal strings whose English has it", () => {
  assertEquals(categoriesFor("pl", "plural", { one: "coin", other: "coins" }), [
    "one",
    "few",
    "many",
    "other",
  ]);
  assertEquals(categoriesFor("ja", "plural", { zero: "none", one: "coin", other: "coins" }), [
    "zero",
    "other",
  ]);
  assertEquals(categoriesFor("en", "ordinal", { zero: "0th", one: "st", other: "th" }), [
    "one",
    "two",
    "few",
    "other",
  ]);
  assertEquals(categoriesFor("fr", "plural", { other: "x" }, { cardinal: ["one", "other"] }), [
    "one",
    "other",
  ]);
});

/** Example numbers for every category of a language, in CLDR order. */
function examples(language: string, ordinal = false): Record<string, string> {
  const result: Record<string, string> = {};
  for (const category of pluralCategories(language, { ordinal })) {
    result[category] = exampleNumbers(language, category, { ordinal });
  }
  return result;
}

test("exampleNumbers: English", () => {
  assertEquals(examples("en"), { one: "1", other: "0, 2–1000, …, 1.5" });
  assertEquals(examples("en", true), {
    one: "1, 21, 31, …",
    two: "2, 22, 32, …",
    few: "3, 23, 33, …",
    other: "0, 4–20, 24–30, …",
  });
});

test("exampleNumbers: Polish", () => {
  assertEquals(examples("pl"), {
    one: "1",
    few: "2–4, 22–24, 32–34, …",
    many: "0, 5–21, 25–31, …",
    other: "1.5",
  });
  assertEquals(examples("pl", true), { other: "0–1000, …" });
});

test("exampleNumbers: Russian", () => {
  assertEquals(examples("ru"), {
    one: "1, 21, 31, …",
    few: "2–4, 22–24, 32–34, …",
    many: "0, 5–20, 25–30, …",
    other: "1.5",
  });
  assertEquals(examples("ru", true), { other: "0–1000, …" });
});

test("exampleNumbers: French, with many for millions", () => {
  assertEquals(examples("fr"), { one: "0–1, 1.5", many: "1000000", other: "2–1000, …, 2.5" });
  assertEquals(examples("fr", true), { one: "1", other: "0, 2–1000, …" });
});

test("exampleNumbers: Japanese", () => {
  assertEquals(examples("ja"), { other: "0–1000, …, 1.5" });
  assertEquals(examples("ja", true), { other: "0–1000, …" });
});

test("exampleNumbers: Arabic", () => {
  assertEquals(examples("ar"), {
    zero: "0",
    one: "1",
    two: "2",
    few: "3–10, 103–110, 203–210, …",
    many: "11–99, 111–199, 211–299, …",
    other: "100–102, 200–202, 300–302, …, 1.5",
  });
  assertEquals(examples("ar", true), { other: "0–1000, …" });
});

test("exampleNumbers: the decimal is the first of 1.5, 0.5, 2.5 and 10.5 that fits", () => {
  assertEquals(exampleNumbers("hi", "one"), "0–1, 0.5");
  assertEquals(exampleNumbers("he", "one"), "1, 0.5");
  assertEquals(exampleNumbers("pt", "other"), "2–1000, …, 2.5");
  assertEquals(exampleNumbers("cs", "many"), "1.5");
});

test("exampleNumbers: zero and categories the language doesn't have", () => {
  assertEquals(exampleNumbers("en", "zero"), "0");
  assertEquals(exampleNumbers("ja", "zero"), "0");
  assertEquals(exampleNumbers("pl", "zero"), "0");
  assertEquals(exampleNumbers("en", "zero", { ordinal: true }), "0");
  assertEquals(exampleNumbers("lv", "zero"), "0, 10–20, 30, …");
  assertEquals(exampleNumbers("en", "few"), "");
  assertEquals(exampleNumbers("ja", "one"), "");
});

test("exampleNumbers: with a zero form, 0 leaves the other categories", () => {
  // Regression: 0 goes to key_zero when English has a zero form, whatever the language.
  assertEquals(exampleNumbers("pa", "one"), "0–1");
  assertEquals(exampleNumbers("pa", "one", { zero: true }), "1");
  assertEquals(exampleNumbers("pl", "many"), "0, 5–21, 25–31, …");
  assertEquals(exampleNumbers("pl", "many", { zero: true }), "5–21, 25–31, 35–41, …");
  assertEquals(exampleNumbers("en", "other", { zero: true }), "2–1000, …, 1.5");
  assertEquals(exampleNumbers("ja", "other", { zero: true }), "1–1000, …, 1.5");
  assertEquals(exampleNumbers("en", "zero", { zero: true }), "0");
  assertEquals(exampleNumbers("lv", "zero", { zero: true }), "0, 10–20, 30, …");
  // Ordinal strings have no zero form: the option changes nothing.
  assertEquals(exampleNumbers("en", "other", { ordinal: true, zero: true }), "0, 4–20, 24–30, …");
});

test("exampleNumbers: maxRanges", () => {
  assertEquals(exampleNumbers("pl", "few", { maxRanges: 1 }), "2–4, …");
  assertEquals(exampleNumbers("pl", "few", { maxRanges: 5 }), "2–4, 22–24, 32–34, 42–44, 52–54, …");
  assertEquals(exampleNumbers("en", "other", { maxRanges: 1 }), "0, …, 1.5");
  assertEquals(exampleNumbers("en", "other", { maxRanges: 2 }), "0, 2–1000, …, 1.5");
  assertEquals(exampleNumbers("en", "one", { maxRanges: 1 }), "1");
  assertEquals(exampleNumbers("pl", "few", { maxRanges: 0 }), "2–4, …");
  // Every range up to 1000 shown: the ellipsis still says the category goes on.
  const all = exampleNumbers("ru", "one", { maxRanges: 1000 });
  assert(all.startsWith("1, 21, 31, 41, 51, 61, 71, 81, 91, 101, 121, "), all);
  assert(all.endsWith(", 971, 981, 991, …"), all);
  assertEquals(all.split(", ").length, 91);
});

test("exampleNumbers: ranges use an en dash and are deterministic", () => {
  const few = exampleNumbers("pl", "few");
  assertEquals(few.codePointAt(1), 0x2013);
  assertEquals(few.at(-1), "\u2026");
  assertEquals(exampleNumbers("pl", "few"), few);
});

test("coversExactlyOne", () => {
  const cases: [string, PluralCategory, boolean][] = [
    ["en", "one", true],
    ["en", "other", false],
    ["pl", "one", true],
    ["pl", "few", false],
    ["pl", "many", false],
    ["pl", "other", false],
    ["ru", "one", false],
    ["ru", "other", false],
    ["fr", "one", false],
    ["fr", "many", false],
    ["fr", "other", false],
    ["ja", "other", false],
    ["ar", "zero", true],
    ["ar", "one", true],
    ["ar", "two", true],
    ["ar", "few", false],
    ["ar", "many", false],
    ["ar", "other", false],
    ["he", "one", false], // 1 and 0.5
    ["he", "two", true],
    ["hi", "one", false], // 0, 1 and 0.5
    ["cy", "few", true],
    ["cy", "many", true],
    ["lv", "zero", false],
  ];
  for (const [language, category, expected] of cases) {
    assertEquals(coversExactlyOne(language, category), expected, `${language} ${category}`);
  }
});

test("coversExactlyOne: zero the language doesn't have, and missing categories", () => {
  assertEquals(coversExactlyOne("en", "zero"), true);
  assertEquals(coversExactlyOne("ja", "zero"), true);
  assertEquals(coversExactlyOne("pl", "zero"), true);
  assertEquals(coversExactlyOne("en", "few"), false);
  assertEquals(coversExactlyOne("ja", "one"), false);
});

test("coversExactlyOne: with a zero form, 0 leaves the other categories", () => {
  // Regression: Punjabi one is 0–1, but with a zero form it is only used for 1.
  for (const language of ["pa", "ln", "ak", "mg", "ti", "nso", "wa", "bho"]) {
    assertEquals(coversExactlyOne(language, "one"), false, language);
    assertEquals(coversExactlyOne(language, "one", { zero: true }), true, language);
  }
  assertEquals(coversExactlyOne("pl", "one", { zero: true }), true);
  assertEquals(coversExactlyOne("fr", "one", { zero: true }), false); // 1 and 1.5
  assertEquals(coversExactlyOne("hi", "one", { zero: true }), false); // 1 and 0.5
  assertEquals(coversExactlyOne("en", "zero", { zero: true }), true);
  assertEquals(coversExactlyOne("lv", "zero", { zero: true }), false);
  assertEquals(coversExactlyOne("ja", "other", { zero: true }), false);
  // Ordinal strings have no zero form: the option changes nothing.
  assertEquals(coversExactlyOne("en", "other", { ordinal: true, zero: true }), false);
});

test("coversExactlyOne: ordinals count integers only", () => {
  assertEquals(coversExactlyOne("en", "one", { ordinal: true }), false);
  assertEquals(coversExactlyOne("fr", "one", { ordinal: true }), true);
  assertEquals(coversExactlyOne("hi", "few", { ordinal: true }), true);
  assertEquals(coversExactlyOne("hi", "two", { ordinal: true }), false);
  assertEquals(coversExactlyOne("pl", "other", { ordinal: true }), false);
});
