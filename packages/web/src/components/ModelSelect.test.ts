// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(html).toMatch(/^<select/);
  expect(html).toMatch(/<option value="gemini-3\.8-flash">gemini-3\.8-flash<\/option>/);
  expect(html).toMatch(
    /<option value="gemini-flash-latest" selected="">gemini-flash-latest<\/option>/,
  );
});

test("a saved model the provider doesn't list stays in the drop-down", () => {
  const html = render({ value: "gemini-retired" });
  expect(html).toMatch(/<option value="gemini-retired" selected="">gemini-retired<\/option>/);
});

test("a model that may follow another has a blank choice, first", () => {
  const html = render({ value: "", blankLabel: "The project model" });
  expect(html).toMatch(
    /<option value="" selected="">The project model<\/option><optgroup label="Google Gemini">/,
  );
});

test("models from both services are grouped by provider", () => {
  const html = render({
    models: ["claude-sonnet-5-5", "gemini-flash-latest", "custom-model"],
    value: "claude-sonnet-5-5",
  });
  expect(html).toMatch(/<optgroup label="Google Gemini"><option value="gemini-flash-latest">/);
  expect(html).toMatch(
    /<optgroup label="Anthropic Claude"><option value="claude-sonnet-5-5" selected="">/,
  );
  expect(html).toMatch(/<optgroup label="Other models"><option value="custom-model">/);
});

test("a single service has no empty groups for other providers", () => {
  const html = render({ models: ["claude-sonnet-5-5"], value: "claude-sonnet-5-5" });
  expect(html).toMatch(/<optgroup label="Anthropic Claude">/);
  expect(html.includes("Google Gemini")).toBe(false);
  expect(html.includes("Other models")).toBe(false);
});

test("without a blank choice, no option stands for no model", () => {
  expect(render({ value: "gemini-flash-latest" }).includes('value=""')).toBe(false);
});

test("without a list, the name is typed", () => {
  const html = render({ models: [], value: "gemini-flash-latest" });
  expect(html).toMatch(/^<input/);
  expect(html).toMatch(/value="gemini-flash-latest"/);
});

test("without a list, a blank choice becomes the placeholder", () => {
  const html = render({ models: [], value: "", blankLabel: "The project model" });
  expect(html).toMatch(/placeholder="The project model"/);
});

test("the control keeps the labelling its field gives it, as a drop-down and as text", () => {
  const labelled = { "aria-labelledby": "model-label", "aria-invalid": true };
  const dropDown = renderToStaticMarkup(
    createElement(ModelSelect, { models: MODELS, value: "", onChange: noop, ...labelled }),
  );
  const text = renderToStaticMarkup(
    createElement(ModelSelect, { models: [], value: "", onChange: noop, ...labelled }),
  );
  expect(dropDown).toMatch(/aria-labelledby="model-label"/);
  expect(dropDown).toMatch(/aria-invalid="true"/);
  expect(text).toMatch(/aria-labelledby="model-label"/);
  expect(text).toMatch(/aria-invalid="true"/);
});
