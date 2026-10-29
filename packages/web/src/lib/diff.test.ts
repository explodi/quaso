// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { changedParagraphs, wordDiff } from "./diff.ts";

test("word diffs retain whitespace, markup as text, and reconstruct both versions", () => {
  for (const [before, after] of [
    ["Hello world!", "Hello kind world!"],
    ["<script> bad", "<b> better"],
    ["你好\n世界", "你好\n朋友"],
    ["", "new"],
    ["old", ""],
    ["x ".repeat(1000), "x ".repeat(500) + "new " + "x ".repeat(500)],
  ]) {
    const diff = wordDiff(before, after);
    expect(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toStrictEqual(before);
    expect(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toStrictEqual(after);
  }
});

test("changedParagraphs: only the paragraphs that differ, numbered from 1", () => {
  expect(
    changedParagraphs("One.\n\nTwo old.\n\nThree.", "One.\n\nTwo new.\n\nThree."),
  ).toStrictEqual([
    {
      number: 2,
      diff: [
        { text: "Two ", kind: "same" },
        { text: "old.", kind: "removed" },
        { text: "new.", kind: "added" },
      ],
    },
  ]);
});

test("changedParagraphs: nothing for the same paragraphs, null when they don't pair up", () => {
  expect(changedParagraphs("A\n\nB", "A\n\n\nB")).toStrictEqual([]);
  expect(changedParagraphs("A\n\nB", "A B")).toBe(null);
});
