// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { releaseNotes } from "./release_notes.ts";
import { validateVersion } from "./release.ts";
import { VERSION } from "../packages/core/src/version.ts";
import { VERSION as CLI_VERSION } from "../packages/cli/src/version.ts";
import { VERSION as SERVER_VERSION } from "../packages/server/src/version.ts";

test("release notes only publish dated entries and include upgrade instructions", () => {
  const notes = releaseNotes(
    "# Changes\n\n## [1.2.3] - 2026-10-01\n\n- A fix.\n\n## [1.2.2] - 2026-09-30\n\n- Older.\n",
    "1.2.3",
  );
  assertStringIncludes(notes, "- A fix.");
  assertEquals(notes.includes("- Older."), false);
  assertStringIncludes(notes, "docker compose pull");
  assertStringIncludes(notes, "cf:deploy --env production");
  assertThrows(() => releaseNotes("## [1.2.3] - unreleased\n", "1.2.3"));
});

test("the root package.json holds the only version, and every artifact reports it", async () => {
  const workspace = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assertEquals(VERSION, workspace.version);
  assertEquals(CLI_VERSION, VERSION);
  assertEquals(SERVER_VERSION, VERSION);
  for (const path of [
    "packages/core/package.json",
    "packages/service/package.json",
    "packages/server/package.json",
    "packages/cli/package.json",
    "packages/web/package.json",
    "packages/cloudflare/package.json",
    "site/package.json",
  ]) {
    const file = new URL(`../${path}`, import.meta.url);
    assertEquals(JSON.parse(await fs.readFile(file, "utf8")).version, undefined, path);
  }
});

test("the example pins its CLI independently with a matching lockfile", async () => {
  const example = JSON.parse(
    await fs.readFile(new URL("../examples/demo-game/package.json", import.meta.url), "utf8"),
  );
  const cli = JSON.parse(
    await fs.readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await fs.readFile(new URL("../examples/demo-game/package-lock.json", import.meta.url), "utf8"),
  );
  const pinned = example.devDependencies[cli.name];
  assertEquals(validateVersion(pinned), pinned);
  assertEquals(lock.packages[""].devDependencies[cli.name], pinned);
  assertEquals(lock.packages[`node_modules/${cli.name}`].version, pinned);
  assertMatch(lock.packages[`node_modules/${cli.name}`].integrity, /^sha512-/);
});
