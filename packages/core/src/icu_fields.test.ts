// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { icuFieldForm, quoteField, writeIcuFieldForm } from "./icu_fields.ts";

const PARTY =
  "{host, select, female {{n, plural, =0 {{name} stays home.} one {{name} invites # friend.} other {{name} invites # friends.}}} other {{n, plural, =0 {{name} stays home.} one {{name} invites # friend.} other {{name} invites # friends.}}}}";
const SIGNED = "{author} signed {g, select, female {her} other {their}} book.";

function paths(english: string, translation: string, language: string): string[] {
  const form = icuFieldForm(english, translation, language);
  assert(form !== null);
  return form.fields.map((field) => field.path.map((step) => step.key).join(" › "));
}

test("icuFieldForm: one field per case, with the language's plural cases", () => {
  expect(paths(PARTY, "", "es")).toStrictEqual([
    "female › =0",
    "female › one",
    "female › many",
    "female › other",
    "other › =0",
    "other › one",
    "other › many",
    "other › other",
  ]);
});

test("icuFieldForm: an empty translation gives empty fields with their English", () => {
  const form = icuFieldForm(PARTY, "", "es");
  expect(form?.fields[2].text).toBe("");
  expect(form?.fields[2].plural).toBe(true);
  expect(form?.fields[2].english).toStrictEqual([
    { type: "argument", text: "{name}" },
    { type: "text", text: " invites " },
    { type: "number", text: "#" },
    { type: "text", text: " friends." },
  ]);
});

test("icuFieldForm: text around a block is a field where the English has text", () => {
  const form = icuFieldForm(SIGNED, "", "es");
  expect(
    form?.fields.map((field) => [
      field.afterBlock,
      field.path.map((step) => step.key),
      field.beforeBlock,
    ]),
  ).toStrictEqual([
    [undefined, [], "g"],
    [undefined, ["female"], undefined],
    [undefined, ["other"], undefined],
    ["g", [], undefined],
  ]);
  expect(form?.fields[0].text).toBe("");
  expect(form?.fields[3].english).toStrictEqual([{ type: "text", text: " book." }]);
});

test("icuFieldForm: a translation's texts, quotes resolved", () => {
  const form = icuFieldForm(
    SIGNED,
    "{author} a signé {g, select, female {son livre '{'dédicacé'}'} other {l''ouvrage}}.",
    "fr",
  );
  expect(form?.fields.map((field) => field.text)).toStrictEqual([
    "{author} a signé ",
    "son livre {dédicacé}",
    "l'ouvrage",
    ".",
  ]);
});

test("icuFieldForm: a case the translation lacks is an empty field", () => {
  const form = icuFieldForm(
    "{n, plural, one {# cat} other {# cats}}",
    "{n, plural, one {# gato} other {# gatos}}",
    "es",
  );
  expect(form?.fields.map((field) => [field.path[0].key, field.text])).toStrictEqual([
    ["one", "# gato"],
    ["many", ""],
    ["other", "# gatos"],
  ]);
});

test("icuFieldForm: a translation the fields can't show", () => {
  const english = "{n, plural, one {# cat} other {# cats}}";
  // An exact case of its own, and a category Japanese doesn't use.
  expect(icuFieldForm(english, "{n, plural, =5 {five} other {# neko}}", "ja")).toBe(null);
  expect(icuFieldForm(english, "{n, plural, one {#} other {# neko}}", "ja")).toBe(null);
  // A block of its own, on another argument, or broken.
  expect(icuFieldForm(english, "{n, plural, other {{g, select, other {#}}}}", "ja")).toStrictEqual(
    null,
  );
  expect(icuFieldForm(english, "{m, plural, other {# neko}}", "ja")).toBe(null);
  expect(icuFieldForm(english, "{n, plural, other {# neko}", "ja")).toBe(null);
  // Text around the block, where the English has none.
  expect(icuFieldForm(english, "¡{n, plural, other {# neko}}!", "ja")).toBe(null);
});

test("icuFieldForm: blocks in another order don't fit", () => {
  const english = "{a, select, x {X} other {O}} {b, select, y {Y} other {O}}";
  expect(
    icuFieldForm(english, "{b, select, y {Y} other {O}} {a, select, x {X} other {O}}", "en"),
  ).toBe(null);
});

