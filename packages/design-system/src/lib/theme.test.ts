// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(parseTheme("dark")).toBe("dark");
  expect(parseTheme("purple")).toBe("system");
  expect(parseTheme(null)).toBe("system");
  const storage = new MemoryStorage();
  expect(readStoredTheme(storage)).toBe("system");
  storeTheme("dark", storage);
  expect(readStoredTheme(storage)).toBe("dark");
  storeTheme("system", storage);
  expect(storage.values.size).toBe(0);
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
  expect(readStoredTheme(refusing)).toBe("system");
  storeTheme("light", refusing);
  expect(readStoredTheme(undefined)).toBe("system");
});
