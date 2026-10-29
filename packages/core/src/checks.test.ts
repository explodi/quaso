// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import {
  type CheckInput,
  type CheckResult,
  CHECKS,
  checkDuplicateTranslations,
  checkTranslationConsistency,
  meaningWarnings,
  checkTranslation,
  errorsOf,
  hasErrors,
} from "./checks.ts";
import { maskReferences, unmaskReferences } from "./tokens.ts";
import type { PluralCategory, PluralForms, TextValue } from "./types.ts";

/** Checks a text string, in German unless the options say otherwise. */
function text(
  source: string,
  translation: TextValue,
  options: Partial<CheckInput> = {},
): CheckResult[] {
  return checkTranslation({ kind: "text", source, translation, language: "de", ...options });
}

/** Checks a cardinal plural string. */
function plural(
  language: string,
  source: PluralForms,
  translation: TextValue,
  options: Partial<CheckInput> = {},
): CheckResult[] {
  return checkTranslation({ kind: "plural", source, translation, language, ...options });
}

/** Checks an ordinal plural string. */
function ordinal(
  language: string,
  source: PluralForms,
  translation: TextValue,
  options: Partial<CheckInput> = {},
): CheckResult[] {
  return checkTranslation({ kind: "ordinal", source, translation, language, ...options });
}

/** `check` or `check:form` for each result, for tests about which results come out. */
function summary(results: CheckResult[]): string[] {
  return results.map((result) => (result.form ? `${result.check}:${result.form}` : result.check));
}

function messages(results: CheckResult[]): string[] {
  return results.map((result) => result.message);
}

const COINS: PluralForms = { one: "{{count}} coin", other: "{{count}} coins" };
const POLISH: PluralForms = {
  one: "{{count}} moneta",
  few: "{{count}} monety",
  many: "{{count}} monet",
  other: "{{count}} monety",
};
const RUSSIAN: PluralForms = {
  one: "{{count}} монета",
  few: "{{count}} монеты",
  many: "{{count}} монет",
  other: "{{count}} монеты",
};

test("acceptance test 9: a Polish form that drops {{count}} is refused", () => {
  expect(plural("pl", COINS, POLISH)).toStrictEqual([]);
  for (const form of ["few", "many", "other"] as const) {
    const results = plural("pl", COINS, { ...POLISH, [form]: "Kilka monet" });
    expect(results).toStrictEqual([
      {
        check: "placeholder_missing",
        severity: "error",
        message: `Placeholder {{count}} is missing from the ${form} form.`,
        form,
        value: "{{count}}",
      },
    ]);
    assert(hasErrors(results));
  }
});

test("acceptance test 9: Polish one covers only 1, so it may leave out {{count}}", () => {
  expect(plural("pl", COINS, { ...POLISH, one: "Jedna moneta" })).toStrictEqual([]);
});

test("acceptance test 9: Russian one covers 1, 21, 31, …, so it keeps {{count}}", () => {
  expect(plural("ru", COINS, RUSSIAN)).toStrictEqual([]);
  expect(plural("ru", COINS, { ...RUSSIAN, one: "Одна монета" })).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{count}} is missing from the one form.",
      form: "one",
      value: "{{count}}",
    },
  ]);
});

test("acceptance test 9: a text translation that drops {{count}} is refused", () => {
  const results = text("You have {{count}} coins", "Du hast Münzen");
  expect(results).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{count}} is missing.",
      value: "{{count}}",
    },
  ]);
  assert(hasErrors(results));
  expect(text("You have {{count}} coins", "Du hast {{count}} Münzen")).toStrictEqual([]);
});

test("{{count}}: only categories that cover exactly one number may leave it out", () => {
  // French one covers 0, 1 and 1.5; Japanese other covers every number.
  const french = { one: "Une pièce", many: "{{count}} pièces", other: "{{count}} pièces" };
  expect(summary(plural("fr", COINS, french))).toStrictEqual(["placeholder_missing:one"]);
  expect(summary(plural("ja", COINS, { other: "コイン" }))).toStrictEqual([
    "placeholder_missing:other",
  ]);
  // English one covers only 1 (1.5 is other).
  expect(plural("en-GB", COINS, { one: "One coin", other: "{{count}} gold coins" })).toStrictEqual(
    [],
  );
  // Arabic zero, one and two cover one number each; few, many and other don't.
  const arabic = {
    zero: "لا عملات",
    one: "عملة واحدة",
    two: "عملتان",
    few: "{{count}} عملات",
    many: "{{count}} عملة",
    other: "{{count}} عملة",
  };
  expect(plural("ar", COINS, arabic)).toStrictEqual([]);
  expect(summary(plural("ar", COINS, { ...arabic, few: "عملات" }))).toStrictEqual([
    "placeholder_missing:few",
  ]);
  // Welsh few is only 3 and many only 6.
  const welsh = {
    zero: "Dim darnau",
    one: "Un darn",
    two: "Dau ddarn",
    few: "Tri darn",
    many: "Chwe darn",
    other: "{{count}} darn",
  };
  expect(plural("cy", COINS, welsh)).toStrictEqual([]);
  expect(summary(plural("cy", COINS, { ...welsh, other: "Darnau" }))).toStrictEqual([
    "placeholder_missing:other",
  ]);
});

test("{{count}}: any placeholder named count, and only that name", () => {
  const formatted = { one: "{{count, number}} coin", other: "{{count, number}} coins" };
  const polish = {
    one: "Jedna moneta",
    few: "{{count, number}} monety",
    many: "{{count, number}} monet",
    other: "{{count, number}} monety",
  };
  expect(plural("pl", formatted, polish)).toStrictEqual([]);
  const unescaped = { one: "{{- count}} coin", other: "{{- count}} coins" };
  expect(plural("pl", unescaped, { ...polish, few: "{{- count}} monety" })).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{- count}} is missing from the many form.",
      form: "many",
      value: "{{- count}}",
    },
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{- count}} is missing from the other form.",
      form: "other",
      value: "{{- count}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{count, number}} isn't in the English (many form).",
      form: "many",
      value: "{{count, number}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{count, number}} isn't in the English (other form).",
      form: "other",
      value: "{{count, number}}",
    },
  ]);
  // Other placeholders stay required even where {{count}} may go.
  const named = { one: "{{name}} has {{count}} coin", other: "{{name}} has {{count}} coins" };
  const results = plural("pl", named, {
    one: "Jedna moneta",
    few: "{{name}} ma {{count}} monety",
    many: "{{name}} ma {{count}} monet",
    other: "{{name}} ma {{count}} monety",
  });
  expect(messages(results)).toStrictEqual(["Placeholder {{name}} is missing from the one form."]);
  // A placeholder called Count is not count.
  const capital = { one: "{{Count}} coin", other: "{{Count}} coins" };
  const withoutCapital = {
    one: "Jedna moneta",
    few: "{{Count}}",
    many: "{{Count}}",
    other: "{{Count}}",
  };
  expect(summary(plural("pl", capital, withoutCapital))).toStrictEqual(["placeholder_missing:one"]);
});

test("invalid_value: forms for a text string and text for a plural", () => {
  expect(text("Play", { other: "Spielen" })).toStrictEqual([
    {
      check: "invalid_value",
      severity: "error",
      message: "Text is expected, not plural forms.",
    },
  ]);
  const expected = [
    {
      check: "invalid_value",
      severity: "error",
      message: "Plural forms are expected.",
    },
  ];
  expect(plural("pl", COINS, "{{count}} monet")).toStrictEqual(expected);
  expect(ordinal("en", COINS, "{{count}}th")).toStrictEqual(expected);
  expect(plural("pl", COINS, null as unknown as TextValue)).toStrictEqual(expected);
  expect(plural("pl", COINS, ["{{count}}"] as unknown as TextValue)).toStrictEqual(expected);
});

test("invalid_value: a form that isn't text", () => {
  const forms = { ...POLISH, few: 3 } as unknown as PluralForms;
  expect(plural("pl", COINS, forms)).toStrictEqual([
    {
      check: "invalid_value",
      severity: "error",
      message: "The few form must be text.",
      form: "few",
    },
  ]);
});

test("empty: empty text, white space and line breaks", () => {
  const expected = [{ check: "empty", severity: "error", message: "The translation is empty." }];
  for (const empty of ["", " ", "\t", "\r\n", "\n\n", "\u00a0", "\u3000", " \u2003 "]) {
    expect(text("Play", empty), JSON.stringify(empty)).toStrictEqual(expected);
  }
  expect(text("Play", "\u200b"), "a zero-width space isn't white space").toStrictEqual([]);
});

test("empty: an empty value is reported once, without other checks", () => {
  const english = "{{count}} coins, $t(common:back), 3 left";
  expect(summary(text(english, "  ", { maxLength: 1 }))).toStrictEqual(["empty"]);
  expect(plural("pl", COINS, { ...POLISH, many: " \r\n" })).toStrictEqual([
    {
      check: "empty",
      severity: "error",
      message: "The many form is empty.",
      form: "many",
    },
  ]);
});

