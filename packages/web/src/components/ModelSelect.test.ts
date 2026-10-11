// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertMatch } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSelect } from "./ModelSelect.tsx";

const MODELS = ["gemini-3.8-flash", "gemini-flash-latest"];
const noop = () => {};

function render(props: { models?: string[]; value: string; blankLabel?: string }): string {
  return renderToStaticMarkup(
    createElement(ModelSelect, { models: MODELS, onChange: noop, ...props }),
  );
}

test("the provider's models are a drop-down, with the saved one selected", () => {
  const html = render({ value: "gemini-flash-latest" });
  assertMatch(html, /^<select/);
  assertMatch(html, /<option value="gemini-3\.8-flash">gemini-3\.8-flash<\/option>/);
  assertMatch(
    html,
    /<option value="gemini-flash-latest" selected="">gemini-flash-latest<\/option>/,
  );
});

test("a saved model the provider doesn't list stays in the drop-down", () => {
  const html = render({ value: "gemini-retired" });
  assertMatch(html, /<option value="gemini-retired" selected="">gemini-retired<\/option>/);
});

test("a model that may follow another has a blank choice, first", () => {
  const html = render({ value: "", blankLabel: "The project model" });
  assertMatch(
    html,
    /<option value="" selected="">The project model<\/option><option value="gemini-3\.8-flash">/,
  );
});

test("without a blank choice, no option stands for no model", () => {
  assertEquals(render({ value: "gemini-flash-latest" }).includes('value=""'), false);
});

test("without a list, the name is typed", () => {
  const html = render({ models: [], value: "gemini-flash-latest" });
  assertMatch(html, /^<input/);
  assertMatch(html, /value="gemini-flash-latest"/);
});

test("without a list, a blank choice becomes the placeholder", () => {
  const html = render({ models: [], value: "", blankLabel: "The project model" });
  assertMatch(html, /placeholder="The project model"/);
});

test("the control keeps the labelling its field gives it, as a drop-down and as text", () => {
  const labelled = { "aria-labelledby": "model-label", "aria-invalid": true };
  const dropDown = renderToStaticMarkup(
    createElement(ModelSelect, { models: MODELS, value: "", onChange: noop, ...labelled }),
  );
  const text = renderToStaticMarkup(
    createElement(ModelSelect, { models: [], value: "", onChange: noop, ...labelled }),
  );
  assertMatch(dropDown, /aria-labelledby="model-label"/);
  assertMatch(dropDown, /aria-invalid="true"/);
  assertMatch(text, /aria-labelledby="model-label"/);
  assertMatch(text, /aria-invalid="true"/);
});
