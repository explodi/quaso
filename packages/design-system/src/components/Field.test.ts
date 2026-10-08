// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertMatch } from "@std/assert";
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

  assertMatch(html, /<label[^>]*for="email"/);
  assertMatch(html, /<input[^>]*id="email"/);
  assertMatch(html, /aria-describedby="account-help privacy-help email-hint email-error"/);
  assertMatch(html, /aria-invalid="true"/);
  assertMatch(html, /<p id="email-hint"[^>]*>Use your work address\.<\/p>/);
  assertMatch(html, /<p id="email-error"[^>]*>Enter a valid email\.<\/p>/);
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

  assertMatch(html, /<label[^>]*for="word"/);
  assertMatch(html, /<input[^>]*id="word"/);
  assertMatch(html, /aria-describedby="spelling-help"/);
  assertMatch(html, /aria-invalid="spelling"/);
});
