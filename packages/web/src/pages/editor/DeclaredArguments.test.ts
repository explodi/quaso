// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { type IcuField, icuFieldForm, writeIcuFieldForm } from "@quaso/core";
import { explainedArguments, selectBlock, varyFieldSelection } from "./DeclaredArguments.tsx";

const AUTHOR_GENDER = {
  name: "authorGender",
  cases: ["female", "male"],
  description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
};

const PLAYER = {
  name: "player",
  cases: ["she", "he"],
  description: "The player's pronouns. other: they/them, or not chosen.",
  projectWide: true as const,
};

test("the note explains an argument declared for the string's file or key", () => {
  expect(explainedArguments([AUTHOR_GENDER], ["Excited to join {company}!", ""])).toStrictEqual([
    AUTHOR_GENDER,
  ]);
});

test("the note leaves out a project-wide argument the string doesn't use", () => {
  expect(explainedArguments([PLAYER], ["Carry 1,000 riders in one day", ""])).toStrictEqual([]);
});

test("the note explains a project-wide argument the source selects on", () => {
  const source = "{player, select, she {She has} he {He has} other {They have}} won.";
  expect(explainedArguments([PLAYER], [source, ""])).toStrictEqual([PLAYER]);
});

test("the note explains a project-wide argument the translation selects on", () => {
  const translation =
    "{player, select, she {Bienvenida} he {Bienvenido} other {Te damos la bienvenida}}";
  expect(explainedArguments([PLAYER], ["Welcome", translation])).toStrictEqual([PLAYER]);
});

test("the note explains a project-wide argument one plural form selects on", () => {
  const forms = {
    one: "{player, select, she {Elegida} he {Elegido} other {Con el cargo}} una vez",
    other: "{{count}} veces",
  };
  expect(explainedArguments([PLAYER], [{ one: "Elected once", other: "x" }, forms])).toStrictEqual([
    PLAYER,
  ]);
});

test("Vary by: the selected text goes into every case", () => {
  expect(selectBlock(AUTHOR_GENDER, "¡Emocionada de unirme a {company}!")).toStrictEqual(
    "{authorGender, select, female {¡Emocionada de unirme a {company}!} male {¡Emocionada de unirme a {company}!} other {¡Emocionada de unirme a {company}!}}",
  );
});

test("Vary by: without a selection, the cases are empty", () => {
  expect(selectBlock(AUTHOR_GENDER, "")).toStrictEqual(
    "{authorGender, select, female {} male {} other {}}",
  );
});

const FOLLOWERS = "{count, plural, one {Thanks to # follower!} other {Thanks to # followers!}}";
const SEGUIDORES =
  "{count, plural, one {¡Agradecida con # seguidor!} many {¡Agradecida con # seguidores!} other {¡Agradecida con # seguidores!}}";

test("Vary by in a case field: the field's selection goes into every case, as ICU", () => {
  const form = icuFieldForm(FOLLOWERS, SEGUIDORES, "es")!;
  const write = (field: IcuField, text: string) =>
    writeIcuFieldForm(form, new Map([[field, text]]));
  const one = form.fields[0];
  const selection = { start: 0, end: one.text.length };
  expect(varyFieldSelection(write, one, selection, AUTHOR_GENDER)).toStrictEqual(
    "{count, plural, one {{authorGender, select, female {¡Agradecida con # seguidor!} male {¡Agradecida con # seguidor!} other {¡Agradecida con # seguidor!}}} many {¡Agradecida con # seguidores!} other {¡Agradecida con # seguidores!}}",
  );
});

test("Vary by in a case field: a field's braces stay quoted in every case", () => {
  const english = "{count, plural, one {# post} other {# posts}}";
  const form = icuFieldForm(english, "{count, plural, one {# '{draft}'} many {} other {}}", "es")!;
  const write = (field: IcuField, text: string) =>
    writeIcuFieldForm(form, new Map([[field, text]]));
  expect(
    varyFieldSelection(write, form.fields[0], { start: 2, end: 9 }, AUTHOR_GENDER),
  ).toStrictEqual(
    "{count, plural, one {# {authorGender, select, female {'{draft}'} male {'{draft}'} other {'{draft}'}}} many {} other {}}",
  );
});