test("placeholder_missing: missing, or appearing less often", () => {
  expect(text("{{current}}/{{total}}", "{{current}}")).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{total}} is missing.",
      value: "{{total}}",
    },
  ]);
  expect(text("{{a}} and {{a}}", "{{a}} und")).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{a}} appears less often than in the English.",
      value: "{{a}}",
    },
  ]);
  expect(
    messages(
      plural(
        "pl",
        { one: "{{a}} {{a}}", other: "{{a}} {{a}}" },
        {
          one: "{{a}} {{a}}",
          few: "{{a}}",
          many: "{{a}} {{a}}",
          other: "{{a}} {{a}}",
        },
      ),
    ),
  ).toStrictEqual(["Placeholder {{a}} appears less often than in the English (few form)."]);
});

test("placeholder_missing: one result per placeholder, in the English order", () => {
  const results = text("{{b}} {{a}} {{b}} {{c}}", "Nichts");
  expect(results.map((result) => result.value)).toStrictEqual(["{{b}}", "{{a}}", "{{c}}"]);
});

test("placeholder_extra: not in the English, or more often", () => {
  expect(text("Hello {{name}}", "Hallo {{name}} {{user}}")).toStrictEqual([
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{user}} isn't in the English.",
      value: "{{user}}",
    },
  ]);
  expect(text("Hello {{name}}", "Hallo {{name}}, {{name}}")).toStrictEqual([
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{name}} appears more often than in the English.",
      value: "{{name}}",
    },
  ]);
  const results = text("Hi", "{{z}} {{y}} {{z}} {{x}}");
  expect(results.map((result) => result.value)).toStrictEqual(["{{z}}", "{{y}}", "{{x}}"]);
});

test("placeholders: compared by placeholderKey", () => {
  expect(text("{{count}} coins", "{{ count }} Münzen")).toStrictEqual([]);
  expect(text("{{ count , number }}", "{{count, number}} Stück")).toStrictEqual([]);
  expect(text("{{-html}} ok", "{{- html}} gut")).toStrictEqual([]);
  expect(text("{{date, datetime}}", "Am {{date}}")).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{date, datetime}} is missing.",
      value: "{{date, datetime}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{date}} isn't in the English.",
      value: "{{date}}",
    },
  ]);
  expect(summary(text("{{- html}}", "{{html}}"))).toStrictEqual([
    "placeholder_missing",
    "placeholder_extra",
  ]);
  expect(summary(text("{{name}}", "{{Name}}"))).toStrictEqual([
    "placeholder_missing",
    "placeholder_extra",
  ]);
});

test("placeholders: text that only looks like a placeholder is text", () => {
  expect(text("{{ }} and {{, x}} and {{open", "und")).toStrictEqual([]);
  expect(text("Braces {{ like this", "Klammern")).toStrictEqual([]);
  expect(text("Broken {{\nname}}", "Kaputt {{\nName}}")).toStrictEqual([]);
});

test("placeholders: those i18next doesn't fill in don't count as the English ones", () => {
  // Regression: "{{ - html }}" was taken for "{{- html}}", which i18next doesn't unescape.
  for (const translation of ["Hallo {{ - html }}!", "Hallo {{ -html}}!"]) {
    expect(summary(text("Hi {{- html}}!", translation))).toStrictEqual([
      "placeholder_missing",
      "placeholder_extra",
    ]);
  }
  expect(text("Hi {{- html}}!", "Hallo {{-html}}!")).toStrictEqual([]);
  // Regression: after an empty {{}}, i18next reads "{{}} {{count}}" as one placeholder.
  expect(text("You have {{count}} coins", "Du hast {{}} {{count}} Münzen")).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{count}} is missing.",
      value: "{{count}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{}} {{count}} isn't in the English.",
      value: "{{}} {{count}}",
    },
  ]);
  // Regression: a placeholder can't span lines.
  for (const translation of ["Du hast {{\ncount\n}} Münzen", "Du hast {{count\r\n}} Münzen"]) {
    expect(summary(text("You have {{count}} coins", translation))).toStrictEqual([
      "placeholder_missing",
      "whitespace",
    ]);
  }
});

test("placeholders: formats compare as i18next reads them", () => {
  // Regression: format names are case-insensitive and options are trimmed in i18next.
  expect(text("Total: {{val, number}}", "Summe: {{val, Number}}")).toStrictEqual([]);
  expect(
    text(
      "{{val, number(minimumFractionDigits: 2)}} left",
      "{{val, number(minimumFractionDigits:2)}} übrig",
    ),
  ).toStrictEqual([]);
  expect(text("{{val, number, uppercase}} left", "{{val, number,uppercase}} übrig")).toStrictEqual(
    [],
  );
  // Messages show the normalized placeholder.
  expect(messages(text("{{val, number}} left", "{{val, Currency( EUR )}} übrig"))).toStrictEqual([
    "Placeholder {{val, number}} is missing.",
    "Placeholder {{val, currency(EUR)}} isn't in the English.",
  ]);
});

test("placeholders: those in a reference's options belong to the reference", () => {
  const english = 'You have $t(coins, {"count": {{n}}})';
  expect(text(english, 'Du hast $t(coins, {"count": {{n}}})')).toStrictEqual([]);
  expect(text(english, "Du hast {{n}}")).toStrictEqual([
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{n}} isn't in the English.",
      value: "{{n}}",
    },
    {
      check: "reference_missing",
      severity: "error",
      message: 'Reference $t(coins, {"count": {{n}}}) is missing.',
      value: '$t(coins, {"count": {{n}}})',
    },
  ]);
});

test("placeholders: a placeholder of any English form may appear in any form", () => {
  const english = { one: "{{name}} has one coin", other: "{{count}} coins" };
  expect(
    plural("pl", english, {
      one: "{{name}} ma jedną monetę",
      few: "{{name}} ma {{count}} monety",
      many: "{{count}} monet",
      other: "{{count}} monety",
    }),
  ).toStrictEqual([]);
  expect(
    plural("pl", english, {
      one: "Jedna",
      few: "{{count}} {{count}}",
      many: "{{count}} {{name}} {{name}}",
      other: "{{count}} {{total}}",
    }),
  ).toStrictEqual([
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{count}} appears more often than in the English (few form).",
      form: "few",
      value: "{{count}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{name}} appears more often than in the English (many form).",
      form: "many",
      value: "{{name}}",
    },
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{total}} isn't in the English (other form).",
      form: "other",
      value: "{{total}}",
    },
  ]);
});

test("placeholders: Unicode names, emoji and surrogate pairs", () => {
  expect(text("Hello {{名前}}", "こんにちは{{名前}}さん")).toStrictEqual([]);
  expect(text("{{😀}} 👍", "👍{{😀}}👍")).toStrictEqual([]);
  expect(messages(text("{{😀}} 👍", "👍"))).toStrictEqual(["Placeholder {{😀}} is missing."]);
  // A placeholder name in NFD is a different variable from the same name in NFC.
  expect(summary(text("{{café}}", "{{cafe\u0301}}"))).toStrictEqual([
    "placeholder_missing",
    "placeholder_extra",
  ]);
});

test("custom interpolation syntax", () => {
  const syntax = { prefix: "__", suffix: "__" };
  expect(text("You have __count__ coins", "Du hast __count__ Münzen", { syntax })).toStrictEqual(
    [],
  );
  expect(text("You have __count__ coins", "Du hast Münzen", { syntax })).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder __count__ is missing.",
      value: "{{count}}",
    },
  ]);
  // {{count}} is plain text in this syntax.
  expect(text("{{count}} coins", "Münzen", { syntax })).toStrictEqual([]);
  expect(text("__ count __ coins", "__count__ Münzen", { syntax })).toStrictEqual([]);

  const icu = { prefix: "{", suffix: "}" };
  expect(
    messages(text("Hi {name}", "Hallo {name} {- extra, uppercase}", { syntax: icu })),
  ).toStrictEqual(["Placeholder {- extra, uppercase} isn't in the English."]);
  expect(text("Hi {name}", "Hallo {name} {- extra}", { syntax: icu })[0].value).toStrictEqual(
    "{{- extra}}",
  );

  const english = { one: "%{count} coin", other: "%{count} coins" };
  const percent = { syntax: { prefix: "%{", suffix: "}" } };
  const polish = { one: "Jedna moneta", few: "monety", many: "%{count} monet", other: "%{count}" };
  expect(plural("pl", english, polish, percent)).toStrictEqual([
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder %{count} is missing from the few form.",
      form: "few",
      value: "{{count}}",
    },
  ]);
});

test("reference_missing: missing, or appearing less often", () => {
  expect(text("$t(common:back) to the menu", "Zum Menü")).toStrictEqual([
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(common:back) is missing.",
      value: "$t(common:back)",
    },
  ]);
  expect(text("$t(a) or $t(a)", "$t(a)")).toStrictEqual([
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(a) appears less often than in the English.",
      value: "$t(a)",
    },
  ]);
  // References may move.
  expect(text("$t(a) then $t(b)", "$t(b), dann $t(a)")).toStrictEqual([]);
});

