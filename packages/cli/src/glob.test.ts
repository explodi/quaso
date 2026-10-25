// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { glob } from "./glob.ts";
import { withProject } from "./test_helpers.ts";

test("glob walks folders, skipping node_modules and dot folders, sorted", async () => {
  await withProject(
    {
      "src/locales/en/b.json": "{}",
      "src/locales/en/a.json": "{}",
      "src/locales/en/menus/main.json": "{}",
      "src/locales/en/notes.txt": "",
      "src/locales/en/node_modules/x.json": "{}",
      "src/locales/en/.cache/y.json": "{}",
      "src/locales/de/a.json": "{}",
    },
    async (dir) => {
      assertEquals(await glob(dir, "src/locales/en/**/*.json"), [
        "src/locales/en/a.json",
        "src/locales/en/b.json",
        "src/locales/en/menus/main.json",
      ]);
      assertEquals(await glob(dir, "src/locales/en/*.json"), [
        "src/locales/en/a.json",
        "src/locales/en/b.json",
      ]);
      assertEquals(await glob(dir, "src/locales/*/a.json"), [
        "src/locales/de/a.json",
        "src/locales/en/a.json",
      ]);
      assertEquals(
        await glob(dir, "src/locales/en/**/*.json", {
          exclude: ["**/menus/**", "src/locales/en/b.*"],
        }),
        ["src/locales/en/a.json"],
      );
      assertEquals(await glob(dir, "src/locales/en/a.json"), ["src/locales/en/a.json"]);
      assertEquals(await glob(dir, "missing/**/*.json"), []);
      assertEquals(await glob(dir, "src/locales/en/a.json/*.json"), []);
    },
  );
});

test("glob doesn't follow linked folders, but does linked files", async () => {
  if (process.platform === "win32") return;
  await withProject({ "src/en/a.json": "{}", "elsewhere/b.json": "{}" }, async (dir) => {
    await fs.symlink(join(dir, "elsewhere"), join(dir, "src", "en", "linked"));
    await fs.symlink(join(dir, "elsewhere", "b.json"), join(dir, "src", "en", "b.json"));
    await fs.symlink(join(dir, "src"), join(dir, "src", "en", "loop"));
    assertEquals(await glob(dir, "src/en/**/*.json"), ["src/en/a.json", "src/en/b.json"]);
  });
});
