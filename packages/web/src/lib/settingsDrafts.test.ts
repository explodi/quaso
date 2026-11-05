// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { SettingsDrafts } from "./settingsDrafts.ts";

test("a completed save preserves an edit made while it was pending", async () => {
  const store = new SettingsDrafts();
  store.change("file:1", "First draft");
  const original = store.getSnapshot();
  const gate = Promise.withResolvers<void>();
  const pending = store.save("file:1", "First draft", () => gate.promise);
  store.change("file:1", "Newer draft");
  gate.resolve();
  expect(await pending).toBe(true);
  expect(store.getSnapshot().drafts.get("file:1")).toBe("Newer draft");
  expect(store.getSnapshot().saving.size).toBe(0);
  expect(original.drafts.get("file:1")).toBe("First draft");
});

test("a new subscriber sees a pending save and cannot start it twice", async () => {
  const store = new SettingsDrafts();
  store.change("file:1", "Saved text");
  const gate = Promise.withResolvers<void>();
  const pending = store.save("file:1", "Saved text", () => gate.promise);
  let observed = store.getSnapshot();
  const unsubscribe = store.subscribe(() => {
    observed = store.getSnapshot();
  });
  expect(observed.saving.has("file:1")).toBe(true);
  expect(
    await store.save("file:1", "Saved text", async () => {
      throw new Error("A duplicate save must not run");
    }),
  ).toBe(false);
  gate.resolve();
  await pending;
  expect(observed.saving.size).toBe(0);
  expect(observed.drafts.size).toBe(0);
  unsubscribe();
});

test("a failed write or refresh retains the draft and releases the pending state", async () => {
  const store = new SettingsDrafts();
  store.change("limit:1", "12");
  await expect(
    store.save("limit:1", "12", async () => {
      throw new Error("Refresh failed");
    }),
  ).rejects.toThrow("Refresh failed");
  expect(store.getSnapshot().drafts.get("limit:1")).toBe("12");
  expect(store.getSnapshot().saving.size).toBe(0);
});
