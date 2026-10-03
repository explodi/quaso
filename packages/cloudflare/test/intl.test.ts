// SPDX-License-Identifier: MIT
/**
 * Plural rules in workerd (S0.3): the service decides each language's plural categories
 * with the runtime's `Intl.PluralRules`, so workerd must agree with CLDR (and with Bun)
 * for the languages we test everywhere.
 */
import { pluralCategories } from "@quaso/core";
import { describe, expect, it } from "vitest";

const EXPECTED: Record<string, { cardinal: string[]; ordinal: string[] }> = {
  en: { cardinal: ["one", "other"], ordinal: ["one", "two", "few", "other"] },
  pl: { cardinal: ["one", "few", "many", "other"], ordinal: ["other"] },
  ru: { cardinal: ["one", "few", "many", "other"], ordinal: ["other"] },
  ar: { cardinal: ["zero", "one", "two", "few", "many", "other"], ordinal: ["other"] },
  ja: { cardinal: ["other"], ordinal: ["other"] },
  fr: { cardinal: ["one", "many", "other"], ordinal: ["one", "other"] },
};

describe("plural categories in workerd", () => {
  for (const [language, expected] of Object.entries(EXPECTED)) {
    it(language, () => {
      expect(pluralCategories(language)).toEqual(expected.cardinal);
      expect(pluralCategories(language, { ordinal: true })).toEqual(expected.ordinal);
      const raw = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
      expect(new Set(raw)).toEqual(new Set(expected.cardinal));
      expect(new Intl.PluralRules(language).select(1)).toBe(language === "ja" ? "other" : "one");
    });
  }

  it("picks the right forms for sample numbers", () => {
    const pl = new Intl.PluralRules("pl");
    expect([1, 2, 5, 22, 25, 1.5].map((n) => pl.select(n))).toEqual([
      "one",
      "few",
      "many",
      "few",
      "many",
      "other",
    ]);
    const ar = new Intl.PluralRules("ar");
    expect([0, 1, 2, 3, 11, 100].map((n) => ar.select(n))).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
    expect(new Intl.PluralRules("fr").select(1_000_000)).toBe("many");
  });
});
