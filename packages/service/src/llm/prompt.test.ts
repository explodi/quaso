// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { DEFAULT_SYNTAX, PROMPT_PLACEHOLDERS } from "@quaso/core";
import { DEFAULT_PROMPT_TEMPLATE } from "../settings.ts";
import {
  argumentRules,
  DEFAULT_SYSTEM,
  expectedOutputTokens,
  ICU_RULES,
  maskString,
  type PromptContext,
  type PromptString,
  renderPrompt,
  renderTemplate,
  RESPONSE_SCHEMA,
  responseSchemaFor,
} from "./prompt.ts";

function context(extra: Partial<PromptContext> = {}): PromptContext {
  return {
    sourceLanguage: "en",
    targetLanguage: "pl",
    syntax: DEFAULT_SYNTAX,
    projectName: "Quaso Quest",
    projectDescription: "A cozy puzzle adventure with a little lantern.",
    projectInstructions: "",
    languageInstructions: "",
    fileName: "common.json",
    fileContext: "",
    otherLanguages: [],
    identicalStrings: [],
    neighbours: [],
    references: new Map(),
    glossary: "",
    customInstruction: "",
    ...extra,
  };
}

const COINS: PromptString = {
  id: 12,
  key: "coins",
  kind: "plural",
  english: { one: "{{count}} coin", other: "{{count}} coins" },
  description: "",
  maxLength: null,
};

const AGAIN: PromptString = {
  id: 13,
  key: "main.playAgain",
  kind: "text",
  english: "$t(common:play) again",
  description: "The button after a game over",
  maxLength: 20,
};

/** The lines of `%strings%`, parsed. */
function stringLines(prompt: string): Record<string, unknown>[] {
  return prompt
    .split("\n")
    .filter((line) => line.startsWith('{"id":"s'))
    .map((line) => JSON.parse(line));
}

test("prompt: the default template uses every placeholder and splits at the marker", () => {
  for (const placeholder of PROMPT_PLACEHOLDERS) {
    assert(DEFAULT_PROMPT_TEMPLATE.includes(placeholder), placeholder);
  }
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [COINS], context());
  expect(rendered.system).toContain("from English (en) into Polish (pl)");
  expect(rendered.system).toContain(`Keep every placeholder listed in a string's "placeholders"`);
  expect(rendered.system.includes("%%"), "notes are never sent").toBeFalsy();
  expect(rendered.system.includes("---STRINGS---")).toBeFalsy();
  expect(rendered.prompt).toContain("The strings come from the file common.json.");
  expect(rendered.prompt.includes("---STRINGS---")).toBeFalsy();
  // Stable parts first: the strings aren't in the system instruction.
  expect(rendered.system.includes('"id":"s12"')).toBeFalsy();
});

test("prompt: a Polish plural string with its forms and example numbers", () => {
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [COINS], context());
  const [line] = stringLines(rendered.prompt);
  expect(line).toStrictEqual({
    id: "s12",
    key: "coins",
    english: { one: "{{count}} coin", other: "{{count}} coins" },
    forms: {
      one: "1",
      few: "2–4, 22–24, 32–34, …",
      many: "0, 5–21, 25–31, …",
      other: "1.5",
    },
    placeholders: ["{{count}}"],
  });
  expect(rendered.system).toContain("one (1); few (2–4, 22–24, 32–34, …)");
  expect(rendered.batch.strings[0].forms).toStrictEqual(["one", "few", "many", "other"]);
  expect(rendered.batch.targetLanguage).toBe("pl");
});

test("prompt: references are masked, with what they stand for, within the limit", () => {
  const references = new Map([["$t(common:play)", { english: "Play", translation: "Graj" }]]);
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [AGAIN], context({ references }));
  const [line] = stringLines(rendered.prompt);
  expect(line.english).toBe("⟦1⟧ again");
  expect(line.references).toStrictEqual({ "⟦1⟧": '"Graj" (English: "Play")' });
  expect(line.description).toBe("The button after a game over");
  // The limit counts the reference as stored: 20 − (15 − 3) = 8 for what the model writes.
  expect(line.maxLength).toBe(8);
  expect(rendered.masked.get("s13")?.references).toStrictEqual(["$t(common:play)"]);
  expect(rendered.batch.strings[0].english).toBe("⟦1⟧ again");
});

