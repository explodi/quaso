// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { checkTranslation, DEFAULT_SYNTAX } from "@quaso/core";
import {
  draftFrom,
  editorMasking,
  englishFor,
  formExamples,
  formsFor,
  maskText,
  sameDraft,
  unmaskText,
  valueFrom,
} from "./masking.ts";

const syntax = DEFAULT_SYNTAX;

test("chips: placeholders and references of the English, each once, in order", () => {
  const masking = editorMasking(
    "$t(common:play) {{name}} $t(common:back) {{name}} $t(common:play) {{count}}",
    [
      { raw: "$t(common:play)", english: "Play" },
      { raw: "$t(common:back)", english: "Back" },
    ],
    syntax,
  );
  expect(masking.enabled).toBe(true);
  expect(masking.references).toStrictEqual(["$t(common:play)", "$t(common:back)"]);
  expect(masking.chips.map((chip) => [chip.kind, chip.insert, chip.english])).toStrictEqual([
    ["reference", "⟦1⟧", "Play"],
    ["placeholder", "{{name}}", null],
    ["reference", "⟦2⟧", "Back"],
    ["placeholder", "{{count}}", null],
  ]);
});

test("masking numbers references like the English, and unmasking restores them exactly", () => {
  const masking = editorMasking("$t(common:play) again, $t(common:back)", [], syntax);
  const translation = "Noch einmal: $t(common:back) und $t(common:play), $t(common:play)";
  const masked = maskText(translation, masking, syntax);
  expect(masked).toBe("Noch einmal: ⟦2⟧ und ⟦1⟧, ⟦1⟧");
  expect(unmaskText(masked, masking)).toStrictEqual(translation);
  // A reference the English doesn't have stays as written, so the checks report it.
  expect(maskText("$t(other) ⟦1⟧", masking, syntax)).toBe("$t(other) ⟦1⟧");
});

test("text that already contains ⟦ switches masking off", () => {
  const masking = editorMasking("$t(common:play) ⟦1⟧", [], syntax);
  expect(masking.enabled).toBe(false);
  expect(masking.chips[0].insert).toBe("$t(common:play)");
  expect(maskText("$t(common:play) ⟦1⟧", masking, syntax)).toBe("$t(common:play) ⟦1⟧");
  expect(unmaskText("⟦1⟧", masking)).toBe("⟦1⟧");
  const byTranslation = editorMasking("$t(common:play)", [], syntax, "⟦1⟧ $t(common:play)");
  expect(byTranslation.enabled).toBe(false);
});

test("Polish plurals need four inputs, with example numbers", () => {
  const source = { one: "{{count}} coin", other: "{{count}} coins" };
  const forms = formsFor("plural", "pl", source, { cardinal: ["one", "few", "many", "other"] });
  expect(forms).toStrictEqual(["one", "few", "many", "other"]);
  expect(formExamples("one", "plural", "pl", source)).toBe("1");
  expect(formExamples("few", "plural", "pl", source)).toBe("2–4, 22–24, 32–34, …");
  expect(englishFor(source, "few")).toBe("{{count}} coins");
  expect(englishFor(source, "one")).toBe("{{count}} coin");
  // The service's categories win over the runtime's.
  expect(formsFor("plural", "pl", source, { cardinal: ["one", "other"] })).toStrictEqual([
    "one",
    "other",
  ]);
  // An English zero form adds zero in every language.
  expect(formsFor("plural", "ja", { zero: "none", other: "{{count}}" })).toStrictEqual([
    "zero",
    "other",
  ]);
  expect(formsFor("text", "pl", "Play")).toStrictEqual(["text"]);
});

test("drafts and values", () => {
  const masking = editorMasking("$t(common:play) {{count}}", [], syntax);
  const mask = (text: string) => maskText(text, masking, syntax);
  const unmask = (text: string) => unmaskText(text, masking);
  const forms = ["one", "few", "many", "other"] as const;
  const draft = draftFrom({ one: "$t(common:play) {{count}}", other: "x" }, forms, mask);
  expect(draft).toStrictEqual({ one: "⟦1⟧ {{count}}", few: "", many: "", other: "x" });
  expect(valueFrom({ ...draft, few: "a", many: "b" }, forms, unmask)).toStrictEqual({
    one: "$t(common:play) {{count}}",
    few: "a",
    many: "b",
    other: "x",
  });
  expect(valueFrom(draftFrom("Graj", ["text"], mask), ["text"], unmask)).toBe("Graj");
  expect(draftFrom(null, ["text"], mask)).toStrictEqual({ text: "" });
  expect(sameDraft({ text: "a" }, { text: "a" }, ["text"])).toBe(true);
  expect(sameDraft({ one: "a" }, { one: "a", few: "" }, ["one", "few"])).toBe(true);
  expect(sameDraft({ one: "a" }, { one: "b" }, ["one"])).toBe(false);
});

test("the checks see the unmasked value", () => {
  const masking = editorMasking("$t(common:play) again", [], syntax);
  const value = valueFrom({ text: "⟦1⟧ encore" }, ["text"], (t) => unmaskText(t, masking));
  const results = checkTranslation({
    kind: "text",
    source: "$t(common:play) again",
    translation: value,
    language: "fr",
  });
  expect(results.filter((r) => r.severity === "error")).toStrictEqual([]);
});

test("chips, ICU: the arguments and # of every case, each once; no chips for block syntax", () => {
  const masking = editorMasking(
    "{n, plural, one {# coin for {name}} other {# coins for {name}}}",
    [],
    { ...DEFAULT_SYNTAX, icu: true },
  );
  expect(masking.chips.map((chip) => [chip.kind, chip.insert, chip.key])).toStrictEqual([
    ["placeholder", "#", "#"],
    ["placeholder", "{name}", "{name}"],
  ]);
});
