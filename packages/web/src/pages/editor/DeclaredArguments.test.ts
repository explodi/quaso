// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { selectBlock } from "./DeclaredArguments.tsx";

const AUTHOR_GENDER = {
  name: "authorGender",
  cases: ["female", "male"],
  description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
};

test("Vary by: the selected text goes into every case", () => {
  assertEquals(
    selectBlock(AUTHOR_GENDER, "¡Emocionada de unirme a {company}!"),
    "{authorGender, select, female {¡Emocionada de unirme a {company}!} male {¡Emocionada de unirme a {company}!} other {¡Emocionada de unirme a {company}!}}",
  );
});

test("Vary by: without a selection, the cases are empty", () => {
  assertEquals(
    selectBlock(AUTHOR_GENDER, ""),
    "{authorGender, select, female {} male {} other {}}",
  );
});
