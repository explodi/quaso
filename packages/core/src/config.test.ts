// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(argumentsFor("feed.json", "posts.welcome")).toStrictEqual([IN_SCOPE]);
});

test("argumentResolver: a string in another file doesn't", () => {
  const argumentsFor = argumentResolver([
    { ...AUTHOR_GENDER, files: ["feed.json"], keys: ["posts.*"] },
  ]);
  expect(argumentsFor("chat.json", "posts.welcome")).toStrictEqual([]);
});

test("argumentResolver: a string with another key doesn't", () => {
  const argumentsFor = argumentResolver([
    { ...AUTHOR_GENDER, files: ["feed.json"], keys: ["posts.*"] },
  ]);
  expect(argumentsFor("feed.json", "menu.title")).toStrictEqual([]);
});

test("argumentResolver: without files and keys, every string receives it", () => {
  const argumentsFor = argumentResolver([AUTHOR_GENDER]);
  expect(argumentsFor("text/chat.json", "rooms.lobby.welcome")).toStrictEqual([IN_SCOPE]);
});
