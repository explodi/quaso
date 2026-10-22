// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
import { hasRunningSaves, saveInBackground, saveState, unsavedEdit } from "./backgroundSaves.ts";

const edit = { draft: { other: "Bonjour" }, baseRevision: 3 };

test("a save shows as saving until the saved text is loaded", async () => {
  const { promise: loaded, resolve: load } = Promise.withResolvers<void>();
  const saving = saveInBackground(
    "fr:1",
    edit,
    () => Promise.resolve(),
    () => loaded,
  );
  await Promise.resolve();
  assertEquals(saveState("fr:1"), "saving");
  assertEquals(hasRunningSaves(), true);
  load();
  await saving;
  assertEquals(saveState("fr:1"), null);
  assertEquals(hasRunningSaves(), false);
});

test("a failed save keeps the edit with the error", async () => {
  const refused = new Error("refused");
  await assertRejects(() =>
    saveInBackground(
      "fr:2",
      edit,
      () => Promise.reject(refused),
      () => Promise.resolve(),
    ),
  );
  assertEquals(saveState("fr:2"), "failed");
  assertEquals(unsavedEdit("fr:2"), { ...edit, error: refused });
  assertEquals(hasRunningSaves(), false);
});
