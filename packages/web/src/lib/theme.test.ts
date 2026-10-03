// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import { parseTheme, readStoredTheme, storeTheme } from "./theme.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("the theme follows the system unless a choice is remembered", () => {
  assertEquals(parseTheme("dark"), "dark");
  assertEquals(parseTheme("purple"), "system");
  assertEquals(parseTheme(null), "system");
  const storage = new MemoryStorage();
  assertEquals(readStoredTheme(storage), "system");
  storeTheme("dark", storage);
  assertEquals(readStoredTheme(storage), "dark");
  storeTheme("system", storage);
  assertEquals(storage.values.size, 0);
});

test("storage that refuses access doesn't break the theme", () => {
  const refusing = {
    getItem(): string | null {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  assertEquals(readStoredTheme(refusing), "system");
  storeTheme("light", refusing);
  assertEquals(readStoredTheme(undefined), "system");
});
