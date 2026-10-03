// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
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
  assertEquals(masking.enabled, true);
  assertEquals(masking.references, ["$t(common:play)", "$t(common:back)"]);
  assertEquals(
    masking.chips.map((chip) => [chip.kind, chip.insert, chip.english]),
    [
      ["reference", "⟦1⟧", "Play"],
      ["placeholder", "{{name}}", null],
      ["reference", "⟦2⟧", "Back"],
      ["placeholder", "{{count}}", null],
    ],
  );
});

test("masking numbers references like the English, and unmasking restores them exactly", () => {
  const masking = editorMasking("$t(common:play) again, $t(common:back)", [], syntax);
  const translation = "Noch einmal: $t(common:back) und $t(common:play), $t(common:play)";
  const masked = maskText(translation, masking, syntax);
  assertEquals(masked, "Noch einmal: ⟦2⟧ und ⟦1⟧, ⟦1⟧");
  assertEquals(unmaskText(masked, masking), translation);
  // A reference the English doesn't have stays as written, so the checks report it.
  assertEquals(maskText("$t(other) ⟦1⟧", masking, syntax), "$t(other) ⟦1⟧");
});

test("text that already contains ⟦ switches masking off", () => {
  const masking = editorMasking("$t(common:play) ⟦1⟧", [], syntax);
  assertEquals(masking.enabled, false);
  assertEquals(masking.chips[0].insert, "$t(common:play)");
  assertEquals(maskText("$t(common:play) ⟦1⟧", masking, syntax), "$t(common:play) ⟦1⟧");
  assertEquals(unmaskText("⟦1⟧", masking), "⟦1⟧");
  const byTranslation = editorMasking("$t(common:play)", [], syntax, "⟦1⟧ $t(common:play)");
  assertEquals(byTranslation.enabled, false);
});

test("Polish plurals need four inputs, with example numbers", () => {
  const source = { one: "{{count}} coin", other: "{{count}} coins" };
  const forms = formsFor("plural", "pl", source, { cardinal: ["one", "few", "many", "other"] });
  assertEquals(forms, ["one", "few", "many", "other"]);
  assertEquals(formExamples("one", "plural", "pl", source), "1");
  assertEquals(formExamples("few", "plural", "pl", source), "2–4, 22–24, 32–34, …");
  assertEquals(englishFor(source, "few"), "{{count}} coins");
  assertEquals(englishFor(source, "one"), "{{count}} coin");
  // The service's categories win over the runtime's.
  assertEquals(formsFor("plural", "pl", source, { cardinal: ["one", "other"] }), ["one", "other"]);
  // An English zero form adds zero in every language.
  assertEquals(formsFor("plural", "ja", { zero: "none", other: "{{count}}" }), ["zero", "other"]);
  assertEquals(formsFor("text", "pl", "Play"), ["text"]);
});

test("drafts and values", () => {
  const masking = editorMasking("$t(common:play) {{count}}", [], syntax);
  const mask = (text: string) => maskText(text, masking, syntax);
  const unmask = (text: string) => unmaskText(text, masking);
  const forms = ["one", "few", "many", "other"] as const;
  const draft = draftFrom({ one: "$t(common:play) {{count}}", other: "x" }, forms, mask);
  assertEquals(draft, { one: "⟦1⟧ {{count}}", few: "", many: "", other: "x" });
  assertEquals(valueFrom({ ...draft, few: "a", many: "b" }, forms, unmask), {
    one: "$t(common:play) {{count}}",
    few: "a",
    many: "b",
    other: "x",
  });
  assertEquals(valueFrom(draftFrom("Graj", ["text"], mask), ["text"], unmask), "Graj");
  assertEquals(draftFrom(null, ["text"], mask), { text: "" });
  assertEquals(sameDraft({ text: "a" }, { text: "a" }, ["text"]), true);
  assertEquals(sameDraft({ one: "a" }, { one: "a", few: "" }, ["one", "few"]), true);
  assertEquals(sameDraft({ one: "a" }, { one: "b" }, ["one"]), false);
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
  assertEquals(
    results.filter((r) => r.severity === "error"),
    [],
  );
});
