// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { type LimitTarget, planUploadLimits } from "./upload_limits.ts";

const TITLE: LimitTarget = {
  id: 1,
  path: "menu.json",
  display_key: "title",
  key_path: '["title"]',
  kind: "text",
  max_length: null,
  max_length_locked: 0,
};
const LIMIT = { file: "menu.json", key: "title", maxLength: 5 };

test("upload limit plan sets an unlocked limit and schedules QA", () => {
  const plan = planUploadLimits([LIMIT], [TITLE], [], 100);
  assertEquals(plan.statements[0].params, [5, 1, 100, 1]);
  assertEquals(plan.recheck, [1]);
  assertEquals(plan.warnings, []);
  assertEquals(TITLE.max_length, null);
});

test("upload limit plan leaves an identical locked limit unchanged", () => {
  const row = { ...TITLE, max_length: 5, max_length_locked: 1 };
  assertEquals(planUploadLimits([LIMIT], [row], [1], 100), {
    statements: [],
    changes: [],
    recheck: [],
    warnings: [],
  });
});

test("upload limit plan clears only omitted locks from uploaded files", () => {
  const other = { ...TITLE, id: 2, path: "other.json", max_length: 5, max_length_locked: 1 };
  const plan = planUploadLimits([], [TITLE, other], [1], 100);
  assertEquals(plan.statements.length, 1);
  assertEquals(plan.statements[0].params, [null, 0, 100, 1]);
  assertEquals(plan.recheck, [1]);
});

test("upload limit plan applies the last conflicting selector once", () => {
  const plan = planUploadLimits(
    [LIMIT, { ...LIMIT, key: '["title"]', maxLength: 7 }],
    [TITLE],
    [1],
    100,
  );
  assertEquals(plan.statements.length, 1);
  assertEquals(plan.statements[0].params, [7, 1, 100, 1]);
  assertEquals(plan.warnings, [
    'The limits for menu.json › title and menu.json › ["title"] name the same string; the last one (7) applies',
  ]);
});

test("upload limit plan warns about missing keys without writing", () => {
  const plan = planUploadLimits([{ ...LIMIT, key: "missing" }], [TITLE], [], 100);
  assertEquals(plan.statements, []);
  assertEquals(plan.recheck, []);
  assertEquals(plan.warnings, [
    "The limit for menu.json › missing names a string the server doesn't have",
  ]);
});

test("upload limit plan leaves an ambiguous key out and clears its omitted locks", () => {
  const plural = { ...TITLE, id: 2, kind: "plural" };
  const plan = planUploadLimits([LIMIT], [TITLE, plural], [1, 2], 100);
  assertEquals(
    plan.statements.map((statement) => statement.params),
    [
      [null, 0, 100, 1],
      [null, 0, 100, 2],
    ],
  );
  assertEquals(plan.warnings.length, 1);
  assertEquals(
    plan.warnings[0].startsWith("The limit for menu.json › title names 2 strings"),
    true,
  );
});

test("upload limit plan selects a kind without changing the other kind", () => {
  const plural = { ...TITLE, id: 2, kind: "plural" };
  const plan = planUploadLimits([{ ...LIMIT, key: "title#plural" }], [TITLE, plural], [], 100);
  assertEquals(plan.statements[0].params, [5, 1, 100, 2]);
  assertEquals(plan.recheck, [2]);
  assertEquals(plan.warnings, []);
});

test("upload limit plan distinguishes literal dotted keys from nested paths", () => {
  const dotted = { ...TITLE, display_key: "a.b", key_path: '["a.b"]' };
  const nested = { ...dotted, id: 2, key_path: '["a","b"]' };
  const plan = planUploadLimits([{ ...LIMIT, key: '["a.b"]' }], [dotted, nested], [], 100);
  assertEquals(plan.statements[0].params, [5, 1, 100, 1]);
  assertEquals(plan.recheck, [1]);
  assertEquals(plan.warnings, []);
});