test("writeIcuFieldForm: the fields as the translation, in the English's layout", () => {
  const form = icuFieldForm(SIGNED, "", "es")!;
  const [before, female, other, after] = form.fields;
  const changes = new Map([
    [before, "{author} firmó "],
    [female, "su libro"],
    [other, "su libro"],
    [after, "."],
  ]);
  expect(writeIcuFieldForm(form, changes)).toStrictEqual(
    "{author} firmó {g, select, female {su libro} other {su libro}}.",
  );
});

test("writeIcuFieldForm: plural cases for the language, empty where not written yet", () => {
  const form = icuFieldForm("{n, plural, one {# cat} other {# cats}}", "", "es")!;
  expect(writeIcuFieldForm(form, new Map([[form.fields[0], "# gato"]]))).toStrictEqual(
    "{n, plural, one {# gato} many {} other {}}",
  );
});

test("writeIcuFieldForm: blank fields write no translation", () => {
  const form = icuFieldForm(
    SIGNED,
    "{author} firmó {g, select, female {su} other {su}} libro.",
    "es",
  )!;
  const blank = new Map(form.fields.map((field) => [field, " "]));
  expect(writeIcuFieldForm(form, blank)).toBe("");
});

test("writeIcuFieldForm: without changes, the translation as the fields read it", () => {
  const translation = "{author} firmó {g, select, female {su} other {su}} libro.";
  const form = icuFieldForm(SIGNED, translation, "es")!;
  expect(writeIcuFieldForm(form)).toStrictEqual(translation);
});

test("writeIcuFieldForm: a field's text reads back the same", () => {
  const form = icuFieldForm(SIGNED, "", "es")!;
  const typed = "it's '{x}' {author}'s l'{author} '";
  const written = writeIcuFieldForm(form, new Map([[form.fields[1], typed]]));
  expect(icuFieldForm(SIGNED, written, "es")?.fields[1].text).toStrictEqual(typed);
});

test("writeIcuFieldForm: a plural case's text reads back the same", () => {
  const form = icuFieldForm("{n, plural, one {# cat} other {# cats}}", "", "ja")!;
  const typed = "'# ' {n}{{n}} '{' ''";
  const written = writeIcuFieldForm(form, new Map([[form.fields[0], typed]]));
  expect(
    icuFieldForm("{n, plural, one {# cat} other {# cats}}", written, "ja")?.fields[0].text,
  ).toStrictEqual(typed);
});

const KNOWN = new Set(["name", "n"]);

test("quoteField: known arguments stay, other braces are quoted", () => {
  expect(quoteField("Hi {name}, see {docs}", KNOWN, false, true)).toStrictEqual(
    "Hi {name}, see '{docs}'",
  );
  expect(quoteField("{ name } paid {n, number}", KNOWN, false, true)).toStrictEqual(
    "{ name } paid {n, number}",
  );
  expect(quoteField("{}{name}", KNOWN, false, true)).toBe("'{}'{name}");
});

test("quoteField: # is the number in a plural case, text elsewhere", () => {
  expect(quoteField("# cats", KNOWN, true, false)).toBe("# cats");
  expect(quoteField("Track #1", KNOWN, false, false)).toBe("Track #1");
});

test("quoteField: apostrophes are doubled only where ICU would start a quote", () => {
  expect(quoteField("l'arbre", KNOWN, false, true)).toBe("l'arbre");
  expect(quoteField("l'{name}", KNOWN, false, true)).toBe("l''{name}");
  expect(quoteField("rock''n", KNOWN, false, true)).toBe("rock'''n");
  expect(quoteField("'#", KNOWN, true, false)).toBe("''#");
  expect(quoteField("'#", KNOWN, false, false)).toBe("'#");
});

test("quoteField: an apostrophe at the end is doubled when syntax follows", () => {
  expect(quoteField("the cats'", KNOWN, false, false)).toBe("the cats''");
  expect(quoteField("the cats'", KNOWN, false, true)).toBe("the cats'");
});

test("quoteField: an apostrophe beside a quoted brace", () => {
  expect(quoteField("{'s}", KNOWN, false, true)).toBe("'{''s}'");
});
