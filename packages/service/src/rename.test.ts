// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { SYSTEM_AUTHOR } from "./actors.ts";
import { ServiceError } from "./errors.ts";
import { planRenameMove, resolveRenameRows, type RenameClash, type RenameEnd } from "./rename.ts";

const FROM: RenameEnd = {
  id: 1,
  path: "menu.json",
  display_key: "old",
  key_path: '["old"]',
  kind: "text",
  active: 0,
};
const TO: RenameEnd = {
  id: 2,
  path: "menu.json",
  display_key: "new",
  key_path: '["new"]',
  kind: "text",
  active: 1,
};
const NAMES = { file: "menu.json", from: "old", to: "new" };
const LLM: RenameClash = {
  language: "es",
  value: '"Nuevo"',
  colour: "green",
  author_type: "llm",
  people: 0,
};

test("rename snapshot selects hidden source and active target in the same file", () => {
  const other = { ...TO, id: 3, path: "other.json" };
  expect(resolveRenameRows([FROM, other, TO], NAMES)).toStrictEqual({ from: FROM, to: TO });
});

test("rename snapshot rejects a source that is still active", () => {
  expect(() => resolveRenameRows([{ ...FROM, active: 1 }, TO], NAMES)).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("English still has it"),
    }),
  );
});

test("rename snapshot requires a file for hidden sources in several files", () => {
  const other = { ...FROM, id: 3, path: "other.json" };
  expect(() => resolveRenameRows([FROM, other, TO], { from: "old", to: "new" })).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("name the file"),
    }),
  );
});

test("rename snapshot supports an exact path when dotted keys are ambiguous", () => {
  const dotted = { ...FROM, display_key: "a.b", key_path: '["a.b"]' };
  const nested = { ...FROM, id: 3, display_key: "a.b", key_path: '["a","b"]' };
  expect(resolveRenameRows([dotted, nested, TO], { ...NAMES, from: '["a.b"]' })).toStrictEqual({
    from: dotted,
    to: TO,
  });
});

test("rename snapshot requires matching source and target kinds", () => {
  expect(() => resolveRenameRows([FROM, { ...TO, kind: "plural" }], NAMES)).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("is a text string"),
    }),
  );
});

test("rename plan refuses a person's translation", () => {
  expect(() =>
    planRenameMove({ from: FROM, to: TO }, NAMES, SYSTEM_AUTHOR, 100, [
      { ...LLM, author_type: "user" },
    ]),
  ).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("person made or reviewed"),
    }),
  );
});

test("rename plan refuses proofread translations even when the LLM wrote them", () => {
  expect(() =>
    planRenameMove({ from: FROM, to: TO }, NAMES, SYSTEM_AUTHOR, 100, [{ ...LLM, colour: "blue" }]),
  ).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("person made or reviewed"),
    }),
  );
});

test("rename plan refuses LLM translations with a person's history", () => {
  expect(() =>
    planRenameMove({ from: FROM, to: TO }, NAMES, SYSTEM_AUTHOR, 100, [{ ...LLM, people: 1 }]),
  ).toThrow(
    expect.objectContaining({
      constructor: ServiceError,
      message: expect.stringContaining("person made or reviewed"),
    }),
  );
});

test("rename plan retains the replaced value and source identity in history", () => {
  const plan = planRenameMove({ from: FROM, to: TO }, NAMES, SYSTEM_AUTHOR, 100, [LLM]);
  expect(plan.statements[1].params).toStrictEqual([
    2,
    "es",
    "translation_deleted",
    '"Nuevo"',
    null,
    "green",
    null,
    "system",
    null,
    "System",
    '{"reason":"rename","file":"menu.json","from":"old","to":"new"}',
    100,
  ]);
  expect(plan.history).toStrictEqual({
    stringId: 2,
    language: null,
    event: "source_renamed",
    before: null,
    after: null,
    actor: SYSTEM_AUTHOR,
    detail: { file: "menu.json", from: "old", to: "new", fromStringId: 1 },
    at: 100,
  });
});
