// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals } from "@std/assert";
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
  assertEquals(paths(PARTY, "", "es"), [
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
  assertEquals(form?.fields[2].text, "");
  assertEquals(form?.fields[2].plural, true);
  assertEquals(form?.fields[2].english, [
    { type: "argument", text: "{name}" },
    { type: "text", text: " invites " },
    { type: "number", text: "#" },
    { type: "text", text: " friends." },
  ]);
});

test("icuFieldForm: text around a block is a field where the English has text", () => {
  const form = icuFieldForm(SIGNED, "", "es");
  assertEquals(
    form?.fields.map((field) => [
      field.afterBlock,
      field.path.map((step) => step.key),
      field.beforeBlock,
    ]),
    [
      [undefined, [], "g"],
      [undefined, ["female"], undefined],
      [undefined, ["other"], undefined],
      ["g", [], undefined],
    ],
  );
  assertEquals(form?.fields[0].text, "");
  assertEquals(form?.fields[3].english, [{ type: "text", text: " book." }]);
});

test("icuFieldForm: a translation's texts, quotes resolved", () => {
  const form = icuFieldForm(
    SIGNED,
    "{author} a signé {g, select, female {son livre '{'dédicacé'}'} other {l''ouvrage}}.",
    "fr",
  );
  assertEquals(
    form?.fields.map((field) => field.text),
    ["{author} a signé ", "son livre {dédicacé}", "l'ouvrage", "."],
  );
});

test("icuFieldForm: a case the translation lacks is an empty field", () => {
  const form = icuFieldForm(
    "{n, plural, one {# cat} other {# cats}}",
    "{n, plural, one {# gato} other {# gatos}}",
    "es",
  );
  assertEquals(
    form?.fields.map((field) => [field.path[0].key, field.text]),
    [
      ["one", "# gato"],
      ["many", ""],
      ["other", "# gatos"],
    ],
  );
});

test("icuFieldForm: a translation the fields can't show", () => {
  const english = "{n, plural, one {# cat} other {# cats}}";
  // An exact case of its own, and a category Japanese doesn't use.
  assertEquals(icuFieldForm(english, "{n, plural, =5 {five} other {# neko}}", "ja"), null);
  assertEquals(icuFieldForm(english, "{n, plural, one {#} other {# neko}}", "ja"), null);
  // A block of its own, on another argument, or broken.
  assertEquals(icuFieldForm(english, "{n, plural, other {{g, select, other {#}}}}", "ja"), null);
  assertEquals(icuFieldForm(english, "{m, plural, other {# neko}}", "ja"), null);
  assertEquals(icuFieldForm(english, "{n, plural, other {# neko}", "ja"), null);
  // Text around the block, where the English has none.
  assertEquals(icuFieldForm(english, "¡{n, plural, other {# neko}}!", "ja"), null);
});

test("icuFieldForm: blocks in another order don't fit", () => {
  const english = "{a, select, x {X} other {O}} {b, select, y {Y} other {O}}";
  assertEquals(
    icuFieldForm(english, "{b, select, y {Y} other {O}} {a, select, x {X} other {O}}", "en"),
    null,
  );
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
  assertEquals(
    writeIcuFieldForm(form, changes),
    "{author} firmó {g, select, female {su libro} other {su libro}}.",
  );
});

test("writeIcuFieldForm: plural cases for the language, empty where not written yet", () => {
  const form = icuFieldForm("{n, plural, one {# cat} other {# cats}}", "", "es")!;
  assertEquals(
    writeIcuFieldForm(form, new Map([[form.fields[0], "# gato"]])),
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
  assertEquals(writeIcuFieldForm(form, blank), "");
});

test("writeIcuFieldForm: without changes, the translation as the fields read it", () => {
  const translation = "{author} firmó {g, select, female {su} other {su}} libro.";
  const form = icuFieldForm(SIGNED, translation, "es")!;
  assertEquals(writeIcuFieldForm(form), translation);
});

test("writeIcuFieldForm: a field's text reads back the same", () => {
  const form = icuFieldForm(SIGNED, "", "es")!;
  const typed = "it's '{x}' {author}'s l'{author} '";
  const written = writeIcuFieldForm(form, new Map([[form.fields[1], typed]]));
  assertEquals(icuFieldForm(SIGNED, written, "es")?.fields[1].text, typed);
});

test("writeIcuFieldForm: a plural case's text reads back the same", () => {
  const form = icuFieldForm("{n, plural, one {# cat} other {# cats}}", "", "ja")!;
  const typed = "'# ' {n}{{n}} '{' ''";
  const written = writeIcuFieldForm(form, new Map([[form.fields[0], typed]]));
  assertEquals(
    icuFieldForm("{n, plural, one {# cat} other {# cats}}", written, "ja")?.fields[0].text,
    typed,
  );
});

const KNOWN = new Set(["name", "n"]);

test("quoteField: known arguments stay, other braces are quoted", () => {
  assertEquals(quoteField("Hi {name}, see {docs}", KNOWN, false, true), "Hi {name}, see '{docs}'");
  assertEquals(
    quoteField("{ name } paid {n, number}", KNOWN, false, true),
    "{ name } paid {n, number}",
  );
  assertEquals(quoteField("{}{name}", KNOWN, false, true), "'{}'{name}");
});

test("quoteField: # is the number in a plural case, text elsewhere", () => {
  assertEquals(quoteField("# cats", KNOWN, true, false), "# cats");
  assertEquals(quoteField("Track #1", KNOWN, false, false), "Track #1");
});

test("quoteField: apostrophes are doubled only where ICU would start a quote", () => {
  assertEquals(quoteField("l'arbre", KNOWN, false, true), "l'arbre");
  assertEquals(quoteField("l'{name}", KNOWN, false, true), "l''{name}");
  assertEquals(quoteField("rock''n", KNOWN, false, true), "rock'''n");
  assertEquals(quoteField("'#", KNOWN, true, false), "''#");
  assertEquals(quoteField("'#", KNOWN, false, false), "'#");
});

test("quoteField: an apostrophe at the end is doubled when syntax follows", () => {
  assertEquals(quoteField("the cats'", KNOWN, false, false), "the cats''");
  assertEquals(quoteField("the cats'", KNOWN, false, true), "the cats'");
});

test("quoteField: an apostrophe beside a quoted brace", () => {
  assertEquals(quoteField("{'s}", KNOWN, false, true), "'{''s}'");
});
