// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import { isMac, type KeyInput, shortcutFor, shortcutList } from "./shortcuts.ts";

function key(init: Partial<KeyInput> & { key: string }): KeyInput {
  return { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init };
}

test("the editor's shortcuts", () => {
  for (const mac of [false, true]) {
    assertEquals(shortcutFor(key({ key: "Enter", ctrlKey: true }), true, mac), { type: "save" });
    assertEquals(shortcutFor(key({ key: "Enter", metaKey: true }), true, mac), { type: "save" });
    assertEquals(shortcutFor(key({ key: "Enter" }), true, mac), null);
    assertEquals(shortcutFor(key({ key: "ArrowDown", altKey: true }), true, mac), {
      type: "next",
    });
    assertEquals(shortcutFor(key({ key: "ArrowUp", altKey: true }), false, mac), {
      type: "previous",
    });
    assertEquals(shortcutFor(key({ key: "ArrowDown" }), false, mac), null);
    assertEquals(
      shortcutFor(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true, mac),
      { type: "copySource" },
    );
    assertEquals(shortcutFor(key({ key: "c", code: "KeyC", ctrlKey: true }), true, mac), null);
    // Ctrl+digit (Control on a Mac), whatever the layout types on the key.
    assertEquals(shortcutFor(key({ key: "3", code: "Digit3", ctrlKey: true }), true, mac), {
      type: "insert",
      index: 2,
    });
    assertEquals(shortcutFor(key({ key: '"', code: "Digit3", ctrlKey: true }), true, mac), {
      type: "insert",
      index: 2,
    });
    assertEquals(shortcutFor(key({ key: "0", code: "Digit0", ctrlKey: true }), true, mac), null);
    // Ctrl+Alt is AltGr on Windows: it types characters.
    assertEquals(
      shortcutFor(key({ key: "{", code: "Digit7", ctrlKey: true, altKey: true }), true, mac),
      null,
    );
    assertEquals(shortcutFor(key({ key: "?", shiftKey: true }), false, mac), { type: "help" });
    assertEquals(shortcutFor(key({ key: "?", shiftKey: true }), true, mac), null);
  }
  // Alt+digit, where Alt types nothing else (Windows, Linux).
  assertEquals(shortcutFor(key({ key: "1", code: "Digit1", altKey: true }), true, false), {
    type: "insert",
    index: 0,
  });
});

test("on a Mac, Option+digit types its character: { } [ ] | @ # stay typeable", () => {
  // What Chrome reports for Option+digit on Mac layouts (key: the character typed).
  const typed: [string, string][] = [
    ["Digit8", "{"], // German: ⌥8
    ["Digit9", "}"], // German: ⌥9
    ["Digit5", "["], // German: ⌥5
    ["Digit6", "]"], // German: ⌥6
    ["Digit7", "|"], // German: ⌥7
    ["Digit2", "@"], // Spanish: ⌥2
    ["Digit3", "#"], // Spanish, UK: ⌥3
    ["Digit2", "“"], // German: ⌥2
    ["Digit1", "¡"], // US: ⌥1
    ["Digit3", "£"], // US: ⌥3
    ["Digit6", "Dead"], // a dead key waits for the next one
  ];
  for (const [code, character] of typed) {
    for (const inTextInput of [true, false]) {
      assertEquals(
        shortcutFor(key({ key: character, code, altKey: true }), inTextInput, true),
        null,
        `${code} → ${character}`,
      );
    }
  }
  // A layout where Option+digit types nothing but the digit still gets the shortcut.
  assertEquals(shortcutFor(key({ key: "2", code: "Digit2", altKey: true }), true, true), {
    type: "insert",
    index: 1,
  });
});

test("the shortcut list names the platform's keys", () => {
  assertEquals(isMac("MacIntel"), true);
  assertEquals(isMac("Win32"), false);
  assertEquals(shortcutList(true)[0].keys, [["⌘", "Enter"]]);
  assertEquals(shortcutList(false)[0].keys, [["Ctrl", "Enter"]]);
  const insert = (mac: boolean) =>
    shortcutList(mac).find((s) => s.description.startsWith("Insert"))!.keys;
  assertEquals(insert(true), [["Control", "1…9"]]);
  assertEquals(insert(false), [["Alt", "1…9"]]);
});

test("Alt+Shift arrows navigate unfinished entries without intercepting AltGr", () => {
  assertEquals(shortcutFor(key({ key: "ArrowDown", altKey: true, shiftKey: true }), true), {
    type: "nextToDo",
  });
  assertEquals(shortcutFor(key({ key: "ArrowUp", altKey: true, shiftKey: true }), true), {
    type: "previousToDo",
  });
  assertEquals(
    shortcutFor(key({ key: "ArrowDown", ctrlKey: true, altKey: true, shiftKey: true }), true),
    null,
  );
  assertEquals(
    shortcutList(false).find((entry) => entry.description === "Next string to do")?.keys,
    [["Alt", "Shift", "↓"]],
  );
});
