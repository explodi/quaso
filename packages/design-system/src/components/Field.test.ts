// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./Field.tsx";

test("fields keep external descriptions alongside their own hint and error", () => {
  const html = renderToStaticMarkup(
    createElement(Field, {
      id: "email",
      label: "Email",
      hint: "Use your work address.",
      error: "Enter a valid email.",
      "aria-describedby": "account-help privacy-help",
      "aria-invalid": false,
    }),
  );

  expect(html).toMatch(/<label[^>]*for="email"/);
  expect(html).toMatch(/<input[^>]*id="email"/);
  expect(html).toMatch(/aria-describedby="account-help privacy-help email-hint email-error"/);
  expect(html).toMatch(/aria-invalid="true"/);
  expect(html).toMatch(/<p id="email-hint"[^>]*>Use your work address\.<\/p>/);
  expect(html).toMatch(/<p id="email-error"[^>]*>Enter a valid email\.<\/p>/);
});

test("fields preserve caller validation semantics when they have no error message", () => {
  const html = renderToStaticMarkup(
    createElement(Field, {
      id: "word",
      label: "Word",
      "aria-describedby": "spelling-help",
      "aria-invalid": "spelling",
    }),
  );

  expect(html).toMatch(/<label[^>]*for="word"/);
  expect(html).toMatch(/<input[^>]*id="word"/);
  expect(html).toMatch(/aria-describedby="spelling-help"/);
  expect(html).toMatch(/aria-invalid="spelling"/);
});
