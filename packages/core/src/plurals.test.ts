// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import {
  categoriesFor,
  coversExactlyOne,
  exampleNumber,
  exampleNumbers,
  hasPluralRules,
  pluralCategories,
  pluralCategoryOf,
  sortCategories,
} from "./plurals.ts";
import type { PluralCategory } from "./types.ts";

test("sortCategories: CLDR order, without duplicates or unknown names", () => {
  expect(sortCategories(["other", "many", "one", "few"])).toStrictEqual([
    "one",
    "few",
    "many",
    "other",
  ]);
  expect(sortCategories(["other", "zero", "two", "other", "plural", ""])).toStrictEqual([
    "zero",
    "two",
    "other",
  ]);
  expect(sortCategories([])).toStrictEqual([]);
});

test("pluralCategories: cardinal categories in CLDR order", () => {
  expect(pluralCategories("en")).toStrictEqual(["one", "other"]);
  expect(pluralCategories("en-GB")).toStrictEqual(["one", "other"]);
  expect(pluralCategories("pl")).toStrictEqual(["one", "few", "many", "other"]);
  expect(pluralCategories("ru")).toStrictEqual(["one", "few", "many", "other"]);
  expect(pluralCategories("fr")).toStrictEqual(["one", "many", "other"]);
  expect(pluralCategories("ja")).toStrictEqual(["other"]);
  expect(pluralCategories("zh-Hans")).toStrictEqual(["other"]);
  expect(pluralCategories("ar")).toStrictEqual(["zero", "one", "two", "few", "many", "other"]);
  expect(pluralCategories("pt-BR")).toStrictEqual(["one", "many", "other"]);
  expect(pluralCategories("sr-Latn")).toStrictEqual(["one", "few", "other"]);
});

