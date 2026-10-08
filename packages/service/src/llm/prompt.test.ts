// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { DEFAULT_SYNTAX, PROMPT_PLACEHOLDERS } from "@quaso/core";
import { DEFAULT_PROMPT_TEMPLATE } from "../settings.ts";
import {
  DEFAULT_SYSTEM,
  expectedOutputTokens,
  maskString,
  type PromptContext,
  type PromptString,
  renderPrompt,
  renderTemplate,
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
  assertStringIncludes(rendered.system, "from English (en) into Polish (pl)");
  assertStringIncludes(
    rendered.system,
    `Keep every placeholder listed in a string's "placeholders"`,
  );
  assertFalse(rendered.system.includes("%%"), "notes are never sent");
  assertFalse(rendered.system.includes("---STRINGS---"));
  assertStringIncludes(rendered.prompt, "The strings come from the file common.json.");
  assertFalse(rendered.prompt.includes("---STRINGS---"));
  // Stable parts first: the strings aren't in the system instruction.
  assertFalse(rendered.system.includes('"id":"s12"'));
});

test("prompt: a Polish plural string with its forms and example numbers", () => {
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [COINS], context());
  const [line] = stringLines(rendered.prompt);
  assertEquals(line, {
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
  assertStringIncludes(rendered.system, "one (1); few (2–4, 22–24, 32–34, …)");
  assertEquals(rendered.batch.strings[0].forms, ["one", "few", "many", "other"]);
  assertEquals(rendered.batch.targetLanguage, "pl");
});

test("prompt: references are masked, with what they stand for, within the limit", () => {
  const references = new Map([["$t(common:play)", { english: "Play", translation: "Graj" }]]);
  const rendered = renderPrompt(DEFAULT_PROMPT_TEMPLATE, [AGAIN], context({ references }));
  const [line] = stringLines(rendered.prompt);
  assertEquals(line.english, "⟦1⟧ again");
  assertEquals(line.references, { "⟦1⟧": '"Graj" (English: "Play")' });
  assertEquals(line.description, "The button after a game over");
  // The limit counts the reference as stored: 20 − (15 − 3) = 8 for what the model writes.
  assertEquals(line.maxLength, 8);
  assertEquals(rendered.masked.get("s13")?.references, ["$t(common:play)"]);
  assertEquals(rendered.batch.strings[0].english, "⟦1⟧ again");
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
  assertEquals(masked.english, { one: "⟦2⟧ and ⟦1⟧", other: "⟦1⟧ and ⟦2⟧, {{count}}" });
  assertEquals(masked.references, ["$t(b)", "$t(a)"]);
  assertEquals(masked.forms, ["one", "other"]);
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
  assertStringIncludes(
    rendered.prompt,
    '{"key":"saved","english":"Game saved.","translation":"Gra zapisana."}',
  );
  assertStringIncludes(
    rendered.prompt,
    '{"id":"s12","language":"de","translation":{"one":"{{count}} Münze"},"proofread":true}',
  );
  assertStringIncludes(rendered.prompt, '{"english":"Back","translation":"Wróć"}');
  assertStringIncludes(rendered.prompt, "About this file:\nThe game's shared words.");
  assert(rendered.prompt.endsWith("Use the informal you."), rendered.prompt);
  assertStringIncludes(
    rendered.system,
    "Instructions for the project:\nKeep the name Quaso Quest.",
  );
  assertStringIncludes(
    rendered.system,
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
    assertFalse(all.includes(heading), heading);
  }
  assertFalse(all.includes("%"), all);
  assertFalse(/\n\n\n/.test(all), "no empty paragraphs");
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
  assertEquals(line.outdatedTranslation, "⟦1⟧ jeszcze");
  assertEquals(line.refused, {
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
  assertEquals(
    renderTemplate(
      "%% a note\nFile %fileName%, %fileName%.\n\n%customInstruction%\n\n%strings% 100%",
      values,
    ),
    { system: DEFAULT_SYSTEM, prompt: "File a.json, a.json.\n\nS 100%" },
  );
  // A value is inserted once: a placeholder inside it stays as it is.
  assertEquals(renderTemplate("%projectName%", values).prompt, "%fileName%");
  assertEquals(renderTemplate("Rules\n---STRINGS---\n%strings%", values), {
    system: "Rules",
    prompt: "S",
  });
  // The strings always go, even in a paragraph with an empty placeholder.
  assertEquals(
    renderTemplate("%customInstruction%\nThe strings:\n%strings%", values).prompt,
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
  assertEquals(line.placeholders, ["{companyName}", "{{count}}"]);
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
  assertEquals(stringLines(polish.prompt)[0].optionalPlaceholders, ["{article}"]);
  const german = renderPrompt(
    DEFAULT_PROMPT_TEMPLATE,
    [seeking],
    context({ syntax, targetLanguage: "de" }),
  );
  assertEquals(stringLines(german.prompt)[0].optionalPlaceholders, undefined);
});