test("reference_extra: changed or repeated", () => {
  expect(text("Press $t(keys.jump)", "Drücke $t(keys.run)")).toStrictEqual([
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(keys.jump) is missing.",
      value: "$t(keys.jump)",
    },
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference $t(keys.run) isn't in the English, or is repeated.",
      value: "$t(keys.run)",
    },
  ]);
  expect(text("Press $t(a)", "$t(a) $t(a)")).toStrictEqual([
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference $t(a) isn't in the English, or is repeated.",
      value: "$t(a)",
    },
  ]);
});

test("references: compared by their raw text", () => {
  expect(summary(text("$t(a)", "$t( a )"))).toStrictEqual(["reference_missing", "reference_extra"]);
  const english = '$t(coins, {"count": {{n}}})';
  expect(summary(text(english, '$t(coins, { "count": {{n}} })'))).toStrictEqual([
    "reference_missing",
    "reference_extra",
  ]);
  expect(summary(text("$t(ns:key)", "$t(key)"))).toStrictEqual([
    "reference_missing",
    "reference_extra",
  ]);
  // `$t(` without its `)` is text.
  expect(text("Costs $t(", "Kostet")).toStrictEqual([]);
});

test("references: masked references left in the translation are extra", () => {
  expect(text("Press $t(a)", "Drücke $t(a) ⟦2⟧")).toStrictEqual([
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference ⟦2⟧ isn't in the English, or is repeated.",
      value: "⟦2⟧",
    },
  ]);
  // A translation that was never unmasked.
  expect(summary(text("Press $t(a)", "Drücke ⟦1⟧"))).toStrictEqual([
    "reference_missing",
    "reference_extra",
  ]);
  // Brackets without a number are text, and an English that has the text keeps it.
  expect(text("Press ⟦x⟧", "Drücke ⟦x⟧")).toStrictEqual([]);
  expect(text("Slot ⟦1⟧", "Platz ⟦1⟧")).toStrictEqual([]);
});

test("references: an LLM result, unmasked, then checked", () => {
  const english = "$t(common:back) or $t(common:next), then {{count}} more";
  const { text: masked, references } = maskReferences(english);
  expect(masked).toBe("⟦1⟧ or ⟦2⟧, then {{count}} more");
  const good = unmaskReferences("⟦2⟧ oder ⟦1⟧, dann {{count}} mehr", references);
  expect(text(english, good)).toStrictEqual([]);
  const repeated = unmaskReferences("⟦1⟧ ⟦1⟧ dann {{count}}", references);
  expect(summary(text(english, repeated))).toStrictEqual(["reference_missing", "reference_extra"]);
  const invented = unmaskReferences("⟦1⟧ ⟦2⟧ ⟦3⟧ {{count}} mehr", references);
  expect(text(english, invented).map((result) => result.value)).toStrictEqual(["⟦3⟧"]);
});

test("references: plural forms are compared with English other", () => {
  const english = { one: "$t(icon) {{count}} coin", other: "$t(icon) {{count}} coins" };
  const polish = {
    one: "$t(icon) Jedna moneta",
    few: "{{count}} monety",
    many: "$t(icon) {{count}} monet",
    other: "$t(icon) $t(icon) {{count}} monety",
  };
  expect(plural("pl", english, polish)).toStrictEqual([
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(icon) is missing from the few form.",
      form: "few",
      value: "$t(icon)",
    },
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference $t(icon) isn't in the English, or is repeated (other form).",
      form: "other",
      value: "$t(icon)",
    },
  ]);
  const fewer = plural(
    "pl",
    { one: "$t(a) $t(a)", other: "$t(a) $t(a)" },
    {
      one: "$t(a) $t(a)",
      few: "$t(a) $t(a)",
      many: "$t(a)",
      other: "$t(a) $t(a)",
    },
  );
  expect(messages(fewer)).toStrictEqual([
    "Reference $t(a) appears less often than in the English (many form).",
  ]);
});

test("max_length: grapheme clusters, placeholders and references included", () => {
  expect(text("Play", "Spielen", { maxLength: 4 })).toStrictEqual([
    {
      check: "max_length",
      severity: "error",
      message: "At most 4 characters; this has 7.",
      limit: 4,
      length: 7,
    },
  ]);
  expect(text("Play", "Spielen", { maxLength: 7 })).toStrictEqual([]);
  expect(text("Play", "Spielen", { maxLength: null })).toStrictEqual([]);
  expect(text("Play", "Spielen", { maxLength: undefined })).toStrictEqual([]);
  expect(messages(text("Play", "Go", { maxLength: 1 }))).toStrictEqual([
    "At most 1 character; this has 2.",
  ]);
  expect(messages(text("Play", "Go", { maxLength: 0 }))).toStrictEqual([
    "At most 0 characters; this has 2.",
  ]);
  // "{{count}} Münzen" is 16 characters; "$t(a) Ja" is 8.
  expect(text("{{count}} coins", "{{count}} Münzen", { maxLength: 16 })).toStrictEqual([]);
  expect(text("{{count}} coins", "{{count}} Münzen", { maxLength: 15 })[0].length).toStrictEqual(
    16,
  );
  expect(text("$t(a) Yes", "$t(a) Ja", { maxLength: 7 })[0].length).toBe(8);
});

test("max_length: emoji, flags, combining marks and CRLF count as one", () => {
  const cases: [string, string, number][] = [
    ["Hello", "👍👍👍", 3], // surrogate pairs
    ["Hello", "👨\u200d👩\u200d👧\u200d👦", 1], // a ZWJ sequence of 11 code units
    ["Hello", "🇵🇱🇩🇪", 2], // flags
    ["Hello", "👋🏽", 1], // a skin tone modifier
    ["Hello", "e\u0301te\u0301", 3], // combining acute accents
    ["Hello", "Ha\u0308\u0323", 2], // two combining marks on one letter
    ["Hello\nthere", "One\r\nTwo", 7], // CRLF
    ["Hello\nthere", "One\nTwo", 7],
  ];
  for (const [english, translation, length] of cases) {
    expect(text(english, translation, { maxLength: length }), translation).toStrictEqual([]);
    expect(text(english, translation, { maxLength: length - 1 }), translation).toStrictEqual([
      {
        check: "max_length",
        severity: "error",
        message: `At most ${length - 1} character${length === 2 ? "" : "s"}; this has ${length}.`,
        limit: length - 1,
        length,
      },
    ]);
  }
});

test("max_length: every form is checked", () => {
  expect(plural("pl", COINS, POLISH, { maxLength: 15 })).toStrictEqual([
    {
      check: "max_length",
      severity: "error",
      message: "At most 15 characters; this has 16 (one form).",
      form: "one",
      limit: 15,
      length: 16,
    },
    {
      check: "max_length",
      severity: "error",
      message: "At most 15 characters; this has 16 (few form).",
      form: "few",
      limit: 15,
      length: 16,
    },
    {
      check: "max_length",
      severity: "error",
      message: "At most 15 characters; this has 16 (other form).",
      form: "other",
      limit: 15,
      length: 16,
    },
  ]);
});

test("identical: a warning when the English has letters", () => {
  const results = text("Options", "Options");
  expect(results).toStrictEqual([
    {
      check: "identical",
      severity: "warning",
      message: "Identical to the English.",
    },
  ]);
  expect(hasErrors(results)).toBeFalsy();
  expect(summary(text("OK", "OK"))).toStrictEqual(["identical"]);
  expect(summary(text("東京", "東京", { language: "ja" }))).toStrictEqual(["identical"]);
  expect(summary(text("{{name}}: OK", "{{name}}: OK"))).toStrictEqual(["identical"]);
  expect(text("Options", "Optionen")).toStrictEqual([]);
  expect(summary(text("Options", "Options ")), "spaces make a difference").toStrictEqual([
    "whitespace",
  ]);
  expect(text("A\r\nB", "A\nB"), "so do line endings").toStrictEqual([]);
});

test("identical: skipped when the English has no letters", () => {
  for (const english of ["{{current}}/{{total}}", "$t(a) / $t(b)", "2024", "{{count}} × 2", "…"]) {
    expect(text(english, english), english).toStrictEqual([]);
  }
});

test("identical: canonically equivalent text is identical", () => {
  expect(summary(text("Café", "Cafe\u0301"))).toStrictEqual(["identical"]);
  expect(summary(text("Cafe\u0301", "Café"))).toStrictEqual(["identical"]);
});

test("identical: forms compared with the same category, or other", () => {
  const results = plural("pl", COINS, {
    one: "{{count}} coin",
    few: "{{count}} coins",
    many: "{{count}} coin",
    other: "{{count}} coins",
  });
  expect(results).toStrictEqual([
    {
      check: "identical",
      severity: "warning",
      message: "Identical to the English (one form).",
      form: "one",
    },
    {
      check: "identical",
      severity: "warning",
      message: "Identical to the English (few form).",
      form: "few",
    },
    {
      check: "identical",
      severity: "warning",
      message: "Identical to the English (other form).",
      form: "other",
    },
  ]);
  const noLetters = { one: "{{count}}", other: "{{count}}" };
  expect(plural("ja", noLetters, { other: "{{count}}" })).toStrictEqual([]);
});

