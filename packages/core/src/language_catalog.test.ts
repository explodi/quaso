// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@std/assert";
import { SUPPORTED_LANGUAGES } from "./language_catalog.ts";

// The runtime's ICU may lack plural rules or names for some tags: the catalog carries its
// own names, and plurals.ts handles languages without rules.
test("the fixed catalog has unique canonical tags and English/native names", () => {
  const tags = SUPPORTED_LANGUAGES.map(({ tag }) => tag);
  assertEquals(new Set(tags).size, tags.length);
  assertEquals(Intl.getCanonicalLocales(tags), tags);
  assert(
    SUPPORTED_LANGUAGES.every(({ name, nativeName }) => name.length > 0 && nativeName.length > 0),
  );
  assertEquals(
    SUPPORTED_LANGUAGES.find(({ tag }) => tag === "ja"),
    { tag: "ja", name: "Japanese", nativeName: "日本語" },
  );
  assertEquals(SUPPORTED_LANGUAGES.find(({ tag }) => tag === "pt-BR")?.name, "Portuguese (Brazil)");
});
