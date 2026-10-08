// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  type CheckInput,
  type CheckResult,
  CHECKS,
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
  assertEquals(plural("pl", COINS, POLISH), []);
  for (const form of ["few", "many", "other"] as const) {
    const results = plural("pl", COINS, { ...POLISH, [form]: "Kilka monet" });
    assertEquals(results, [
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
  assertEquals(plural("pl", COINS, { ...POLISH, one: "Jedna moneta" }), []);
});

test("acceptance test 9: Russian one covers 1, 21, 31, …, so it keeps {{count}}", () => {
  assertEquals(plural("ru", COINS, RUSSIAN), []);
  assertEquals(plural("ru", COINS, { ...RUSSIAN, one: "Одна монета" }), [
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
  assertEquals(results, [
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{count}} is missing.",
      value: "{{count}}",
    },
  ]);
  assert(hasErrors(results));
  assertEquals(text("You have {{count}} coins", "Du hast {{count}} Münzen"), []);
});

test("{{count}}: only categories that cover exactly one number may leave it out", () => {
  // French one covers 0, 1 and 1.5; Japanese other covers every number.
  const french = { one: "Une pièce", many: "{{count}} pièces", other: "{{count}} pièces" };
  assertEquals(summary(plural("fr", COINS, french)), ["placeholder_missing:one"]);
  assertEquals(summary(plural("ja", COINS, { other: "コイン" })), ["placeholder_missing:other"]);
  // English one covers only 1 (1.5 is other).
  assertEquals(plural("en-GB", COINS, { one: "One coin", other: "{{count}} coins!" }), []);
  // Arabic zero, one and two cover one number each; few, many and other don't.
  const arabic = {
    zero: "لا عملات",
    one: "عملة واحدة",
    two: "عملتان",
    few: "{{count}} عملات",
    many: "{{count}} عملة",
    other: "{{count}} عملة",
  };
  assertEquals(plural("ar", COINS, arabic), []);
  assertEquals(summary(plural("ar", COINS, { ...arabic, few: "عملات" })), [
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
  assertEquals(plural("cy", COINS, welsh), []);
  assertEquals(summary(plural("cy", COINS, { ...welsh, other: "Darnau" })), [
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
  assertEquals(plural("pl", formatted, polish), []);
  const unescaped = { one: "{{- count}} coin", other: "{{- count}} coins" };
  assertEquals(plural("pl", unescaped, { ...polish, few: "{{- count}} monety" }), [
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
  assertEquals(messages(results), ["Placeholder {{name}} is missing from the one form."]);
  // A placeholder called Count is not count.
  const capital = { one: "{{Count}} coin", other: "{{Count}} coins" };
  const withoutCapital = {
    one: "Jedna moneta",
    few: "{{Count}}",
    many: "{{Count}}",
    other: "{{Count}}",
  };
  assertEquals(summary(plural("pl", capital, withoutCapital)), ["placeholder_missing:one"]);
});

test("invalid_value: forms for a text string and text for a plural", () => {
  assertEquals(text("Play", { other: "Spielen" }), [
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
  assertEquals(plural("pl", COINS, "{{count}} monet"), expected);
  assertEquals(ordinal("en", COINS, "{{count}}th"), expected);
  assertEquals(plural("pl", COINS, null as unknown as TextValue), expected);
  assertEquals(plural("pl", COINS, ["{{count}}"] as unknown as TextValue), expected);
});

test("invalid_value: a form that isn't text", () => {
  const forms = { ...POLISH, few: 3 } as unknown as PluralForms;
  assertEquals(plural("pl", COINS, forms), [
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
    assertEquals(text("Play", empty), expected, JSON.stringify(empty));
  }
  assertEquals(text("Play", "\u200b"), [], "a zero-width space isn't white space");
});

test("empty: an empty value is reported once, without other checks", () => {
  const english = "{{count}} coins, $t(common:back), 3 left";
  assertEquals(summary(text(english, "  ", { maxLength: 1 })), ["empty"]);
  assertEquals(plural("pl", COINS, { ...POLISH, many: " \r\n" }), [
    {
      check: "empty",
      severity: "error",
      message: "The many form is empty.",
      form: "many",
    },
  ]);
});

test("placeholder_missing: missing, or appearing less often", () => {
  assertEquals(text("{{current}}/{{total}}", "{{current}}"), [
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{total}} is missing.",
      value: "{{total}}",
    },
  ]);
  assertEquals(text("{{a}} and {{a}}", "{{a}} und"), [
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder {{a}} appears less often than in the English.",
      value: "{{a}}",
    },
  ]);
  assertEquals(
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
    ["Placeholder {{a}} appears less often than in the English (few form)."],
  );
});

test("placeholder_missing: one result per placeholder, in the English order", () => {
  const results = text("{{b}} {{a}} {{b}} {{c}}", "Nichts");
  assertEquals(
    results.map((result) => result.value),
    ["{{b}}", "{{a}}", "{{c}}"],
  );
});

test("placeholder_extra: not in the English, or more often", () => {
  assertEquals(text("Hello {{name}}", "Hallo {{name}} {{user}}"), [
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{user}} isn't in the English.",
      value: "{{user}}",
    },
  ]);
  assertEquals(text("Hello {{name}}", "Hallo {{name}}, {{name}}"), [
    {
      check: "placeholder_extra",
      severity: "error",
      message: "Placeholder {{name}} appears more often than in the English.",
      value: "{{name}}",
    },
  ]);
  const results = text("Hi", "{{z}} {{y}} {{z}} {{x}}");
  assertEquals(
    results.map((result) => result.value),
    ["{{z}}", "{{y}}", "{{x}}"],
  );
});

test("placeholders: compared by placeholderKey", () => {
  assertEquals(text("{{count}} coins", "{{ count }} Münzen"), []);
  assertEquals(text("{{ count , number }}", "{{count, number}} Stück"), []);
  assertEquals(text("{{-html}} ok", "{{- html}} gut"), []);
  assertEquals(text("{{date, datetime}}", "Am {{date}}"), [
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
  assertEquals(summary(text("{{- html}}", "{{html}}")), [
    "placeholder_missing",
    "placeholder_extra",
  ]);
  assertEquals(summary(text("{{name}}", "{{Name}}")), ["placeholder_missing", "placeholder_extra"]);
});

test("placeholders: text that only looks like a placeholder is text", () => {
  assertEquals(text("{{ }} and {{, x}} and {{open", "und"), []);
  assertEquals(text("Braces {{ like this", "Klammern"), []);
  assertEquals(text("Broken {{\nname}}", "Kaputt"), []);
});

test("placeholders: those i18next doesn't fill in don't count as the English ones", () => {
  // Regression: "{{ - html }}" was taken for "{{- html}}", which i18next doesn't unescape.
  for (const translation of ["Hallo {{ - html }}!", "Hallo {{ -html}}!"]) {
    assertEquals(summary(text("Hi {{- html}}!", translation)), [
      "placeholder_missing",
      "placeholder_extra",
    ]);
  }
  assertEquals(text("Hi {{- html}}!", "Hallo {{-html}}!"), []);
  // Regression: after an empty {{}}, i18next reads "{{}} {{count}}" as one placeholder.
  assertEquals(text("You have {{count}} coins", "Du hast {{}} {{count}} Münzen"), [
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
    assertEquals(summary(text("You have {{count}} coins", translation)), ["placeholder_missing"]);
  }
});

test("placeholders: formats compare as i18next reads them", () => {
  // Regression: format names are case-insensitive and options are trimmed in i18next.
  assertEquals(text("Total: {{val, number}}", "Summe: {{val, Number}}"), []);
  assertEquals(
    text(
      "{{val, number(minimumFractionDigits: 2)}} left",
      "{{val, number(minimumFractionDigits:2)}} übrig",
    ),
    [],
  );
  assertEquals(text("{{val, number, uppercase}} left", "{{val, number,uppercase}} übrig"), []);
  // Messages show the normalized placeholder.
  assertEquals(messages(text("{{val, number}} left", "{{val, Currency( EUR )}} übrig")), [
    "Placeholder {{val, number}} is missing.",
    "Placeholder {{val, currency(EUR)}} isn't in the English.",
  ]);
});

test("placeholders: those in a reference's options belong to the reference", () => {
  const english = 'You have $t(coins, {"count": {{n}}})';
  assertEquals(text(english, 'Du hast $t(coins, {"count": {{n}}})'), []);
  assertEquals(text(english, "Du hast {{n}}"), [
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
  assertEquals(
    plural("pl", english, {
      one: "{{name}} ma jedną monetę",
      few: "{{name}} ma {{count}} monety",
      many: "{{count}} monet",
      other: "{{count}} monety",
    }),
    [],
  );
  assertEquals(
    plural("pl", english, {
      one: "Jedna",
      few: "{{count}} {{count}}",
      many: "{{count}} {{name}} {{name}}",
      other: "{{count}} {{total}}",
    }),
    [
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
    ],
  );
});

test("placeholders: Unicode names, emoji and surrogate pairs", () => {
  assertEquals(text("Hello {{名前}}", "こんにちは{{名前}}さん"), []);
  assertEquals(text("{{😀}} 👍", "👍{{😀}}👍"), []);
  assertEquals(messages(text("{{😀}} 👍", "👍")), ["Placeholder {{😀}} is missing."]);
  // A placeholder name in NFD is a different variable from the same name in NFC.
  assertEquals(summary(text("{{café}}", "{{cafe\u0301}}")), [
    "placeholder_missing",
    "placeholder_extra",
  ]);
});

test("custom interpolation syntax", () => {
  const syntax = { prefix: "__", suffix: "__" };
  assertEquals(text("You have __count__ coins", "Du hast __count__ Münzen", { syntax }), []);
  assertEquals(text("You have __count__ coins", "Du hast Münzen", { syntax }), [
    {
      check: "placeholder_missing",
      severity: "error",
      message: "Placeholder __count__ is missing.",
      value: "{{count}}",
    },
  ]);
  // {{count}} is plain text in this syntax.
  assertEquals(text("{{count}} coins", "Münzen", { syntax }), []);
  assertEquals(text("__ count __ coins", "__count__ Münzen", { syntax }), []);

  const icu = { prefix: "{", suffix: "}" };
  assertEquals(messages(text("Hi {name}", "Hallo {name} {- extra, uppercase}", { syntax: icu })), [
    "Placeholder {- extra, uppercase} isn't in the English.",
  ]);
  assertEquals(
    text("Hi {name}", "Hallo {name} {- extra}", { syntax: icu })[0].value,
    "{{- extra}}",
  );

  const english = { one: "%{count} coin", other: "%{count} coins" };
  const percent = { syntax: { prefix: "%{", suffix: "}" } };
  const polish = { one: "Jedna moneta", few: "monety", many: "%{count} monet", other: "%{count}" };
  assertEquals(plural("pl", english, polish, percent), [
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
  assertEquals(text("$t(common:back) to the menu", "Zum Menü"), [
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(common:back) is missing.",
      value: "$t(common:back)",
    },
  ]);
  assertEquals(text("$t(a) or $t(a)", "$t(a)"), [
    {
      check: "reference_missing",
      severity: "error",
      message: "Reference $t(a) appears less often than in the English.",
      value: "$t(a)",
    },
  ]);
  // References may move.
  assertEquals(text("$t(a) then $t(b)", "$t(b), dann $t(a)"), []);
});

test("reference_extra: changed or repeated", () => {
  assertEquals(text("Press $t(keys.jump)", "Drücke $t(keys.run)"), [
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
  assertEquals(text("Press $t(a)", "$t(a) $t(a)"), [
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference $t(a) isn't in the English, or is repeated.",
      value: "$t(a)",
    },
  ]);
});

test("references: compared by their raw text", () => {
  assertEquals(summary(text("$t(a)", "$t( a )")), ["reference_missing", "reference_extra"]);
  const english = '$t(coins, {"count": {{n}}})';
  assertEquals(summary(text(english, '$t(coins, { "count": {{n}} })')), [
    "reference_missing",
    "reference_extra",
  ]);
  assertEquals(summary(text("$t(ns:key)", "$t(key)")), ["reference_missing", "reference_extra"]);
  // `$t(` without its `)` is text.
  assertEquals(text("Costs $t(", "Kostet"), []);
});

test("references: masked references left in the translation are extra", () => {
  assertEquals(text("Press $t(a)", "Drücke $t(a) ⟦2⟧"), [
    {
      check: "reference_extra",
      severity: "error",
      message: "Reference ⟦2⟧ isn't in the English, or is repeated.",
      value: "⟦2⟧",
    },
  ]);
  // A translation that was never unmasked.
  assertEquals(summary(text("Press $t(a)", "Drücke ⟦1⟧")), [
    "reference_missing",
    "reference_extra",
  ]);
  // Brackets without a number are text, and an English that has the text keeps it.
  assertEquals(text("Press ⟦x⟧", "Drücke ⟦x⟧"), []);
  assertEquals(text("Slot ⟦1⟧", "Platz ⟦1⟧"), []);
});

test("references: an LLM result, unmasked, then checked", () => {
  const english = "$t(common:back) or $t(common:next), then {{count}} more";
  const { text: masked, references } = maskReferences(english);
  assertEquals(masked, "⟦1⟧ or ⟦2⟧, then {{count}} more");
  const good = unmaskReferences("⟦2⟧ oder ⟦1⟧, dann {{count}} mehr", references);
  assertEquals(text(english, good), []);
  const repeated = unmaskReferences("⟦1⟧ ⟦1⟧ dann {{count}}", references);
  assertEquals(summary(text(english, repeated)), ["reference_missing", "reference_extra"]);
  const invented = unmaskReferences("⟦1⟧ ⟦2⟧ ⟦3⟧ {{count}} mehr", references);
  assertEquals(
    text(english, invented).map((result) => result.value),
    ["⟦3⟧"],
  );
});

test("references: plural forms are compared with English other", () => {
  const english = { one: "$t(icon) {{count}} coin", other: "$t(icon) {{count}} coins" };
  const polish = {
    one: "$t(icon) Jedna moneta",
    few: "{{count}} monety",
    many: "$t(icon) {{count}} monet",
    other: "$t(icon) $t(icon) {{count}} monety",
  };
  assertEquals(plural("pl", english, polish), [
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
  assertEquals(messages(fewer), [
    "Reference $t(a) appears less often than in the English (many form).",
  ]);
});

test("max_length: grapheme clusters, placeholders and references included", () => {
  assertEquals(text("Play", "Spielen", { maxLength: 4 }), [
    {
      check: "max_length",
      severity: "error",
      message: "At most 4 characters; this has 7.",
      limit: 4,
      length: 7,
    },
  ]);
  assertEquals(text("Play", "Spielen", { maxLength: 7 }), []);
  assertEquals(text("Play", "Spielen", { maxLength: null }), []);
  assertEquals(text("Play", "Spielen", { maxLength: undefined }), []);
  assertEquals(messages(text("Play", "Go", { maxLength: 1 })), [
    "At most 1 character; this has 2.",
  ]);
  assertEquals(messages(text("Play", "Go", { maxLength: 0 })), [
    "At most 0 characters; this has 2.",
  ]);
  // "{{count}} Münzen" is 16 characters; "$t(a) Ja" is 8.
  assertEquals(text("{{count}} coins", "{{count}} Münzen", { maxLength: 16 }), []);
  assertEquals(text("{{count}} coins", "{{count}} Münzen", { maxLength: 15 })[0].length, 16);
  assertEquals(text("$t(a) Yes", "$t(a) Ja", { maxLength: 7 })[0].length, 8);
});

test("max_length: emoji, flags, combining marks and CRLF count as one", () => {
  const cases: [string, number][] = [
    ["👍👍👍", 3], // surrogate pairs
    ["👨\u200d👩\u200d👧\u200d👦", 1], // a ZWJ sequence of 11 code units
    ["🇵🇱🇩🇪", 2], // flags
    ["👋🏽", 1], // a skin tone modifier
    ["e\u0301te\u0301", 3], // combining acute accents
    ["Ha\u0308\u0323", 2], // two combining marks on one letter
    ["One\r\nTwo", 7], // CRLF
    ["One\nTwo", 7],
  ];
  for (const [translation, length] of cases) {
    assertEquals(text("Hello", translation, { maxLength: length }), [], translation);
    assertEquals(
      text("Hello", translation, { maxLength: length - 1 }),
      [
        {
          check: "max_length",
          severity: "error",
          message: `At most ${length - 1} character${length === 2 ? "" : "s"}; this has ${length}.`,
          limit: length - 1,
          length,
        },
      ],
      translation,
    );
  }
});

test("max_length: every form is checked", () => {
  assertEquals(plural("pl", COINS, POLISH, { maxLength: 15 }), [
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
  assertEquals(results, [
    {
      check: "identical",
      severity: "warning",
      message: "Identical to the English.",
    },
  ]);
  assertFalse(hasErrors(results));
  assertEquals(summary(text("OK", "OK")), ["identical"]);
  assertEquals(summary(text("東京", "東京", { language: "ja" })), ["identical"]);
  assertEquals(summary(text("{{name}}: OK", "{{name}}: OK")), ["identical"]);
  assertEquals(text("Options", "Optionen"), []);
  assertEquals(text("Options", "Options "), [], "white space makes a difference");
  assertEquals(text("A\r\nB", "A\nB"), [], "so do line endings");
});

test("identical: skipped when the English has no letters", () => {
  for (const english of ["{{current}}/{{total}}", "$t(a) / $t(b)", "2024", "{{count}} × 2", "…"]) {
    assertEquals(text(english, english), [], english);
  }
});

test("identical: canonically equivalent text is identical", () => {
  assertEquals(summary(text("Café", "Cafe\u0301")), ["identical"]);
  assertEquals(summary(text("Cafe\u0301", "Café")), ["identical"]);
});

test("identical: forms compared with the same category, or other", () => {
  const results = plural("pl", COINS, {
    one: "{{count}} coin",
    few: "{{count}} coins",
    many: "{{count}} coin",
    other: "{{count}} coins",
  });
  assertEquals(results, [
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
  assertEquals(plural("ja", noLetters, { other: "{{count}}" }), []);
});

test("numbers_differ: a warning naming the first number that differs", () => {
  const results = text("3 lives left", "Noch 5 Leben");
  assertEquals(results, [
    {
      check: "numbers_differ",
      severity: "warning",
      message: "The numbers differ from the English.",
      value: "3",
    },
  ]);
  assertFalse(hasErrors(results));
  assertEquals(text("Lives left", "Noch 5 Leben")[0].value, "5");
  assertEquals(text("1 or 1", "1 oder 2")[0].value, "1");
  assertEquals(text("1 or 2", "1, 2 oder 2")[0].value, "2");
  assertEquals(text("Level 12", "Stufe 1 2")[0].value, "12");
});

test("numbers_differ: order doesn't matter, values do", () => {
  assertEquals(text("From 1 to 10", "Von 10 bis 1"), []);
  assertEquals(text("Mission 07", "Mission 7"), []);
  assertEquals(text("Room 0", "Raum 000"), []);
  assertEquals(text("1,000 coins", "1.000 Münzen"), []);
  assertEquals(text("1,000 coins", "1\u202f000 pièces", { language: "fr" }), []);
  assertEquals(text("Version 1.5", "Version 1,5"), []);
  assertEquals(summary(text("1,000 coins", "1000 Münzen")), ["numbers_differ"]);
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
    assertEquals(text("Level 3 of 12", translation, { language }), [], translation);
  }
  // The value is the number as written: the English one that is missing, or the extra one.
  assertEquals(text("Level 3 of 12", "المستوى ٤ من ١٢", { language: "ar" })[0].value, "3");
  assertEquals(text("Level 12", "المستوى ٤ من ١٢", { language: "ar" })[0].value, "٤");
});

test("numbers_differ: agrees with the runtime's digits in every numbering system", () => {
  const systems = Intl.supportedValuesOf("numberingSystem");
  let checked = 0;
  for (const system of systems) {
    const format = new Intl.NumberFormat(`en-u-nu-${system}`, { useGrouping: false });
    if (format.resolvedOptions().numberingSystem !== system) continue;
    const digits = format.format(1234567890);
    if (!/^\p{Nd}+$/u.test(digits)) continue; // Not a decimal system, such as roman.
    assertEquals(text("Number 1234567890", `Zahl ${digits}`), [], system);
    checked++;
  }
  assert(checked >= 20, `${checked} numbering systems`);
});

test("numbers_differ: only text counts, not placeholders or references", () => {
  assertEquals(text("{{item1}} and $t(level2)", "{{item1}} und $t(level2)"), []);
  assertEquals(summary(text("{{count}} coins", "3 Münzen")), [
    "placeholder_missing",
    "numbers_differ",
  ]);
  assertEquals(summary(text("¹ note", "Hinweis")), [], "superscripts aren't decimal digits");
  assertEquals(summary(text("Chapter Ⅳ", "Kapitel 4")), ["numbers_differ"]);
});

test("numbers_differ: forms compared with the same category, or other", () => {
  const english = { one: "1 coin", other: "{{count}} coins" };
  assertEquals(plural("pl", english, { ...POLISH, one: "Jedna moneta" }), [
    {
      check: "numbers_differ",
      severity: "warning",
      message: "The numbers differ from the English (one form).",
      form: "one",
      value: "1",
    },
  ]);
  assertEquals(plural("pl", english, { ...POLISH, one: "1 moneta" }), []);
  assertEquals(
    summary(plural("pl", english, { ...POLISH, one: "1 moneta", few: "{{count}} monety (2)" })),
    ["numbers_differ:few"],
  );
});

test("ordinals: French first may leave out {{count}}; English ordinals may not", () => {
  const english = {
    one: "{{count}}st place",
    two: "{{count}}nd place",
    few: "{{count}}rd place",
    other: "{{count}}th place",
  };
  assertEquals(ordinal("fr", english, { one: "Première place", other: "{{count}}e place" }), []);
  assertEquals(summary(ordinal("fr", english, { one: "{{count}}re place" })), [
    "plural_form_missing:other",
  ]);
  // English ordinal one covers 1, 21, 31, …; two covers 2, 22, 32, ….
  const british = { one: "First", two: "Second", few: "{{count}}rd", other: "{{count}}th" };
  assertEquals(summary(ordinal("en-GB", english, british)), [
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
  assertEquals(ordinal("pl", english, { other: "{{count}}." }), []);
  assertEquals(ordinal("pl", english, { one: "{{count}}.", other: "{{count}}." }), [
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The one form isn't used in Polish.",
      form: "one",
    },
  ]);
  // No zero form for ordinals, even when English has one.
  const withZero = { zero: "Unranked", ...english };
  assertEquals(summary(ordinal("fr", withZero, { one: "1re", other: "{{count}}e" })), [
    "numbers_differ:one",
  ]);
  assertEquals(
    messages(
      ordinal("fr", withZero, { zero: "Non classé", one: "{{count}}re", other: "{{count}}e" }),
    ),
    ["The zero form isn't used in French."],
  );
});

test("plural_form_missing and plural_form_unexpected", () => {
  assertEquals(plural("pl", COINS, { one: "Jedna moneta", other: "{{count}} monety" }), [
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
  assertEquals(plural("ja", COINS, { one: "1枚", other: "{{count}}枚" }), [
    {
      check: "plural_form_unexpected",
      severity: "error",
      message: "The one form isn't used in Japanese.",
      form: "one",
    },
  ]);
  assertEquals(
    messages(
      plural("pt-BR", COINS, {
        one: "{{count}} moeda",
        two: "{{count}} moedas",
        many: "{{count}} de moedas",
        other: "{{count}} moedas",
      }),
    ),
    ["The two form isn't used in Portuguese (Brazil)."],
  );
  assertEquals(summary(plural("pl", COINS, {})), [
    "plural_form_missing:one",
    "plural_form_missing:few",
    "plural_form_missing:many",
    "plural_form_missing:other",
  ]);
});

test("plural forms: undefined is absent, and unknown names are unexpected", () => {
  assertEquals(plural("pl", COINS, { ...POLISH, two: undefined }), []);
  assertEquals(summary(plural("pl", COINS, { ...POLISH, few: undefined })), [
    "plural_form_missing:few",
  ]);
  const unknown = { ...POLISH, plural: "x", few_: "y" } as PluralForms;
  assertEquals(plural("pl", COINS, unknown), [
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
  assertEquals(plural("pl", english, { ...POLISH, one: "Jedna moneta" }), [
    {
      check: "plural_form_missing",
      severity: "error",
      message: "The zero form is missing.",
      form: "zero",
    },
  ]);
  // An added zero form covers only 0, so it may leave out {{count}}.
  assertEquals(plural("pl", english, { zero: "Brak monet", ...POLISH }), []);
  assertEquals(plural("ja", english, { zero: "コインなし", other: "{{count}}枚" }), []);
  // Latvian's own zero covers 0, 10–20, 30, …, so it keeps {{count}}.
  const latvian = { zero: "Nav monētu", one: "{{count}} monēta", other: "{{count}} monētas" };
  assertEquals(summary(plural("lv", english, latvian)), ["placeholder_missing:zero"]);
  // The zero form is compared with the English zero form.
  assertEquals(summary(plural("ja", english, { zero: "No coins", other: "{{count}}枚" })), [
    "identical:zero",
  ]);
  // Without an English zero form, a zero form is unexpected in Polish.
  assertEquals(messages(plural("pl", COINS, { zero: "Brak monet", ...POLISH })), [
    "The zero form isn't used in Polish.",
  ]);
});

test("zero: with a zero form, 0 leaves the other categories", () => {
  // Regression: where CLDR one is 0–1 (pa, ln, ak, mg, ti), one covers only 1 once 0 has
  // a zero form, so it may leave out {{count}}, as Polish one may.
  const english = { zero: "No coins", one: "{{count}} coin", other: "{{count}} coins" };
  for (const language of ["pa", "ln", "ak", "mg", "ti"]) {
    assertEquals(
      plural(language, english, { zero: "ZERO", one: "ONE", other: "{{count}} OTHER" }),
      [],
      language,
    );
    // Without an English zero form, one covers 0 and 1, and keeps {{count}}.
    assertEquals(
      summary(plural(language, COINS, { one: "ONE", other: "{{count}} OTHER" })),
      ["placeholder_missing:one"],
      language,
    );
  }
  // French one still covers 1 and 1.5 without 0.
  assertEquals(
    summary(plural("fr", english, { zero: "Z", one: "UN", many: "{{count}}", other: "{{count}}" })),
    ["placeholder_missing:one"],
  );
});

test("empty: a form may stay empty where the English one is empty", () => {
  // Regression: English "left_zero": "" made every translation fail, empty or not.
  const english = { zero: "", one: "{{count}} left", other: "{{count}} left" };
  const german = { zero: "", one: "{{count}} übrig", other: "{{count}} übrig" };
  assertEquals(plural("de", english, german), []);
  assertEquals(plural("de", english, { ...german, zero: " " }), []);
  assertEquals(plural("de", english, { ...german, zero: "Nichts mehr übrig" }), []);
  assertEquals(summary(plural("de", english, { one: german.one, other: german.other })), [
    "plural_form_missing:zero",
  ]);
  assertEquals(summary(plural("de", english, { ...german, one: "" })), ["empty:one"]);
  // Categories English lacks compare with English other.
  const blankOther = { one: "One left", other: "" };
  assertEquals(plural("pl", blankOther, { one: "Jeden", few: "", many: " ", other: "" }), []);
  // A blank English text allows a blank translation.
  assertEquals(text(" ", ""), []);
  assertEquals(summary(text("Play", "")), ["empty"]);
});

test("pluralOverride replaces the language's categories", () => {
  const pluralOverride = { cardinal: ["one", "few", "other"] as PluralCategory[] };
  const { many: _, ...withoutMany } = POLISH;
  assertEquals(plural("pl", COINS, withoutMany, { pluralOverride }), []);
  assertEquals(summary(plural("pl", COINS, POLISH, { pluralOverride })), [
    "plural_form_unexpected:many",
  ]);
  // An ordinal override leaves cardinal strings alone.
  const ordinalOnly = { ordinal: ["other"] as PluralCategory[] };
  assertEquals(plural("pl", COINS, POLISH, { pluralOverride: ordinalOnly }), []);
  // A category the runtime doesn't have is assumed to cover many numbers.
  const withTwo = { cardinal: ["one", "two", "few", "many", "other"] as PluralCategory[] };
  assertEquals(
    summary(plural("pl", COINS, { ...POLISH, two: "Dwie" }, { pluralOverride: withTwo })),
    ["placeholder_missing:two"],
  );
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
  assertEquals(summary(results), [
    "empty:many",
    "placeholder_extra:few",
    "plural_form_unexpected:two",
    "max_length:few",
    "max_length:other",
    "identical:other",
    "numbers_differ:one",
    "numbers_differ:few",
  ]);
  assertEquals(errorsOf(results).length, 5);
  const textResults = text("{{a}} $t(b) 1 x", "{{c}} $t(d) 2 x {{a}}{{a}}", { maxLength: 3 });
  assertEquals(summary(textResults), [
    "placeholder_extra",
    "placeholder_extra",
    "reference_missing",
    "reference_extra",
    "max_length",
    "numbers_differ",
  ]);
  assertEquals(
    textResults.map((result) => result.value),
    ["{{c}}", "{{a}}", "$t(b)", "$t(d)", undefined, "1"],
  );
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
  ];
  for (const results of all) {
    for (const result of results) {
      assertEquals(result.severity, CHECKS[result.check]);
      seen.add(result.check);
    }
  }
  assertEquals([...seen].sort(), Object.keys(CHECKS).sort());
});

test("results: optional fields are left out, not undefined", () => {
  for (const result of text("{{a}} Play", "{{b}}", { maxLength: 1 })) {
    for (const [field, value] of Object.entries(result)) {
      assert(value !== undefined, `${result.check}.${field}`);
    }
  }
});

test("mismatched English values: forms for text, and text for plurals", () => {
  assertEquals(summary(text(COINS as unknown as string, "Münzen")), ["placeholder_missing"]);
  assertEquals(text(COINS as unknown as string, "{{count}} Münzen"), []);
  assertEquals(plural("pl", "{{count}} coins" as unknown as PluralForms, POLISH), []);
  assertEquals(summary(plural("pl", { one: "{{count}} coin" }, { ...POLISH, few: "x" })), [
    "placeholder_missing:few",
  ]);
});

test("CRLF files: line breaks are text like any other", () => {
  const english = "Line one\r\n{{count}} coins\r\n";
  assertEquals(text(english, "Zeile eins\r\n{{count}} Münzen\r\n"), []);
  assertEquals(summary(text(english, "Zeile eins\r\nMünzen\r\n")), ["placeholder_missing"]);
  assertEquals(summary(text("A\r\nB", "A\r\nB")), ["identical"]);
  assertEquals(text("3\r\n4", "4\r\n3"), []);
});

test("an invalid language tag throws for plural strings", () => {
  assertThrows(() => plural("not a tag", COINS, POLISH), RangeError);
  assertEquals(text("Play", "Spielen", { language: "not a tag" }), []);
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
    assertEquals(summary(plural("be-BY", COINS, { two: "x", zero: "y" })), [
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
  assertEquals(summary(results), ["max_length"]);
  assert(elapsed < 5000, `${elapsed} ms`);

  const forms = { one: english, other: english };
  const polish = { one: translation, few: translation, many: translation, other: translation };
  const again = performance.now();
  assertEquals(plural("pl", forms, polish), []);
  assert(performance.now() - again < 10000);
});