test("numbers_differ: a warning naming the first number that differs", () => {
  const results = text("3 lives left", "Noch 5 Leben");
  expect(results).toStrictEqual([
    {
      check: "numbers_differ",
      severity: "warning",
      message: "The numbers differ from the English.",
      value: "3",
    },
  ]);
  expect(hasErrors(results)).toBeFalsy();
  expect(text("Lives left", "Noch 5 Leben")[0].value).toBe("5");
  expect(text("1 or 1", "1 oder 2")[0].value).toBe("1");
  expect(text("1 or 2", "1, 2 oder 2")[0].value).toBe("2");
  expect(text("Level 12", "Stufe 1 2")[0].value).toBe("12");
});

test("numbers_differ: order doesn't matter, values do", () => {
  expect(text("From 1 to 10", "Von 10 bis 1")).toStrictEqual([]);
  expect(text("Mission 07", "Mission 7")).toStrictEqual([]);
  expect(text("Room 0", "Raum 000")).toStrictEqual([]);
  expect(text("1,000 coins", "1.000 Münzen")).toStrictEqual([]);
  expect(text("1,000 coins", "1\u202f000 pièces", { language: "fr" })).toStrictEqual([]);
  expect(text("Version 1.5", "Version 1,5")).toStrictEqual([]);
  expect(summary(text("1,000 coins", "1000 Münzen"))).toStrictEqual(["numbers_differ"]);
});

test("numbers_differ: digits of other scripts count by their value", () => {
  const cases: [string, string][] = [
    ["ar", "المستوى ٣ من ١٢"], // Arabic-Indic
    ["fa", "مرحله ۳ از ۱۲"], // Extended Arabic-Indic
    ["hi", "स्तर ३ में से १२"], // Devanagari
    ["th", "ระดับ ๓ จาก ๑๒"], // Thai
    ["ja", "レベル３／１２"], // fullwidth
    ["en", "Level 𝟑 of 𝟏𝟐"], // mathematical bold, surrogate pairs
    ["en", "Level 𝟛 of 𝟙𝟚"], // mathematical double-struck, the second run of five
    ["en", "Level 𝟹 of 𝟷𝟸"], // mathematical monospace, the last run
  ];
  for (const [language, translation] of cases) {
    expect(text("Level 3 of 12", translation, { language }), translation).toStrictEqual([]);
  }
  // The value is the number as written: the English one that is missing, or the extra one.
  expect(text("Level 3 of 12", "المستوى ٤ من ١٢", { language: "ar" })[0].value).toBe("3");
  expect(text("Level 12", "المستوى ٤ من ١٢", { language: "ar" })[0].value).toBe("٤");
});

test("numbers_differ: agrees with the runtime's digits in every numbering system", () => {
  const systems = Intl.supportedValuesOf("numberingSystem");
  let checked = 0;
  for (const system of systems) {
    const format = new Intl.NumberFormat(`en-u-nu-${system}`, { useGrouping: false });
    if (format.resolvedOptions().numberingSystem !== system) continue;
    const digits = format.format(1234567890);
    if (!/^\p{Nd}+$/u.test(digits)) continue; // Not a decimal system, such as roman.
    expect(text("Number 1234567890", `Zahl ${digits}`), system).toStrictEqual([]);
    checked++;
  }
  assert(checked >= 20, `${checked} numbering systems`);
});

test("numbers_differ: only text counts, not placeholders or references", () => {
  expect(text("{{item1}} and $t(level2)", "{{item1}} und $t(level2)")).toStrictEqual([]);
  expect(summary(text("{{count}} coins", "3 Münzen"))).toStrictEqual([
    "placeholder_missing",
    "numbers_differ",
  ]);
  expect(summary(text("¹ note", "Hinweis")), "superscripts aren't decimal digits").toStrictEqual(
    [],
  );
  expect(summary(text("Chapter Ⅳ", "Kapitel 4"))).toStrictEqual(["numbers_differ"]);
});

test("numbers_differ: forms compared with the same category, or other", () => {
  const english = { one: "1 coin", other: "{{count}} coins" };
  expect(plural("pl", english, { ...POLISH, one: "Jedna moneta" })).toStrictEqual([
    {
      check: "numbers_differ",
      severity: "warning",
      message: "The numbers differ from the English (one form).",
      form: "one",
      value: "1",
    },
  ]);
  expect(plural("pl", english, { ...POLISH, one: "1 moneta" })).toStrictEqual([]);
  expect(
    summary(plural("pl", english, { ...POLISH, one: "1 moneta", few: "{{count}} monety (2)" })),
  ).toStrictEqual(["numbers_differ:few"]);
});

test("ordinals: French first may leave out {{count}}; English ordinals may not", () => {
  const english = {
    one: "{{count}}st place",
    two: "{{count}}nd place",
    few: "{{count}}rd place",
    other: "{{count}}th place",
  };
  expect(
    ordinal("fr", english, { one: "Première place", other: "{{count}}e place" }),
  ).toStrictEqual([]);
  expect(summary(ordinal("fr", english, { one: "{{count}}re place" }))).toStrictEqual([
    "plural_form_missing:other",
  ]);
  // English ordinal one covers 1, 21, 31, …; two covers 2, 22, 32, ….
  const british = { one: "First", two: "Second", few: "{{count}}rd", other: "{{count}}th" };
  expect(summary(ordinal("en-GB", english, british))).toStrictEqual([
    "placeholder_missing:one",
    "placeholder_missing:two",
  ]);
});

test("ordinals: the language's ordinal categories, not its cardinal ones", () => {
  const english = {
    one: "{{count}}st",
    two: "{{count}}nd",
    few: "{{count}}rd",
    other: "{{count}}th",
  };
  expect(ordinal("pl", english, { other: "{{count}}." })).toStrictEqual([]);
  expect(ordinal("pl", english, { one: "{{count}}.", other: "{{count}}." })).toStrictEqual([
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The one form isn't used in Polish.",
      form: "one",
    },
  ]);
  // No zero form for ordinals, even when English has one.
  const withZero = { zero: "Unranked", ...english };
  expect(summary(ordinal("fr", withZero, { one: "1re", other: "{{count}}e" }))).toStrictEqual([
    "numbers_differ:one",
  ]);
  expect(
    messages(
      ordinal("fr", withZero, { zero: "Non classé", one: "{{count}}re", other: "{{count}}e" }),
    ),
  ).toStrictEqual(["The zero form isn't used in French."]);
});

test("plural_form_missing and plural_form_unexpected", () => {
  expect(plural("pl", COINS, { one: "Jedna moneta", other: "{{count}} monety" })).toStrictEqual([
    {
      check: "plural_form_missing",
      severity: "error",
      message: "The few form is missing.",
      form: "few",
    },
    {
      check: "plural_form_missing",
      severity: "error",
      message: "The many form is missing.",
      form: "many",
    },
  ]);
  expect(plural("ja", COINS, { one: "1枚", other: "{{count}}枚" })).toStrictEqual([
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The one form isn't used in Japanese.",
      form: "one",
    },
  ]);
  expect(
    messages(
      plural("pt-BR", COINS, {
        one: "{{count}} moeda",
        two: "{{count}} moedas",
        many: "{{count}} de moedas",
        other: "{{count}} moedas",
      }),
    ),
  ).toStrictEqual(["The two form isn't used in Portuguese (Brazil)."]);
  expect(summary(plural("pl", COINS, {}))).toStrictEqual([
    "plural_form_missing:one",
    "plural_form_missing:few",
    "plural_form_missing:many",
    "plural_form_missing:other",
  ]);
});

test("plural forms: undefined is absent, and unknown names are unexpected", () => {
  expect(plural("pl", COINS, { ...POLISH, two: undefined })).toStrictEqual([]);
  expect(summary(plural("pl", COINS, { ...POLISH, few: undefined }))).toStrictEqual([
    "plural_form_missing:few",
  ]);
  const unknown = { ...POLISH, plural: "x", few_: "y" } as PluralForms;
  expect(plural("pl", COINS, unknown)).toStrictEqual([
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The plural form isn't used in Polish.",
      value: "plural",
    },
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The few_ form isn't used in Polish.",
      value: "few_",
    },
  ]);
});

