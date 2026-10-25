// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { icuSyntaxError, unquoteIcu } from "./icu.ts";

test("unquoteIcu: quoted braces, doubled apostrophes and plain apostrophes", () => {
  assertEquals(unquoteIcu("Type '{'name'}' here"), "Type {name} here");
  assertEquals(unquoteIcu("'{name}' stays"), "{name} stays");
  assertEquals(unquoteIcu("it''s"), "it's");
  assertEquals(unquoteIcu("l'arbre"), "l'arbre");
  assertEquals(unquoteIcu("'{it''s}'"), "{it's}");
});

test("unquoteIcu: '#' is quoted only in a plural case", () => {
  assertEquals(unquoteIcu("'#' 1", true), "# 1");
  assertEquals(unquoteIcu("'#' 1"), "'#' 1");
});

test("unquoteIcu: unclosed quoted text runs to the end", () => {
  assertEquals(unquoteIcu("a '{b c"), "a {b c");
});

test("icuSyntaxError: valid messages have none", () => {
  assertEquals(icuSyntaxError("Hello, {name}! You owe {n, number, ::currency/EUR}."), null);
  assertEquals(icuSyntaxError("{n, plural, offset:1 =0 {none} one {#} other {# '{'x'}'}}"), null);
  assertEquals(icuSyntaxError("{a, select, x {{b, plural, other {#}}} other {}}"), null);
});

test("icuSyntaxError: a { that is never closed", () => {
  assertEquals(icuSyntaxError("Hello, {name"), { message: "This { is never closed.", at: 7 });
  assertEquals(icuSyntaxError("{n, plural, one {# coin} other {# coins}"), {
    message: "This { is never closed.",
    at: 0,
  });
  assertEquals(icuSyntaxError("{n, plural, one {# coin"), {
    message: "This { is never closed.",
    at: 16,
  });
});

test("icuSyntaxError: a { that starts no argument, and a } that closes nothing", () => {
  assertEquals(icuSyntaxError("Use {} here"), {
    message: "This { doesn't start an argument such as {name}. A brace as text is written '{'.",
    at: 4,
  });
  assertEquals(icuSyntaxError("Done.}"), { message: "This } closes nothing.", at: 5 });
});

test("icuSyntaxError: a block's cases", () => {
  assertEquals(icuSyntaxError("{n, plural}"), {
    message: "The {n, plural} block has no cases.",
    at: 0,
  });
  assertEquals(icuSyntaxError("{g, select, female {Her} male {His}}"), {
    message: "The {g, select} block has no other case.",
    at: 0,
  });
  assertEquals(icuSyntaxError("{g, select, female} other {Their}}"), {
    message: "The case “female” of {g, select} has no text in braces.",
    at: 12,
  });
  assertEquals(
    icuSyntaxError("{p, selectordinal, other {#.}} place, {p, selectordinal, other {#.} place."),
    {
      message: "The {p, selectordinal} block has no } after its last case.",
      at: 68,
    },
  );
  assertEquals(icuSyntaxError("{g, select, a b {x} other {y}}"), {
    message: "“a b” isn't a case of {g, select}.",
    at: 12,
  });
});

test("icuSyntaxError: the innermost problem of nested blocks", () => {
  assertEquals(icuSyntaxError("{g, select, other {{n, plural, one {x}}}}"), {
    message: "The {n, plural} block has no other case.",
    at: 19,
  });
});
