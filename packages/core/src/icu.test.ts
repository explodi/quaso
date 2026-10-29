// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { icuSyntaxError, unquoteIcu } from "./icu.ts";

test("unquoteIcu: quoted braces, doubled apostrophes and plain apostrophes", () => {
  expect(unquoteIcu("Type '{'name'}' here")).toBe("Type {name} here");
  expect(unquoteIcu("'{name}' stays")).toBe("{name} stays");
  expect(unquoteIcu("it''s")).toBe("it's");
  expect(unquoteIcu("l'arbre")).toBe("l'arbre");
  expect(unquoteIcu("'{it''s}'")).toBe("{it's}");
});

test("unquoteIcu: '#' is quoted only in a plural case", () => {
  expect(unquoteIcu("'#' 1", true)).toBe("# 1");
  expect(unquoteIcu("'#' 1")).toBe("'#' 1");
});

test("unquoteIcu: unclosed quoted text runs to the end", () => {
  expect(unquoteIcu("a '{b c")).toBe("a {b c");
});

test("icuSyntaxError: valid messages have none", () => {
  expect(icuSyntaxError("Hello, {name}! You owe {n, number, ::currency/EUR}.")).toBe(null);
  expect(icuSyntaxError("{n, plural, offset:1 =0 {none} one {#} other {# '{'x'}'}}")).toStrictEqual(
    null,
  );
  expect(icuSyntaxError("{a, select, x {{b, plural, other {#}}} other {}}")).toBe(null);
});

test("icuSyntaxError: a { that is never closed", () => {
  expect(icuSyntaxError("Hello, {name")).toStrictEqual({
    message: "This { is never closed.",
    at: 7,
  });
  expect(icuSyntaxError("{n, plural, one {# coin} other {# coins}")).toStrictEqual({
    message: "This { is never closed.",
    at: 0,
  });
  expect(icuSyntaxError("{n, plural, one {# coin")).toStrictEqual({
    message: "This { is never closed.",
    at: 16,
  });
});

test("icuSyntaxError: a { that starts no argument, and a } that closes nothing", () => {
  expect(icuSyntaxError("Use {} here")).toStrictEqual({
    message: "This { doesn't start an argument such as {name}. A brace as text is written '{'.",
    at: 4,
  });
  expect(icuSyntaxError("Done.}")).toStrictEqual({ message: "This } closes nothing.", at: 5 });
});

test("icuSyntaxError: a block's cases", () => {
  expect(icuSyntaxError("{n, plural}")).toStrictEqual({
    message: "The {n, plural} block has no cases.",
    at: 0,
  });
  expect(icuSyntaxError("{g, select, female {Her} male {His}}")).toStrictEqual({
    message: "The {g, select} block has no other case.",
    at: 0,
  });
  expect(icuSyntaxError("{g, select, female} other {Their}}")).toStrictEqual({
    message: "The case “female” of {g, select} has no text in braces.",
    at: 12,
  });
  expect(
    icuSyntaxError("{p, selectordinal, other {#.}} place, {p, selectordinal, other {#.} place."),
  ).toStrictEqual({
    message: "The {p, selectordinal} block has no } after its last case.",
    at: 68,
  });
  expect(icuSyntaxError("{g, select, a b {x} other {y}}")).toStrictEqual({
    message: "“a b” isn't a case of {g, select}.",
    at: 12,
  });
});

test("icuSyntaxError: the innermost problem of nested blocks", () => {
  expect(icuSyntaxError("{g, select, other {{n, plural, one {x}}}}")).toStrictEqual({
    message: "The {n, plural} block has no other case.",
    at: 19,
  });
});