test("pluralCategories: ordinal categories", () => {
  const ordinal = { ordinal: true };
  expect(pluralCategories("en", ordinal)).toStrictEqual(["one", "two", "few", "other"]);
  expect(pluralCategories("pl", ordinal)).toStrictEqual(["other"]);
  expect(pluralCategories("fr", ordinal)).toStrictEqual(["one", "other"]);
  expect(pluralCategories("ja", ordinal)).toStrictEqual(["other"]);
  expect(pluralCategories("cy", ordinal)).toStrictEqual([
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
});

test("pluralCategories: zero is added when English has a zero form", () => {
  expect(pluralCategories("en", { zero: true })).toStrictEqual(["zero", "one", "other"]);
  expect(pluralCategories("ja", { zero: true })).toStrictEqual(["zero", "other"]);
  expect(pluralCategories("pl", { zero: true })).toStrictEqual([
    "zero",
    "one",
    "few",
    "many",
    "other",
  ]);
  expect(pluralCategories("ar", { zero: true })).toStrictEqual([
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
  expect(pluralCategories("en", { zero: false })).toStrictEqual(["one", "other"]);
});

test("pluralCategories: an override replaces the categories, sorted, with other", () => {
  const override = { cardinal: ["other", "one"] as PluralCategory[] };
  expect(pluralCategories("fr", { override })).toStrictEqual(["one", "other"]);
  expect(pluralCategories("fr", { override: { cardinal: ["one"] } })).toStrictEqual([
    "one",
    "other",
  ]);
  expect(pluralCategories("fr", { override: { cardinal: [] } })).toStrictEqual(["other"]);
  expect(
    pluralCategories("fr", { override: { cardinal: ["one", "one"] }, zero: true }),
  ).toStrictEqual(["zero", "one", "other"]);
  // Each list replaces only its own type.
  const ordinalOnly = { ordinal: ["other", "one", "few"] as PluralCategory[] };
  expect(pluralCategories("fr", { override: ordinalOnly })).toStrictEqual(["one", "many", "other"]);
  expect(pluralCategories("fr", { override: ordinalOnly, ordinal: true })).toStrictEqual([
    "one",
    "few",
    "other",
  ]);
  // Names that aren't categories are dropped.
  const unknown = { cardinal: ["one", "plural"] as unknown as PluralCategory[] };
  expect(pluralCategories("en", { override: unknown })).toStrictEqual(["one", "other"]);
});

test("pluralCategories: invalid tags throw a RangeError", () => {
  for (const tag of ["", "en_US", " en", "e", "en-", "@"]) {
    expect(() => pluralCategories(tag)).toThrow(undefined);
    expect(() => exampleNumbers(tag, "other")).toThrow(RangeError);
    expect(() => coversExactlyOne(tag, "other")).toThrow(RangeError);
  }
  expect(() => pluralCategories("en_US", { override: { cardinal: ["other"] } })).toThrow(
    RangeError,
  );
});

test("pluralCategories: aliases and languages the runtime doesn't know", () => {
  expect(pluralCategories("iw")).toStrictEqual(pluralCategories("he"));
  expect(pluralCategories("he")).toStrictEqual(["one", "two", "other"]);
  expect(pluralCategories("tl")).toStrictEqual(["one", "other"]);
  expect(pluralCategories("sh")).toStrictEqual(["one", "few", "other"]);
  // Not the runtime's default locale, which changes from one machine to the next: CLDR root.
  for (const tag of ["xyz", "tlh", "und", "zzz-Latn"]) {
    expect(hasPluralRules(tag), tag).toBe(false);
    expect(hasPluralRules(tag, { ordinal: true }), tag).toBe(false);
    expect(pluralCategories(tag), tag).toStrictEqual(["other"]);
    expect(pluralCategories(tag, { ordinal: true }), tag).toStrictEqual(["other"]);
    expect(exampleNumbers(tag, "other")).toBe("0–1000, …, 1.5");
    expect(exampleNumbers(tag, "one")).toBe("");
    expect(coversExactlyOne(tag, "other")).toBe(false);
  }
});

test("hasPluralRules: whether the runtime's ICU data knows the language", () => {
  for (const tag of ["en", "pl", "pt-br", "zh-Hans", "iw", "ar-EG"]) {
    expect(hasPluralRules(tag), tag).toBe(true);
    expect(hasPluralRules(tag, { ordinal: true }), tag).toBe(true);
  }
  expect(() => hasPluralRules("en_US")).toThrow(RangeError);
});

test("pluralCategories: tags that differ only in case share rules", () => {
  expect(pluralCategories("PT-br")).toStrictEqual(pluralCategories("pt-BR"));
  expect(exampleNumbers("SR-latn", "few")).toStrictEqual(exampleNumbers("sr-Latn", "few"));
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
  expect(pluralCategories("pl")).toStrictEqual(["one", "few", "many", "other"]);
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
    expect(pluralCategories("uk-UA")).toStrictEqual(["one", "few", "many", "other"]);
    expect(pluralCategories("cy-GB")).toStrictEqual(["zero", "one", "two", "few", "many", "other"]);
    expect(pluralCategories("ga-IE", { ordinal: true })).toStrictEqual(["one", "other"]);
  } finally {
    prototype.resolvedOptions = original;
  }
});

test("categoriesFor: zero only for cardinal strings whose English has it", () => {
  expect(categoriesFor("pl", "plural", { one: "coin", other: "coins" })).toStrictEqual([
    "one",
    "few",
    "many",
    "other",
  ]);
  expect(
    categoriesFor("ja", "plural", { zero: "none", one: "coin", other: "coins" }),
  ).toStrictEqual(["zero", "other"]);
  expect(categoriesFor("en", "ordinal", { zero: "0th", one: "st", other: "th" })).toStrictEqual([
    "one",
    "two",
    "few",
    "other",
  ]);
  expect(
    categoriesFor("fr", "plural", { other: "x" }, { cardinal: ["one", "other"] }),
  ).toStrictEqual(["one", "other"]);
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
  expect(examples("en")).toStrictEqual({ one: "1", other: "0, 2–1000, …, 1.5" });
  expect(examples("en", true)).toStrictEqual({
    one: "1, 21, 31, …",
    two: "2, 22, 32, …",
    few: "3, 23, 33, …",
    other: "0, 4–20, 24–30, …",
  });
});

test("exampleNumbers: Polish", () => {
  expect(examples("pl")).toStrictEqual({
    one: "1",
    few: "2–4, 22–24, 32–34, …",
    many: "0, 5–21, 25–31, …",
    other: "1.5",
  });
  expect(examples("pl", true)).toStrictEqual({ other: "0–1000, …" });
});

test("exampleNumbers: Russian", () => {
  expect(examples("ru")).toStrictEqual({
    one: "1, 21, 31, …",
    few: "2–4, 22–24, 32–34, …",
    many: "0, 5–20, 25–30, …",
    other: "1.5",
  });
  expect(examples("ru", true)).toStrictEqual({ other: "0–1000, …" });
});

test("exampleNumbers: French, with many for millions", () => {
  expect(examples("fr")).toStrictEqual({
    one: "0–1, 1.5",
    many: "1000000",
    other: "2–1000, …, 2.5",
  });
  expect(examples("fr", true)).toStrictEqual({ one: "1", other: "0, 2–1000, …" });
});

test("exampleNumbers: Japanese", () => {
  expect(examples("ja")).toStrictEqual({ other: "0–1000, …, 1.5" });
  expect(examples("ja", true)).toStrictEqual({ other: "0–1000, …" });
});

test("exampleNumbers: Arabic", () => {
  expect(examples("ar")).toStrictEqual({
    zero: "0",
    one: "1",
    two: "2",
    few: "3–10, 103–110, 203–210, …",
    many: "11–99, 111–199, 211–299, …",
    other: "100–102, 200–202, 300–302, …, 1.5",
  });
  expect(examples("ar", true)).toStrictEqual({ other: "0–1000, …" });
});

test("exampleNumbers: the decimal is the first of 1.5, 0.5, 2.5 and 10.5 that fits", () => {
  expect(exampleNumbers("hi", "one")).toBe("0–1, 0.5");
  expect(exampleNumbers("he", "one")).toBe("1, 0.5");
  expect(exampleNumbers("pt", "other")).toBe("2–1000, …, 2.5");
  expect(exampleNumbers("cs", "many")).toBe("1.5");
});

test("exampleNumbers: zero and categories the language doesn't have", () => {
  expect(exampleNumbers("en", "zero")).toBe("0");
  expect(exampleNumbers("ja", "zero")).toBe("0");
  expect(exampleNumbers("pl", "zero")).toBe("0");
  expect(exampleNumbers("en", "zero", { ordinal: true })).toBe("0");
  expect(exampleNumbers("lv", "zero")).toBe("0, 10–20, 30, …");
  expect(exampleNumbers("en", "few")).toBe("");
  expect(exampleNumbers("ja", "one")).toBe("");
});

test("exampleNumbers: with a zero form, 0 leaves the other categories", () => {
  // Regression: 0 goes to key_zero when English has a zero form, whatever the language.
  expect(exampleNumbers("pa", "one")).toBe("0–1");
  expect(exampleNumbers("pa", "one", { zero: true })).toBe("1");
  expect(exampleNumbers("pl", "many")).toBe("0, 5–21, 25–31, …");
  expect(exampleNumbers("pl", "many", { zero: true })).toBe("5–21, 25–31, 35–41, …");
  expect(exampleNumbers("en", "other", { zero: true })).toBe("2–1000, …, 1.5");
  expect(exampleNumbers("ja", "other", { zero: true })).toBe("1–1000, …, 1.5");
  expect(exampleNumbers("en", "zero", { zero: true })).toBe("0");
  expect(exampleNumbers("lv", "zero", { zero: true })).toBe("0, 10–20, 30, …");
  // Ordinal strings have no zero form: the option changes nothing.
  expect(exampleNumbers("en", "other", { ordinal: true, zero: true })).toStrictEqual(
    "0, 4–20, 24–30, …",
  );
});

test("exampleNumbers: maxRanges", () => {
  expect(exampleNumbers("pl", "few", { maxRanges: 1 })).toBe("2–4, …");
  expect(exampleNumbers("pl", "few", { maxRanges: 5 })).toStrictEqual(
    "2–4, 22–24, 32–34, 42–44, 52–54, …",
  );
  expect(exampleNumbers("en", "other", { maxRanges: 1 })).toBe("0, …, 1.5");
  expect(exampleNumbers("en", "other", { maxRanges: 2 })).toBe("0, 2–1000, …, 1.5");
  expect(exampleNumbers("en", "one", { maxRanges: 1 })).toBe("1");
  expect(exampleNumbers("pl", "few", { maxRanges: 0 })).toBe("2–4, …");
  // Every range up to 1000 shown: the ellipsis still says the category goes on.
  const all = exampleNumbers("ru", "one", { maxRanges: 1000 });
  assert(all.startsWith("1, 21, 31, 41, 51, 61, 71, 81, 91, 101, 121, "), all);
  assert(all.endsWith(", 971, 981, 991, …"), all);
  expect(all.split(", ").length).toBe(91);
});

test("exampleNumbers: ranges use an en dash and are deterministic", () => {
  const few = exampleNumbers("pl", "few");
  expect(few.codePointAt(1)).toStrictEqual(0x2013);
  expect(few.at(-1)).toBe("\u2026");
  expect(exampleNumbers("pl", "few")).toStrictEqual(few);
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
    expect(coversExactlyOne(language, category), `${language} ${category}`).toStrictEqual(expected);
  }
});

test("coversExactlyOne: zero the language doesn't have, and missing categories", () => {
  expect(coversExactlyOne("en", "zero")).toBe(true);
  expect(coversExactlyOne("ja", "zero")).toBe(true);
  expect(coversExactlyOne("pl", "zero")).toBe(true);
  expect(coversExactlyOne("en", "few")).toBe(false);
  expect(coversExactlyOne("ja", "one")).toBe(false);
});

test("coversExactlyOne: with a zero form, 0 leaves the other categories", () => {
  // Regression: Punjabi one is 0–1, but with a zero form it is only used for 1.
  for (const language of ["pa", "ln", "ak", "mg", "ti", "nso", "wa", "bho"]) {
    expect(coversExactlyOne(language, "one"), language).toBe(false);
    expect(coversExactlyOne(language, "one", { zero: true }), language).toBe(true);
  }
  expect(coversExactlyOne("pl", "one", { zero: true })).toBe(true);
  expect(coversExactlyOne("fr", "one", { zero: true })).toBe(false); // 1 and 1.5
  expect(coversExactlyOne("hi", "one", { zero: true })).toBe(false); // 1 and 0.5
  expect(coversExactlyOne("en", "zero", { zero: true })).toBe(true);
  expect(coversExactlyOne("lv", "zero", { zero: true })).toBe(false);
  expect(coversExactlyOne("ja", "other", { zero: true })).toBe(false);
  // Ordinal strings have no zero form: the option changes nothing.
  expect(coversExactlyOne("en", "other", { ordinal: true, zero: true })).toBe(false);
});

test("coversExactlyOne: ordinals count integers only", () => {
  expect(coversExactlyOne("en", "one", { ordinal: true })).toBe(false);
  expect(coversExactlyOne("fr", "one", { ordinal: true })).toBe(true);
  expect(coversExactlyOne("hi", "few", { ordinal: true })).toBe(true);
  expect(coversExactlyOne("hi", "two", { ordinal: true })).toBe(false);
  expect(coversExactlyOne("pl", "other", { ordinal: true })).toBe(false);
});

test("exampleNumber: the smallest integer of the category", () => {
  expect(exampleNumber("pl", "one")).toBe(1);
  expect(exampleNumber("pl", "few")).toBe(2);
  expect(exampleNumber("pl", "many")).toBe(0);
  expect(exampleNumber("es", "other")).toBe(0);
});

test("exampleNumber: leaving out the numbers of exact cases", () => {
  expect(exampleNumber("es", "other", { except: [0] })).toBe(2);
  expect(exampleNumber("pl", "many", { except: [0, 5] })).toBe(6);
});

test("exampleNumber: 1000000 or a decimal when no integer up to 1000 is in it", () => {
  expect(exampleNumber("es", "many")).toBe(1000000);
  expect(exampleNumber("pl", "other")).toBe(1.5);
});

test("exampleNumber: ordinal categories, and categories the language doesn't have", () => {
  expect(exampleNumber("en", "few", { ordinal: true })).toBe(3);
  expect(exampleNumber("de", "other", { ordinal: true })).toBe(1);
  expect(exampleNumber("en", "many")).toBe(undefined);
});

test("pluralCategoryOf: the category apps pick for a number", () => {
  expect(pluralCategoryOf("pl", 22)).toBe("few");
  expect(pluralCategoryOf("pl", 25)).toBe("many");
  expect(pluralCategoryOf("en", 2, { ordinal: true })).toBe("two");
  expect(pluralCategoryOf("tlh", 1)).toBe("other");
});
