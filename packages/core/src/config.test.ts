// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { argumentResolver } from "./config.ts";

const AUTHOR_GENDER = {
  name: "authorGender",
  cases: ["female", "male"],
  description: "The gender of the person who wrote the post. other: nonbinary, or not known.",
};

const IN_SCOPE = {
  name: "authorGender",
  cases: ["female", "male"],
  description: AUTHOR_GENDER.description,
};

test("argumentResolver: a string in the files and keys receives the argument", () => {
  const argumentsFor = argumentResolver([
    { ...AUTHOR_GENDER, files: ["feed.json"], keys: ["posts.*"] },
  ]);
  assertEquals(argumentsFor("feed.json", "posts.welcome"), [IN_SCOPE]);
});

test("argumentResolver: a string in another file doesn't", () => {
  const argumentsFor = argumentResolver([
    { ...AUTHOR_GENDER, files: ["feed.json"], keys: ["posts.*"] },
  ]);
  assertEquals(argumentsFor("chat.json", "posts.welcome"), []);
});

test("argumentResolver: a string with another key doesn't", () => {
  const argumentsFor = argumentResolver([
    { ...AUTHOR_GENDER, files: ["feed.json"], keys: ["posts.*"] },
  ]);
  assertEquals(argumentsFor("feed.json", "menu.title"), []);
});

test("argumentResolver: without files and keys, every string receives it", () => {
  const argumentsFor = argumentResolver([AUTHOR_GENDER]);
  assertEquals(argumentsFor("text/chat.json", "rooms.lobby.welcome"), [IN_SCOPE]);
});
