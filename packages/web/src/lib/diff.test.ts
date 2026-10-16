// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
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
    assertEquals(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
      before,
    );
    assertEquals(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
      after,
    );
  }
});

test("changedParagraphs: only the paragraphs that differ, numbered from 1", () => {
  assertEquals(changedParagraphs("One.\n\nTwo old.\n\nThree.", "One.\n\nTwo new.\n\nThree."), [
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
  assertEquals(changedParagraphs("A\n\nB", "A\n\n\nB"), []);
  assertEquals(changedParagraphs("A\n\nB", "A B"), null);
});
