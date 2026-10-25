// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { icuWithLanguageCases } from "./icu_cases.ts";

test("icuWithLanguageCases: plural blocks get the language's categories", () => {
  const english = "{n, plural, one {# apple} other {# apples}}";
  assertEquals(
    icuWithLanguageCases(english, "es"),
    "{n, plural, one {# apple} many {# apples} other {# apples}}",
  );
  assertEquals(
    icuWithLanguageCases(english, "pl"),
    "{n, plural, one {# apple} few {# apples} many {# apples} other {# apples}}",
  );
  assertEquals(icuWithLanguageCases(english, "ja"), "{n, plural, other {# apples}}");
});

test("icuWithLanguageCases: exact cases stay, first", () => {
  assertEquals(
    icuWithLanguageCases("{n, plural, one {# apple} =0 {No apples} other {# apples}}", "ja"),
    "{n, plural, =0 {No apples} other {# apples}}",
  );
});

test("icuWithLanguageCases: ordinal categories the language doesn't use go", () => {
  assertEquals(
    icuWithLanguageCases("{p, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", "es"),
    "{p, selectordinal, other {#th}}",
  );
});

test("icuWithLanguageCases: select blocks stay as they are, nested plurals adapt", () => {
  const english =
    "{host, select, female {{n, plural, one {She invites one} other {She invites #}}} other {They invite}}";
  assertEquals(
    icuWithLanguageCases(english, "fr"),
    "{host, select, female {{n, plural, one {She invites one} many {She invites #} other {She invites #}}} other {They invite}}",
  );
});

test("icuWithLanguageCases: a zero case of the English stays for every language", () => {
  assertEquals(
    icuWithLanguageCases("{n, plural, zero {none} one {#} other {#s}}", "ja"),
    "{n, plural, zero {none} other {#s}}",
  );
});

test("icuWithLanguageCases: text around blocks, layout and the plural override stay", () => {
  const english = "Found {n, plural,\n  one {# coin}\n  other {# coins}\n} today.";
  assertEquals(
    icuWithLanguageCases(english, "cv", { cardinal: ["one", "other"] }),
    "Found {n, plural,\n  one {# coin}\n  other {# coins}\n} today.",
  );
  assertEquals(
    icuWithLanguageCases(english, "lt"),
    "Found {n, plural,\n  one {# coin}\n  few {# coins}\n  many {# coins}\n  other {# coins}\n} today.",
  );
});

test("icuWithLanguageCases: text without blocks is unchanged", () => {
  assertEquals(icuWithLanguageCases("Hello '{'{name}'}'!", "es"), "Hello '{'{name}'}'!");
});
