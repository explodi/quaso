// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(saveState("fr:1")).toBe("saving");
  expect(hasRunningSaves()).toBe(true);
  load();
  await saving;
  expect(saveState("fr:1")).toBe(null);
  expect(hasRunningSaves()).toBe(false);
});

test("a failed save keeps the edit with the error", async () => {
  const refused = new Error("refused");
  await expect(
    saveInBackground(
      "fr:2",
      edit,
      () => Promise.reject(refused),
      () => Promise.resolve(),
    ),
  ).rejects.toThrow();
  expect(saveState("fr:2")).toBe("failed");
  expect(unsavedEdit("fr:2")).toStrictEqual({ ...edit, error: refused });
  expect(hasRunningSaves()).toBe(false);
});