test("zero: every language gets a zero form when English has one", () => {
  const english = { zero: "No coins", one: "One coin", other: "{{count}} coins" };
  expect(plural("pl", english, { ...POLISH, one: "Jedna moneta" })).toStrictEqual([
    {
      check: "plural_form_missing",
      severity: "error",
      message: "The zero form is missing.",
      form: "zero",
    },
  ]);
  // An added zero form covers only 0, so it may leave out {{count}}.
  expect(plural("pl", english, { zero: "Brak monet", ...POLISH })).toStrictEqual([]);
  expect(plural("ja", english, { zero: "コインなし", other: "{{count}}枚" })).toStrictEqual([]);
  // Latvian's own zero covers 0, 10–20, 30, …, so it keeps {{count}}.
  const latvian = { zero: "Nav monētu", one: "{{count}} monēta", other: "{{count}} monētas" };
  expect(summary(plural("lv", english, latvian))).toStrictEqual(["placeholder_missing:zero"]);
  // The zero form is compared with the English zero form.
  expect(summary(plural("ja", english, { zero: "No coins", other: "{{count}}枚" }))).toStrictEqual([
    "identical:zero",
  ]);
  // Without an English zero form, a zero form is unexpected in Polish.
  expect(messages(plural("pl", COINS, { zero: "Brak monet", ...POLISH }))).toStrictEqual([
    "The zero form isn't used in Polish.",
  ]);
});

test("zero: with a zero form, 0 leaves the other categories", () => {
  // Regression: where CLDR one is 0–1 (pa, ln, ak, mg, ti), one covers only 1 once 0 has
  // a zero form, so it may leave out {{count}}, as Polish one may.
  const english = { zero: "No coins", one: "{{count}} coin", other: "{{count}} coins" };
  for (const language of ["pa", "ln", "ak", "mg", "ti"]) {
    expect(
      plural(language, english, { zero: "ZERO", one: "ONE", other: "{{count}} OTHER" }),
      language,
    ).toStrictEqual([]);
    // Without an English zero form, one covers 0 and 1, and keeps {{count}}.
    expect(
      summary(plural(language, COINS, { one: "ONE", other: "{{count}} OTHER" })),
      language,
    ).toStrictEqual(["placeholder_missing:one"]);
  }
  // French one still covers 1 and 1.5 without 0.
  expect(
    summary(plural("fr", english, { zero: "Z", one: "UN", many: "{{count}}", other: "{{count}}" })),
  ).toStrictEqual(["placeholder_missing:one"]);
});

test("empty: a form may stay empty where the English one is empty", () => {
  // Regression: English "left_zero": "" made every translation fail, empty or not.
  const english = { zero: "", one: "{{count}} left", other: "{{count}} left" };
  const german = { zero: "", one: "{{count}} übrig", other: "{{count}} übrig" };
  expect(plural("de", english, german)).toStrictEqual([]);
  expect(summary(plural("de", english, { ...german, zero: " " }))).toStrictEqual([
    "whitespace:zero",
  ]);
  expect(plural("de", english, { ...german, zero: "Nichts mehr übrig" })).toStrictEqual([]);
  expect(summary(plural("de", english, { one: german.one, other: german.other }))).toStrictEqual([
    "plural_form_missing:zero",
  ]);
  expect(summary(plural("de", english, { ...german, one: "" }))).toStrictEqual(["empty:one"]);
  // Categories English lacks compare with English other.
  const blankOther = { one: "One left", other: "" };
  expect(
    summary(plural("pl", blankOther, { one: "Jeden", few: "", many: " ", other: "" })),
  ).toStrictEqual(["whitespace:many"]);
  // A blank English text allows a blank translation.
  expect(summary(text(" ", ""))).toStrictEqual(["whitespace"]);
  expect(summary(text("Play", ""))).toStrictEqual(["empty"]);
});

test("pluralOverride replaces the language's categories", () => {
  const pluralOverride = { cardinal: ["one", "few", "other"] as PluralCategory[] };
  const { many: _, ...withoutMany } = POLISH;
  expect(plural("pl", COINS, withoutMany, { pluralOverride })).toStrictEqual([]);
  expect(summary(plural("pl", COINS, POLISH, { pluralOverride }))).toStrictEqual([
    "plural_form_unexpected:many",
  ]);
  // An ordinal override leaves cardinal strings alone.
  const ordinalOnly = { ordinal: ["other"] as PluralCategory[] };
  expect(plural("pl", COINS, POLISH, { pluralOverride: ordinalOnly })).toStrictEqual([]);
  // A category the runtime doesn't have is assumed to cover many numbers.
  const withTwo = { cardinal: ["one", "two", "few", "many", "other"] as PluralCategory[] };
  expect(
    summary(plural("pl", COINS, { ...POLISH, two: "Dwie" }, { pluralOverride: withTwo })),
  ).toStrictEqual(["placeholder_missing:two"]);
});

test("tags_differ: a warning naming the first missing tag, else the first extra one", () => {
  expect(text("Press <b>Start</b>", "Drücke Start")).toStrictEqual([
    {
      check: "tags_differ",
      severity: "warning",
      message: "Tag <b> is missing.",
      value: "<b>",
    },
  ]);
  expect(messages(text("Press <1>Start</1>", "Drücke <1>Start</1><br/>"))).toStrictEqual([
    "Tag <br/> isn't in the English, or is repeated.",
  ]);
  expect(
    summary(plural("en-GB", COINS, { one: "<b>One</b> coin", other: "{{count}} gold coins" })),
  ).toStrictEqual(["tags_differ:one"]);
});

test("tags_differ: attributes, letter case and order don't matter", () => {
  expect(
    text('Read <a href="/rules">the rules</a>', 'Lies <A href="/regeln">die Regeln</A>'),
  ).toStrictEqual([]);
  expect(text("<b>Big</b> <i>news</i>", "<i>Große</i> <b>Neuigkeiten</b>")).toStrictEqual([]);
  expect(text("One<br />two", "Eins<br/>zwei")).toStrictEqual([]);
  expect(text("1 < 2 and 3 > 2", "1 < 2 und 3 > 2"), "comparisons aren't tags").toStrictEqual([]);
});

test("whitespace: a line break or space at either end that the English doesn't have", () => {
  expect(text("Play", "Spielen\n")).toStrictEqual([
    {
      check: "whitespace",
      severity: "error",
      message: "The translation ends with a line break; the English doesn't.",
    },
  ]);
  expect(messages(text("Play\n", "Spielen"))).toStrictEqual([
    "The English ends with a line break; the translation doesn't.",
  ]);
  expect(messages(text(" Play", "  Spielen"))).toStrictEqual([
    "The translation starts with 2 spaces; the English with a space.",
  ]);
  expect(messages(text("Play\n\n", "Spielen \n"))).toStrictEqual([
    "The translation ends with a line break; the English with 2 line breaks.",
  ]);
  expect(
    summary(plural("en-GB", COINS, { one: "One coin ", other: "{{count}} gold coins" })),
  ).toStrictEqual(["whitespace:one"]);
});

test("whitespace: the same whitespace, in any line ending, is fine", () => {
  expect(text("Play\r\n", "Spielen\n")).toStrictEqual([]);
  expect(text("  Play ", "  Spielen ")).toStrictEqual([]);
});

test("whitespace: compares the line breaks inside the text", () => {
  expect(text("Game over.\nTry again?", "Spiel vorbei. Nochmal?")).toStrictEqual([
    {
      check: "whitespace",
      severity: "error",
      message: "The English has 1 line break inside; the translation has 0.",
    },
  ]);
  expect(text("Game over.\r\nTry again?", "Spiel vorbei.\nNochmal?")).toStrictEqual([]);
});

test("double_space: two spaces in a row inside the text", () => {
  expect(text("New game", "Neues  Spiel")).toStrictEqual([
    { check: "double_space", severity: "warning", message: "Two spaces in a row." },
  ]);
  expect(summary(text("Score:  {{n}}", "Punkte:  {{n}}"))).toStrictEqual(["double_space"]);
});

test("end_punctuation: a different question mark, exclamation mark, ellipsis or colon", () => {
  expect(text("Quit?", "Beenden")).toStrictEqual([
    {
      check: "end_punctuation",
      severity: "warning",
      message: "The English ends with a question mark; the translation doesn't.",
    },
  ]);
  expect(messages(text("Save as", "Speichern unter…"))).toStrictEqual([
    "The translation ends with an ellipsis; the English doesn't.",
  ]);
  expect(messages(text("You win!", "Du gewinnst?"))).toStrictEqual([
    "The translation ends with a question mark; the English with an exclamation mark.",
  ]);
  expect(messages(text("Name:", "Name"))).toStrictEqual([
    "The English ends with a colon; the translation doesn't.",
  ]);
});

test("end_punctuation: each script's own marks count", () => {
  expect(text("Quit?", "終了しますか？", { language: "ja" })).toStrictEqual([]);
  expect(text("Quit?", "هل تريد الخروج؟", { language: "ar" })).toStrictEqual([]);
  expect(text("Quit?", "Έξοδος;", { language: "el" })).toStrictEqual([]);
  expect(text("Loading...", "Wird geladen…")).toStrictEqual([]);
  expect(text("Name:", "名前：", { language: "ja" })).toStrictEqual([]);
  expect(text("Nice!", "Super !", { language: "fr" })).toStrictEqual([]);
  expect(text("Game over.", "Spiel vorbei"), "full stops aren't compared").toStrictEqual([]);
});

