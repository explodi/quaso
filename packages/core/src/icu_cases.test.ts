// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { icuWithLanguageCases } from "./icu_cases.ts";

test("icuWithLanguageCases: plural blocks get the language's categories", () => {
  const english = "{n, plural, one {# apple} other {# apples}}";
  expect(icuWithLanguageCases(english, "es")).toStrictEqual(
    "{n, plural, one {# apple} many {# apples} other {# apples}}",
  );
  expect(icuWithLanguageCases(english, "pl")).toStrictEqual(
    "{n, plural, one {# apple} few {# apples} many {# apples} other {# apples}}",
  );
  expect(icuWithLanguageCases(english, "ja")).toBe("{n, plural, other {# apples}}");
});

test("icuWithLanguageCases: exact cases stay, first", () => {
  expect(
    icuWithLanguageCases("{n, plural, one {# apple} =0 {No apples} other {# apples}}", "ja"),
  ).toBe("{n, plural, =0 {No apples} other {# apples}}");
});

test("icuWithLanguageCases: ordinal categories the language doesn't use go", () => {
  expect(
    icuWithLanguageCases("{p, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", "es"),
  ).toBe("{p, selectordinal, other {#th}}");
});

test("icuWithLanguageCases: select blocks stay as they are, nested plurals adapt", () => {
  const english =
    "{host, select, female {{n, plural, one {She invites one} other {She invites #}}} other {They invite}}";
  expect(icuWithLanguageCases(english, "fr")).toStrictEqual(
    "{host, select, female {{n, plural, one {She invites one} many {She invites #} other {She invites #}}} other {They invite}}",
  );
});

test("icuWithLanguageCases: a zero case of the English stays for every language", () => {
  expect(icuWithLanguageCases("{n, plural, zero {none} one {#} other {#s}}", "ja")).toStrictEqual(
    "{n, plural, zero {none} other {#s}}",
  );
});

test("icuWithLanguageCases: text around blocks, layout and the plural override stay", () => {
  const english = "Found {n, plural,\n  one {# coin}\n  other {# coins}\n} today.";
  expect(icuWithLanguageCases(english, "cv", { cardinal: ["one", "other"] })).toStrictEqual(
    "Found {n, plural,\n  one {# coin}\n  other {# coins}\n} today.",
  );
  expect(icuWithLanguageCases(english, "lt")).toStrictEqual(
    "Found {n, plural,\n  one {# coin}\n  few {# coins}\n  many {# coins}\n  other {# coins}\n} today.",
  );
});

test("icuWithLanguageCases: text without blocks is unchanged", () => {
  expect(icuWithLanguageCases("Hello '{'{name}'}'!", "es")).toBe("Hello '{'{name}'}'!");
});
