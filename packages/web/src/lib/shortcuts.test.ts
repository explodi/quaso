// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { isMac, type KeyInput, shortcutFor, shortcutList } from "./shortcuts.ts";

function key(init: Partial<KeyInput> & { key: string }): KeyInput {
  return { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init };
}

test("the editor's shortcuts", () => {
  for (const mac of [false, true]) {
    expect(shortcutFor(key({ key: "Enter", ctrlKey: true }), true, mac)).toStrictEqual({
      type: "save",
    });
    expect(shortcutFor(key({ key: "Enter", metaKey: true }), true, mac)).toStrictEqual({
      type: "save",
    });
    expect(shortcutFor(key({ key: "Enter" }), true, mac)).toBe(null);
    expect(shortcutFor(key({ key: "ArrowDown", altKey: true }), true, mac)).toStrictEqual({
      type: "next",
    });
    expect(shortcutFor(key({ key: "ArrowUp", altKey: true }), false, mac)).toStrictEqual({
      type: "previous",
    });
    expect(shortcutFor(key({ key: "ArrowDown" }), false, mac)).toBe(null);
    expect(
      shortcutFor(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true, mac),
    ).toStrictEqual({ type: "copySource" });
    expect(shortcutFor(key({ key: "c", code: "KeyC", ctrlKey: true }), true, mac)).toStrictEqual(
      null,
    );
    // Ctrl+digit (Control on a Mac), whatever the layout types on the key.
    expect(shortcutFor(key({ key: "3", code: "Digit3", ctrlKey: true }), true, mac)).toStrictEqual({
      type: "insert",
      index: 2,
    });
    expect(shortcutFor(key({ key: '"', code: "Digit3", ctrlKey: true }), true, mac)).toStrictEqual({
      type: "insert",
      index: 2,
    });
    expect(shortcutFor(key({ key: "0", code: "Digit0", ctrlKey: true }), true, mac)).toStrictEqual(
      null,
    );
    // Ctrl+Alt is AltGr on Windows: it types characters.
    expect(
      shortcutFor(key({ key: "{", code: "Digit7", ctrlKey: true, altKey: true }), true, mac),
    ).toBe(null);
    expect(shortcutFor(key({ key: "?", shiftKey: true }), false, mac)).toStrictEqual({
      type: "help",
    });
    expect(shortcutFor(key({ key: "?", shiftKey: true }), true, mac)).toBe(null);
  }
  // Alt+digit, where Alt types nothing else (Windows, Linux).
  expect(shortcutFor(key({ key: "1", code: "Digit1", altKey: true }), true, false)).toStrictEqual({
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
      expect(
        shortcutFor(key({ key: character, code, altKey: true }), inTextInput, true),
        `${code} → ${character}`,
      ).toBe(null);
    }
  }
  // A layout where Option+digit types nothing but the digit still gets the shortcut.
  expect(shortcutFor(key({ key: "2", code: "Digit2", altKey: true }), true, true)).toStrictEqual({
    type: "insert",
    index: 1,
  });
});

test("the shortcut list names the platform's keys", () => {
  expect(isMac("MacIntel")).toBe(true);
  expect(isMac("Win32")).toBe(false);
  expect(shortcutList(true)[0].keys).toStrictEqual([["⌘", "Enter"]]);
  expect(shortcutList(false)[0].keys).toStrictEqual([["Ctrl", "Enter"]]);
  const insert = (mac: boolean) =>
    shortcutList(mac).find((s) => s.description.startsWith("Insert"))!.keys;
  expect(insert(true)).toStrictEqual([["Control", "1…9"]]);
  expect(insert(false)).toStrictEqual([["Alt", "1…9"]]);
});

test("Alt+Shift arrows navigate unfinished entries without intercepting AltGr", () => {
  expect(shortcutFor(key({ key: "ArrowDown", altKey: true, shiftKey: true }), true)).toStrictEqual({
    type: "nextToDo",
  });
  expect(shortcutFor(key({ key: "ArrowUp", altKey: true, shiftKey: true }), true)).toStrictEqual({
    type: "previousToDo",
  });
  expect(
    shortcutFor(key({ key: "ArrowDown", ctrlKey: true, altKey: true, shiftKey: true }), true),
  ).toBe(null);
  expect(
    shortcutList(false).find((entry) => entry.description === "Next string to do")?.keys,
  ).toStrictEqual([["Alt", "Shift", "↓"]]);
});

test("Ctrl+Shift+Enter puts the LLM suggestion in the input", () => {
  expect(
    shortcutFor(key({ key: "Enter", ctrlKey: true, shiftKey: true }), true, false),
  ).toStrictEqual({
    type: "takeLlmSuggestion",
  });
});

test("⌘+Shift+Enter puts the LLM suggestion in the input on a Mac", () => {
  expect(
    shortcutFor(key({ key: "Enter", metaKey: true, shiftKey: true }), true, true),
  ).toStrictEqual({
    type: "takeLlmSuggestion",
  });
});