test("results: errors first, then in CHECKS order, then by form in CLDR order", () => {
  const results = plural(
    "pl",
    COINS,
    {
      two: "x",
      other: "{{count}} coins",
      many: "",
      few: "{{count}} {{x}} monety 5",
      one: "Jedna moneta 3",
    },
    { maxLength: 14 },
  );
  expect(summary(results)).toStrictEqual([
    "empty:many",
    "placeholder_extra:few",
    "plural_form_unexpected:two",
    "max_length:few",
    "max_length:other",
    "identical:other",
    "numbers_differ:one",
    "numbers_differ:few",
  ]);
  expect(errorsOf(results).length).toBe(5);
  const textResults = text("{{a}} $t(b) 1 x", "{{c}} $t(d) 2 x {{a}}{{a}}", { maxLength: 3 });
  expect(summary(textResults)).toStrictEqual([
    "placeholder_extra",
    "placeholder_extra",
    "reference_missing",
    "reference_extra",
    "max_length",
    "numbers_differ",
  ]);
  expect(textResults.map((result) => result.value)).toStrictEqual([
    "{{c}}",
    "{{a}}",
    "$t(b)",
    "$t(d)",
    undefined,
    "1",
  ]);
});

test("results: every check id is reachable, with the severity from CHECKS", () => {
  const seen = new Set<string>();
  const all = [
    text("Play", { other: "x" }),
    text("Play", ""),
    text("{{a}} $t(b) Options 1", "{{c}} $t(d) Options 2", { maxLength: 1 }),
    text("Options", "Options"),
    text("game", "Anwendung", {
      glossary: [{ term: "game", translation: "Spiel", kind: "translate" }],
    }),
    plural("pl", COINS, { two: "{{count}}" }),
    [
      ...checkDuplicateTranslations([
        {
          id: 1,
          fileId: 1,
          language: "de",
          kind: "text",
          key: "barn",
          source: "Barn",
          translation: "Scheune",
        },
        {
          id: 2,
          fileId: 1,
          language: "de",
          kind: "text",
          key: "loft",
          source: "Loft",
          translation: "Scheune",
        },
      ]).values(),
    ].flat(),
    [
      ...checkTranslationConsistency([
        {
          id: 1,
          fileId: 1,
          language: "de",
          kind: "text",
          key: "a",
          source: "Play",
          translation: "Spielen",
        },
        {
          id: 2,
          fileId: 2,
          language: "de",
          kind: "text",
          key: "b",
          source: "Play",
          translation: "Los",
        },
      ]).values(),
    ].flat(),
    meaningWarnings([{ kind: "omission", explanation: "The second sentence is missing." }]),
    text("<b>Quit?</b>", "<i>Beenden</i>"),
    text("Quit?", " Beenden\n  jetzt"),
    text("Headline\n\nBody.", "Titel\n\nText.\n\nMehr.", { document: true }),
    text("# Run `init`\n\n[Top](#run-init)", "Führe `init` aus\n\n[Oben](#x)", { document: true }),
    text("Run `init`", "Führe `start` aus", { document: true }),
    text("{a, select, x {X} other {O}}", "{a, select, y {Y} other {O}}", {
      syntax: { prefix: "{{", suffix: "}}", icu: true },
    }),
  ];
  for (const results of all) {
    for (const result of results) {
      expect(result.severity).toStrictEqual(CHECKS[result.check]);
      seen.add(result.check);
    }
  }
  expect([...seen].sort()).toStrictEqual(Object.keys(CHECKS).sort());
});

test("results: optional fields are left out, not undefined", () => {
  for (const result of text("{{a}} Play", "{{b}}", { maxLength: 1 })) {
    for (const [field, value] of Object.entries(result)) {
      assert(value !== undefined, `${result.check}.${field}`);
    }
  }
});

test("mismatched English values: forms for text, and text for plurals", () => {
  expect(summary(text(COINS as unknown as string, "Münzen"))).toStrictEqual([
    "placeholder_missing",
  ]);
  expect(text(COINS as unknown as string, "{{count}} Münzen")).toStrictEqual([]);
  expect(plural("pl", "{{count}} coins" as unknown as PluralForms, POLISH)).toStrictEqual([]);
  expect(summary(plural("pl", { one: "{{count}} coin" }, { ...POLISH, few: "x" }))).toStrictEqual([
    "placeholder_missing:few",
  ]);
});

test("CRLF files: line breaks are text like any other", () => {
  const english = "Line one\r\n{{count}} coins\r\n";
  expect(text(english, "Zeile eins\r\n{{count}} Münzen\r\n")).toStrictEqual([]);
  expect(summary(text(english, "Zeile eins\r\nMünzen\r\n"))).toStrictEqual(["placeholder_missing"]);
  expect(summary(text("A\r\nB", "A\r\nB"))).toStrictEqual(["identical"]);
  expect(text("3\r\n4", "4\r\n3")).toStrictEqual([]);
});

test("an invalid language tag throws for plural strings", () => {
  expect(() => plural("not a tag", COINS, POLISH)).toThrow(RangeError);
  expect(text("Play", "Spielen", { language: "not a tag" })).toStrictEqual([]);
});

test("results never depend on the order the runtime lists categories in", () => {
  const prototype = Intl.PluralRules.prototype;
  const original = prototype.resolvedOptions;
  prototype.resolvedOptions = function (this: Intl.PluralRules) {
    const options = original.call(this);
    return { ...options, pluralCategories: [...options.pluralCategories].reverse() };
  };
  try {
    // A tag no other test uses, so its rules aren't cached yet.
    expect(summary(plural("be-BY", COINS, { two: "x", zero: "y" }))).toStrictEqual([
      "plural_form_missing:one",
      "plural_form_missing:few",
      "plural_form_missing:many",
      "plural_form_missing:other",
      "plural_form_unexpected:zero",
      "plural_form_unexpected:two",
    ]);
  } finally {
    prototype.resolvedOptions = original;
  }
});

test("checks stay fast on large values", () => {
  const unit = 'Hello {{name}}, $t(coins, {"count": {{n}}}) left, 42 é. ';
  const english = unit.repeat(50_000); // About 2.8 MB.
  const translation = unit.replace("Hello", "Hallo").repeat(50_000);
  const started = performance.now();
  const results = text(english, translation, { maxLength: 10 });
  const elapsed = performance.now() - started;
  expect(summary(results)).toStrictEqual(["max_length"]);
  assert(elapsed < 5000, `${elapsed} ms`);

  const forms = { one: english, other: english };
  const polish = { one: translation, few: translation, many: translation, other: translation };
  const again = performance.now();
  expect(plural("pl", forms, polish)).toStrictEqual([]);
  assert(performance.now() - again < 10000);
});

test("extra delimiters: the app's own placeholders are checked like i18next's", () => {
  const syntax = { prefix: "{{", suffix: "}}", extra: [{ prefix: "{", suffix: "}" }] };
  const english = "Join {companyName}, {{count}} openings";
  expect(text(english, "Komm zu {companyName}, {{count}} Stellen", { syntax })).toStrictEqual([]);
  expect(
    errorsOf(text(english, "Komm zu {Firmenname}, {{count}} Stellen", { syntax })).map((result) => [
      result.check,
      result.value,
    ]),
  ).toStrictEqual([
    ["placeholder_missing", "{companyName}"],
    ["placeholder_extra", "{Firmenname}"],
  ]);
  expect(
    errorsOf(text(english, "Komm zu {{companyName}}, {{count}} Stellen", { syntax })).map(
      (result) => [result.check, result.value],
    ),
  ).toStrictEqual([
    ["placeholder_missing", "{companyName}"],
    ["placeholder_extra", "{{companyName}}"],
  ]);
});

test("optional placeholders: the listed languages may leave them out, the others may not", () => {
  const syntax = {
    prefix: "{{",
    suffix: "}}",
    extra: [{ prefix: "{", suffix: "}" }],
    optional: [{ placeholder: "{article}", languages: ["pl", "tr"] }],
  };
  const english = "Looking for work as {article} {profession}";
  const polish = "Szukam pracy jako {profession}";
  expect(text(english, polish, { syntax, language: "pl" })).toStrictEqual([]);
  expect(
    errorsOf(text(english, "Suche Arbeit als {profession}", { syntax, language: "de" })).map(
      (result) => [result.check, result.value],
    ),
  ).toStrictEqual([["placeholder_missing", "{article}"]]);
  expect(
    errorsOf(text(english, "Szukam pracy jako {article}", { syntax, language: "pl" })).map(
      (result) => [result.check, result.value],
    ),
  ).toStrictEqual([["placeholder_missing", "{profession}"]]);
});