test("prompt: plural forms share one numbering of references", () => {
  const masked = maskString(
    {
      kind: "plural",
      english: { one: "$t(a) and $t(b)", other: "$t(b) and $t(a), {{count}}" },
      maxLength: null,
    },
    "de",
    DEFAULT_SYNTAX,
  );
  expect(masked.english).toStrictEqual({ one: "⟦2⟧ and ⟦1⟧", other: "⟦1⟧ and ⟦2⟧, {{count}}" });
  expect(masked.references).toStrictEqual(["$t(b)", "$t(a)"]);
  expect(masked.forms).toStrictEqual(["one", "other"]);
});

test("prompt: neighbours, other languages, identical strings and the custom instruction", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [COINS],
    context({
      neighbours: [{ key: "saved", english: "Game saved.", translation: "Gra zapisana." }],
      otherLanguages: [
        {
          id: 12,
          language: "de",
          value: { one: "{{count}} Münze" },
          proofread: true,
        },
      ],
      identicalStrings: [{ english: "Back", translation: "Wróć" }],
      fileContext: "The game's shared words.",
      customInstruction: "Use the informal you.",
      projectInstructions: "Keep the name Quaso Quest.",
      languageInstructions: "Address the player informally.",
    }),
  );
  expect(rendered.prompt).toContain(
    '{"key":"saved","english":"Game saved.","translation":"Gra zapisana."}',
  );
  expect(rendered.prompt).toContain(
    '{"id":"s12","language":"de","translation":{"one":"{{count}} Münze"},"proofread":true}',
  );
  expect(rendered.prompt).toContain('{"english":"Back","translation":"Wróć"}');
  expect(rendered.prompt).toContain("About this file:\nThe game's shared words.");
  assert(rendered.prompt.endsWith("Use the informal you."), rendered.prompt);
  expect(rendered.system).toContain("Instructions for the project:\nKeep the name Quaso Quest.");
  expect(rendered.system).toContain(
    "Instructions for Polish (pl):\nAddress the player informally.",
  );
});

test("prompt: empty optional sections vanish, headings and all", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [COINS],
    context({ projectDescription: "" }),
  );
  const all = `${rendered.system}\n${rendered.prompt}`;
  for (const heading of [
    "About Quaso Quest",
    "Instructions for the project",
    "Instructions for Polish",
    "About this file",
    "Glossary",
    "other languages",
    "elsewhere in the project",
    "The strings around them",
    "An instruction for this run",
  ]) {
    expect(all.includes(heading), heading).toBeFalsy();
  }
  expect(all.includes("%"), all).toBeFalsy();
  expect(/\n\n\n/.test(all), "no empty paragraphs").toBeFalsy();
});

test("prompt: outdated translations and refused answers are shown, masked", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [
      {
        ...AGAIN,
        outdated: "$t(common:play) jeszcze",
        refused: { answer: "⟦1⟧ ponownie!!", reasons: ["At most 8 characters; this has 14."] },
      },
    ],
    context(),
  );
  const [line] = stringLines(rendered.prompt);
  expect(line.outdatedTranslation).toBe("⟦1⟧ jeszcze");
  expect(line.refused).toStrictEqual({
    answer: "⟦1⟧ ponownie!!",
    reasons: ["At most 8 characters; this has 14."],
  });
});

test("prompt: templates without the marker, notes, unknown and repeated placeholders", () => {
  const values = {
    strings: "S",
    fileName: "a.json",
    customInstruction: "",
    projectName: "%fileName%",
  };
  expect(
    renderTemplate(
      "%% a note\nFile %fileName%, %fileName%.\n\n%customInstruction%\n\n%strings% 100%",
      values,
    ),
  ).toStrictEqual({ system: DEFAULT_SYSTEM, prompt: "File a.json, a.json.\n\nS 100%" });
  // A value is inserted once: a placeholder inside it stays as it is.
  expect(renderTemplate("%projectName%", values).prompt).toBe("%fileName%");
  expect(renderTemplate("Rules\n---STRINGS---\n%strings%", values)).toStrictEqual({
    system: "Rules",
    prompt: "S",
  });
  // The strings always go, even in a paragraph with an empty placeholder.
  expect(renderTemplate("%customInstruction%\nThe strings:\n%strings%", values).prompt).toBe(
    "The strings:\nS",
  );
});

test("prompt: the output estimate grows with the forms", () => {
  const text = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [AGAIN], context());
  const plural = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [COINS], context());
  assert(expectedOutputTokens(text) > 0);
  assert(expectedOutputTokens(plural) > expectedOutputTokens(text));
});

