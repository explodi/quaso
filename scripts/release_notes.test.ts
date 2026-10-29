// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
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
  expect(notes).toContain("- A fix.");
  expect(notes.includes("- Older.")).toBe(false);
  expect(notes).toContain("docker compose pull");
  expect(notes).toContain("npm run cf:deploy -- --env production");
  expect(() => releaseNotes("## [1.2.3] - unreleased\n", "1.2.3")).toThrow();
});

test("the root package.json holds the only version, and every artifact reports it", async () => {
  const workspace = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(VERSION).toStrictEqual(workspace.version);
  expect(CLI_VERSION).toStrictEqual(VERSION);
  expect(SERVER_VERSION).toStrictEqual(VERSION);
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
    expect(JSON.parse(await fs.readFile(file, "utf8")).version, path).toBe(undefined);
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
  expect(validateVersion(pinned)).toStrictEqual(pinned);
  expect(lock.packages[""].devDependencies[cli.name]).toStrictEqual(pinned);
  expect(lock.packages[`node_modules/${cli.name}`].version).toStrictEqual(pinned);
  expect(lock.packages[`node_modules/${cli.name}`].integrity).toMatch(/^sha512-/);
});