test("whitespace rejects tabs exchanged for spaces and spaces beside a line break", () => {
  assert(hasErrors(text("\tPlay", " Spielen")));
  assert(hasErrors(text("Play\n", "Spielen \n")));
  assert(hasErrors(text("One paragraph.\n\nAnother.", "Ein Absatz.\nNoch einer.")));
  expect(hasErrors(text("Play\r\n", "Spielen\n"))).toBeFalsy();
  expect(hasErrors(text("New game", "Neues  Spiel"))).toBeFalsy();
});

test("duplicate translations compare case and edge whitespace within one file and language", () => {
  const common = { fileId: 1, language: "de", kind: "text" as const };
  const results = checkDuplicateTranslations([
    { ...common, id: 1, key: "barn", source: "Storage Barn", translation: "Scheune" },
    { ...common, id: 2, key: "loft", source: "Hay Loft", translation: " SCHEUNE " },
  ]);
  expect(results.get('[1,"de"]')?.[0].message).toStrictEqual(
    'Same as loft, whose English is "Hay Loft".',
  );
  expect(results.get('[2,"de"]')?.[0].check).toBe("duplicate_translation");
  expect(
    checkDuplicateTranslations([
      { ...common, id: 1, key: "a", source: "Barn", translation: "Scheune" },
      { ...common, id: 2, key: "b", source: "Barn", translation: "Scheune" },
    ]).size,
  ).toBe(0);
  expect(
    checkDuplicateTranslations([
      { ...common, id: 1, key: "a", source: "Yes", translation: "Ja" },
      { ...common, id: 2, key: "b", source: "Sure", translation: "JA" },
      { ...common, id: 3, key: "c", source: "Barn", translation: "Scheune" },
      { ...common, id: 4, fileId: 2, key: "d", source: "Loft", translation: "Scheune" },
      { ...common, id: 5, language: "fr", key: "e", source: "Loft", translation: "Scheune" },
      { ...common, id: 6, kind: "reference", key: "f", source: "Loft", translation: "Scheune" },
    ]).size,
  ).toBe(0);
});

// Documents

const ARTICLE = [
  "The moment has arrived: {{cityName}} is founded",
  "",
  "What was once a patch of dirt is now a patch of dirt with a name: {{cityName}}.",
  "",
  "Some managed to hold it. Others will have a story to tell.",
].join("\n");

test("documents: a translation with the same paragraphs passes, whatever its line endings", () => {
  const translation = [
    "Der Moment ist gekommen: {{cityName}} ist gegründet",
    "",
    "Was einst ein Stück Erde war, ist nun ein Stück Erde mit Namen: {{cityName}}.",
    "",
    "",
    "Manche hielten durch. Andere haben nun etwas zu erzählen.",
    "",
  ].join("\r\n");
  expect(text(ARTICLE, translation, { document: true })).toStrictEqual([]);
  expect(text(`${ARTICLE}\n`, translation, { document: true })).toStrictEqual([]);
});

test("documents: paragraphs replace line breaks, so an extra blank line isn't an error", () => {
  const extraBlankLine = ARTICLE.replace("\n\nSome", "\n\n\nSome");
  expect(text(ARTICLE, extraBlankLine, { document: true })).toStrictEqual([]);
  expect(summary(text(ARTICLE, extraBlankLine))).toStrictEqual(["whitespace"]);
});

test("documents: a merged or split paragraph is an error", () => {
  const merged = ARTICLE.replace("\n\nSome", " Some");
  expect(text(ARTICLE, merged, { document: true })).toStrictEqual([
    {
      check: "paragraphs",
      severity: "error",
      message: "The English has 3 paragraphs; the translation has 2.",
    },
  ]);
  const split = ARTICLE.replace(": {{cityName}}.", ".\n\n{{cityName}}.");
  expect(messages(text(ARTICLE, split, { document: true }))).toStrictEqual([
    "The English has 3 paragraphs; the translation has 4.",
  ]);
});

test("documents: placeholders are checked across the whole file", () => {
  const missing = ARTICLE.replace("name: {{cityName}}.", "name.");
  expect(summary(text(ARTICLE, missing, { document: true }))).toStrictEqual([
    "placeholder_missing",
  ]);
});

test("documents: whitespace at the end never counts, at the start it does", () => {
  expect(text(ARTICLE, `${ARTICLE}\n\n  `, { document: true })).toStrictEqual([
    { check: "identical", severity: "warning", message: "Identical to the English." },
  ]);
  expect(summary(text(ARTICLE, `\n${ARTICLE}`, { document: true }))).toStrictEqual(["whitespace"]);
});

const GUIDE = [
  "---",
  "title: Getting started",
  "---",
  "",
  "## Installation",
  "",
  "Run `quaso init`, then read [the guide](https://example.com/guide).",
  "",
  "```sh",
  "quaso upload",
  "```",
  "",
  "- [Back to installation](#installation)",
].join("\n");

const GUIDE_DE = [
  "---",
  "title: Erste Schritte",
  "---",
  "",
  "## Installation",
  "",
  "Führe `quaso init` aus und lies dann [die Anleitung](https://example.com/guide).",
  "",
  "```sh",
  "quaso upload",
  "```",
  "",
  "- [Zurück zur Installation](#installation)",
].join("\n");

test("documents: a Markdown translation that keeps code, links and structure passes", () => {
  expect(text(GUIDE, GUIDE_DE, { document: true })).toStrictEqual([]);
});

test("documents: translated inline code is an error", () => {
  const translated = GUIDE_DE.replace("`quaso init`", "`quaso initialisieren`");
  expect(text(GUIDE, translated, { document: true })).toStrictEqual([
    {
      check: "markdown_verbatim",
      severity: "error",
      message: "“`quaso init`” must stay as in the English: it is missing or changed.",
      value: "`quaso init`",
    },
  ]);
});

test("documents: a translated code block is an error, named by its first line", () => {
  const translated = GUIDE_DE.replace("quaso upload", "quaso hochladen");
  expect(messages(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "The code block starting “```sh” must stay as in the English: it is missing or changed.",
  ]);
});

test("documents: a localised URL is an error", () => {
  const translated = GUIDE_DE.replace("example.com/guide", "example.com/de/guide");
  expect(messages(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "“https://example.com/guide” must stay as in the English: it is missing or changed.",
  ]);
});

test("documents: a translated front matter key is an error", () => {
  const translated = GUIDE_DE.replace("title:", "titel:");
  expect(messages(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "“title:” must stay as in the English: it is missing or changed.",
  ]);
});

test("documents: an added link destination is an error", () => {
  const translated = GUIDE_DE.replace("dann", "dann [mehr](https://example.com/more)");
  expect(messages(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "“https://example.com/more” isn't in the English, or is repeated.",
  ]);
});

test("documents: a heading turned into a paragraph is an error", () => {
  const translated = GUIDE_DE.replace("## Installation", "Installation");
  expect(text(GUIDE, translated, { document: true })).toStrictEqual([
    {
      check: "markdown_structure",
      severity: "error",
      message:
        "Paragraph 2 is a level-2 heading in the English, but a paragraph in the translation.",
    },
    {
      check: "heading_anchor",
      severity: "warning",
      message:
        "The link to #installation leads to no heading of the translation: use the translated heading's anchor.",
      value: "#installation",
    },
  ]);
});

test("documents: a changed heading level is an error", () => {
  const translated = GUIDE_DE.replace("## Installation", "### Installation");
  expect(messages(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "Paragraph 2 is a level-2 heading in the English, but a level-3 heading in the translation.",
  ]);
});

test("documents: a list turned into a quote is an error", () => {
  const translated = GUIDE_DE.replace("- [Zurück", "> [Zurück");
  expect(summary(text(GUIDE, translated, { document: true }))).toStrictEqual([
    "markdown_structure",
  ]);
});

test("documents: a translated heading breaks the link to it: a warning", () => {
  const translated = GUIDE_DE.replace("## Installation", "## Einrichtung");
  expect(text(GUIDE, translated, { document: true })).toStrictEqual([
    {
      check: "heading_anchor",
      severity: "warning",
      message:
        "The link to #installation leads to no heading of the translation: use the translated heading's anchor.",
      value: "#installation",
    },
  ]);
});

test("documents: a link rewritten to the translated heading's anchor passes", () => {
  const translated = GUIDE_DE.replace("## Installation", "## Einrichtung").replace(
    "(#installation)",
    "(#einrichtung)",
  );
  expect(text(GUIDE, translated, { document: true })).toStrictEqual([]);
});

test("documents: a link to an anchor outside the headings, kept as in the English, passes", () => {
  const english = "Intro.\n\n[Top](#top)";
  expect(text(english, "Einleitung.\n\n[Nach oben](#top)", { document: true })).toStrictEqual([]);
});

test("documents: the Markdown checks don't run on strings that aren't documents", () => {
  expect(text("Run `init`", "Führe `initialisieren` aus")).toStrictEqual([]);
});

// --- ICU MessageFormat.

const ICU = { prefix: "{{", suffix: "}}", icu: true };

const MAYOR = `{style, select,
  masculine {Mayor {name} has started a new term.}
  feminine {Mayor {name} has started a new term.}
  other {{name} has started a new term.}
}`;