test("prompt: a string lists the app's own placeholders beside i18next's", () => {
  const syntax = { prefix: "{{", suffix: "}}", extra: [{ prefix: "{", suffix: "}" }] };
  const hiring: PromptString = {
    id: 14,
    key: "jobs.title",
    kind: "text",
    english: "{companyName} has {{count}} jobs at {companyName}",
    description: "",
    maxLength: null,
  };
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [hiring], context({ syntax }));
  const [line] = stringLines(rendered.prompt);
  expect(line.placeholders).toStrictEqual(["{companyName}", "{{count}}"]);
});

test("prompt: a string lists the placeholders the target language may leave out", () => {
  const syntax = {
    prefix: "{{",
    suffix: "}}",
    extra: [{ prefix: "{", suffix: "}" }],
    optional: [{ placeholder: "{article}", languages: ["pl"] }],
  };
  const seeking: PromptString = {
    id: 15,
    key: "jobs.seeking",
    kind: "text",
    english: "Looking for work as {article} {profession}",
    description: "",
    maxLength: null,
  };
  const polish = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [seeking], context({ syntax }));
  expect(stringLines(polish.prompt)[0].optionalPlaceholders).toStrictEqual(["{article}"]);
  const german = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [seeking],
    context({ syntax, targetLanguage: "de" }),
  );
  expect(stringLines(german.prompt)[0].optionalPlaceholders).toBe(undefined);
});

/** The `required` of the answer's `forms`, for a batch's strings. */
function requiredForms(strings: Parameters<typeof responseSchemaFor>[0]): unknown {
  const schema = responseSchemaFor(strings) as {
    properties: { translations: { items: { properties: { forms: { required?: unknown } } } } };
  };
  return schema.properties.translations.items.properties.forms.required;
}

test("prompt: the answer's schema requires the plural forms every plural string needs", () => {
  const cardinal = { id: "s1", kind: "plural" as const, english: { one: "a", other: "b" } };
  const ordinal = { id: "s2", kind: "ordinal" as const, english: { one: "a", other: "b" } };
  const text = { id: "s3", kind: "text" as const, english: "c" };
  expect(requiredForms([{ ...cardinal, forms: ["one", "many", "other"] }, text])).toStrictEqual([
    "one",
    "many",
    "other",
  ]);
  expect(
    requiredForms([
      { ...cardinal, forms: ["one", "many", "other"] },
      { ...ordinal, forms: ["one", "other"] },
    ]),
  ).toStrictEqual(["one", "other"]);
  expect(responseSchemaFor([text])).toStrictEqual(RESPONSE_SCHEMA);
});

test("prompt: ICU projects get the ICU rules; others don't", () => {
  const icu = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [COINS],
    context({ syntax: { ...DEFAULT_SYNTAX, icu: true } }),
  );
  expect(icu.system).toContain(ICU_RULES);
  const plain = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [COINS], context());
  expect(plain.system.includes(ICU_RULES)).toBeFalsy();
});

const ICU_SYNTAX = { ...DEFAULT_SYNTAX, icu: true };

const JOINED: PromptString = {
  id: 14,
  key: "posts.joined",
  kind: "text",
  english: "Excited to join {company}!",
  description: "",
  maxLength: null,
  arguments: [
    {
      name: "authorGender",
      cases: ["female", "male"],
      description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
    },
  ],
};

test("prompt: a string's line lists its arguments, with the other case", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [JOINED],
    context({ targetLanguage: "es", syntax: ICU_SYNTAX }),
  );
  expect(stringLines(rendered.prompt)[0].arguments).toStrictEqual([
    {
      name: "authorGender",
      cases: ["female", "male", "other"],
      description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
    },
  ]);
});

test("prompt: a batch with arguments gets the rules for them", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [JOINED],
    context({ targetLanguage: "es", syntax: ICU_SYNTAX }),
  );
  expect(rendered.system).toContain(argumentRules("es"));
});

test("prompt: a batch without arguments doesn't get their rules", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [COINS],
    context({ targetLanguage: "es", syntax: ICU_SYNTAX }),
  );
  expect(rendered.system.includes(argumentRules("es"))).toBeFalsy();
});

test("prompt: without ICU MessageFormat, arguments are neither listed nor explained", () => {
  const rendered = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [JOINED],
    context({ targetLanguage: "es" }),
  );
  expect(stringLines(rendered.prompt)[0].arguments).toBe(undefined);
  expect(rendered.system.includes(argumentRules("es"))).toBeFalsy();
});
