// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { SUPPORTED_LANGUAGES } from "./language_catalog.ts";

// The runtime's ICU may lack plural rules or names for some tags: the catalog carries its
// own names, and plurals.ts handles languages without rules.
test("the fixed catalog has unique canonical tags and English/native names", () => {
  const tags = SUPPORTED_LANGUAGES.map(({ tag }) => tag);
  expect(new Set(tags).size).toStrictEqual(tags.length);
  expect(Intl.getCanonicalLocales(tags)).toStrictEqual(tags);
  assert(
    SUPPORTED_LANGUAGES.every(({ name, nativeName }) => name.length > 0 && nativeName.length > 0),
  );
  expect(SUPPORTED_LANGUAGES.find(({ tag }) => tag === "ja")).toStrictEqual({
    tag: "ja",
    name: "Japanese",
    nativeName: "日本語",
  });
  expect(SUPPORTED_LANGUAGES.find(({ tag }) => tag === "pt-BR")?.name).toStrictEqual(
    "Portuguese (Brazil)",
  );
});