const ALCALDE = `{style, select,
  masculine {El alcalde {name} ha comenzado su nuevo mandato.}
  feminine {La alcaldesa {name} ha comenzado su nuevo mandato.}
  other {Ha comenzado el nuevo mandato de {name}.}
}`;

test("checks, ICU: a select block translated case by case passes", () => {
  expect(text(MAYOR, ALCALDE, { language: "es", syntax: ICU })).toStrictEqual([]);
});

test("checks, ICU: a placeholder missing from a case says which case", () => {
  const translation = ALCALDE.replace("La alcaldesa {name}", "La alcaldesa");
  expect(messages(text(MAYOR, translation, { language: "es", syntax: ICU }))).toStrictEqual([
    "Placeholder {name} is missing in the feminine case of {style, select}.",
  ]);
});

test("checks, ICU: a missing or extra select case is an error", () => {
  const translation = `{style, select,
  male {El alcalde {name} ha comenzado su nuevo mandato.}
  feminine {La alcaldesa {name} ha comenzado su nuevo mandato.}
  other {Ha comenzado el nuevo mandato de {name}.}
}`;
  expect(messages(text(MAYOR, translation, { language: "es", syntax: ICU }))).toStrictEqual([
    "The masculine case of {style, select} is missing.",
    "The male case of {style, select} isn't in the English.",
  ]);
});

test("checks, ICU: a broken block is reported missing", () => {
  const translation = ALCALDE.slice(0, -1);
  const results = text(MAYOR, translation, { language: "es", syntax: ICU });
  assert(summary(results).includes("icu_structure"));
});

test("checks, ICU: plural cases follow the language's categories", () => {
  const source = "{n, plural, one {# coin} other {# coins}}";
  const polish = "{n, plural, one {# moneta} few {# monety} many {# monet} other {# monety}}";
  expect(text(source, polish, { language: "pl", syntax: ICU })).toStrictEqual([]);
  expect(
    messages(
      text(source, "{n, plural, one {# moneta} other {# monety}}", { language: "pl", syntax: ICU }),
    ),
  ).toStrictEqual([
    "The few case of {n, plural} is missing.",
    "The many case of {n, plural} is missing.",
  ]);
  expect(
    messages(text(source, "{n, plural, one {# 枚} other {# 枚}}", { language: "ja", syntax: ICU })),
  ).toStrictEqual(["The one case of {n, plural} isn't used in Japanese."]);
});

test("checks, ICU: a case that covers one number may leave out #", () => {
  const source = "{n, plural, one {# coin} other {# coins}}";
  expect(
    text(source, "{n, plural, one {eine Münze} other {# Münzen}}", { language: "de", syntax: ICU }),
  ).toStrictEqual([]);
  expect(
    messages(
      text(source, "{n, plural, one {# Münze} other {Münzen}}", { language: "de", syntax: ICU }),
    ),
  ).toStrictEqual(["Placeholder # is missing in the other case of {n, plural}."]);
});

test("checks, ICU: keywords and exact cases are neither text nor numbers", () => {
  const source = "{n, plural, =0 {No coins} other {# coins}}";
  expect(
    text(source, "{n, plural, =0 {Keine Münzen} one {# Münze} other {# Münzen}}", {
      language: "de",
      syntax: ICU,
    }),
  ).toStrictEqual([]);
});

test("checks, ICU: a block inside a Markdown document is checked like a string's", () => {
  const source = `# The town hall\n\n${MAYOR}\n\nSee \`{ "a": 1 }\` and [the term](#the-town-hall).`;
  const good = `# El ayuntamiento\n\n${ALCALDE}\n\nVer \`{ "a": 1 }\` y [el mandato](#el-ayuntamiento).`;
  expect(text(source, good, { language: "es", syntax: ICU, document: true })).toStrictEqual([]);
  const broken = good.replace("feminine {", "femenino {");
  expect(
    messages(text(source, broken, { language: "es", syntax: ICU, document: true })),
  ).toStrictEqual([
    "The feminine case of {style, select} is missing.",
    "The femenino case of {style, select} isn't in the English.",
  ]);
});

// --- ICU MessageFormat: arguments the English doesn't show.

const AUTHOR = [{ name: "authorGender", cases: ["female", "male"] }];

const JOINED = "Excited to join {company}!";

const UNIDA = `{authorGender, select,
  female {¡Emocionada de unirme a {company}!}
  male {¡Emocionado de unirme a {company}!}
  other {¡Qué ganas de empezar en {company}!}
}`;

const HIRING = "{name} says {authorGender, select, female {she} male {he} other {they}}'s hiring.";

/** Checks a text string in ICU MessageFormat, with `authorGender` declared. */
function feed(source: string, translation: string, language: string): CheckResult[] {
  return text(source, translation, { language, syntax: ICU, arguments: AUTHOR });
}

test("checks, arguments: a Spanish select added on a declared argument passes", () => {
  expect(feed(JOINED, UNIDA, "es")).toStrictEqual([]);
});

test("checks, arguments: a case missing a placeholder of the English names the case", () => {
  const translation = UNIDA.replace("¡Emocionado de unirme a {company}!", "¡Emocionado!");
  expect(messages(feed(JOINED, translation, "es"))).toStrictEqual([
    "Placeholder {company} is missing in the male case of {authorGender, select}.",
  ]);
});

test("checks, arguments: a problem in every case is reported once, without a case", () => {
  const translation = `{authorGender, select,
  female {¡Emocionada!}
  male {¡Emocionado!}
  other {¡Qué ganas!}
}`;
  expect(messages(feed(JOINED, translation, "es"))).toStrictEqual([
    "Placeholder {company} is missing.",
  ]);
});

test("checks, arguments: a case the declaration doesn't list is an error", () => {
  const translation = UNIDA.replace("other {", "neutral {¡Feliz en {company}!}\n  other {");
  expect(messages(feed(JOINED, translation, "es"))).toStrictEqual([
    "The neutral case of {authorGender, select} isn't one of its cases: female, male, other.",
  ]);
});

test("checks, arguments: a select on a declared argument needs an other case", () => {
  const translation = UNIDA.replace("other {¡Qué ganas de empezar en {company}!}", "");
  expect(messages(feed(JOINED, translation, "es"))).toStrictEqual([
    "The {authorGender, select} block needs an other case.",
  ]);
});

test("checks, arguments: the English's select may be left out where the language needs none", () => {
  expect(feed(HIRING, "{name}さんは採用活動中だそうです。", "ja")).toStrictEqual([]);
});

test("checks, arguments: without the English's select, its placeholders are still required", () => {
  expect(messages(feed(HIRING, "Hier wird eingestellt.", "de"))).toStrictEqual([
    "Placeholder {name} is missing.",
  ]);
});

test("checks, arguments: a select on an undeclared argument is refused as before", () => {
  const translation = UNIDA.replaceAll("authorGender", "readerGender");
  expect(messages(feed(JOINED, translation, "es"))).toStrictEqual([
    "Placeholder {company} is missing.",
    "The {readerGender, select} block isn't in the English.",
    "The English has 0 line breaks inside; the translation has 4.",
    "The English ends with an exclamation mark; the translation doesn't.",
  ]);
});

test("checks, arguments: without the declaration, an added select is refused as before", () => {
  expect(messages(text(JOINED, UNIDA, { language: "es", syntax: ICU }))).toStrictEqual([
    "Placeholder {company} is missing.",
    "The {authorGender, select} block isn't in the English.",
    "The English has 0 line breaks inside; the translation has 4.",
    "The English ends with an exclamation mark; the translation doesn't.",
  ]);
});

test("checks, arguments: two arguments vary together", () => {
  const translation = `{authorGender, select,
  female {{readerGender, select, female {A {reader} le gustó.} other {A {reader} le gustó.}}}
  other {{readerGender, select, female {A {reader} le gustó.} other {Le gustó.}}}
}`;
  const declared = [...AUTHOR, { name: "readerGender", cases: ["female"] }];
  const options = { language: "es", syntax: ICU, arguments: declared };
  expect(messages(text("{reader} liked it.", translation, options))).toStrictEqual([
    "Placeholder {reader} is missing in the male case of {authorGender, select} and the other case of {readerGender, select}.",
    "Placeholder {reader} is missing in the other case of {authorGender, select} and the other case of {readerGender, select}.",
  ]);
});

test("checks, arguments: a plural form's select is checked in that form", () => {
  const source = { one: "{count} person follows you", other: "{count} people follow you" };
  const translation = {
    one: "Te sigue {count} persona",
    many: "Te siguen {count} personas",
    other: "{authorGender, select, female {Te siguen {count} personas} other {Te siguen}}",
  };
  const options = { syntax: ICU, arguments: AUTHOR };
  expect(messages(plural("es", source, translation, options))).toStrictEqual([
    "Placeholder {count} is missing in the male case of {authorGender, select} (other form).",
    "Placeholder {count} is missing in the other case of {authorGender, select} (other form).",
  ]);
});
