// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { prepareRelease, releaseChangelog, validateVersion } from "./release.ts";

const NOTES = `# Changelog

## [Unreleased]

### Added

- Translation review.

## [1.0.0] - unreleased

<!-- The team dates and tags the final release after candidate testing. -->
`;

test("release moves notes, preserves the final placeholder and rejects a repeated version", () => {
  const candidate = releaseChangelog(NOTES, "1.0.0-rc.1", "2026-10-01");
  assertStringIncludes(candidate, "## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-10-01");
  assertStringIncludes(candidate, "- Translation review.");
  assertStringIncludes(candidate, "## [1.0.0] - unreleased");
  assertThrows(
    () => releaseChangelog(candidate, "1.0.0-rc.1", "2026-10-02"),
    Error,
    "already dated",
  );
  const final = releaseChangelog(candidate, "1.0.0", "2026-10-03");
  assertStringIncludes(final, "## [1.0.0] - 2026-10-03\n\n### Added\n\n- Translation review.");
  assertEquals(final.includes("## [1.0.0] - unreleased"), false);
});

test("release accepts semantic versions and rejects unsafe or malformed input", () => {
  for (const version of ["1.0.0", "1.0.0-rc.1", "2.3.4-beta+build.2"]) {
    assertEquals(validateVersion(version), version);
  }
  for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-01", "1.0.0;echo secret", ""]) {
    assertThrows(() => validateVersion(version));
  }
});

test("release changes the version in the root package.json only, and validates before writing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await fs.mkdir(`${root}/examples/demo-game`, { recursive: true });
    await fs.writeFile(`${root}/package.json`, '{ "name": "acme", "version": "0.1.0" }\n');
    await fs.writeFile(
      `${root}/examples/demo-game/package.json`,
      '{ "devDependencies": { "@acme/quaso-cli": "0.1.0" } }\n',
    );
    await fs.writeFile(`${root}/CHANGELOG.md`, NOTES);
    const files = await prepareRelease("1.0.0-rc.1", root, new Date("2026-10-01T00:00:00Z"));
    assertEquals(files, ["package.json", "CHANGELOG.md"]);
    assertEquals(
      await fs.readFile(`${root}/package.json`, "utf8"),
      '{ "name": "acme", "version": "1.0.0-rc.1" }\n',
    );
    assertEquals(
      await fs.readFile(`${root}/examples/demo-game/package.json`, "utf8"),
      '{ "devDependencies": { "@acme/quaso-cli": "0.1.0" } }\n',
    );
    await fs.writeFile(`${root}/CHANGELOG.md`, "invalid changelog");
    await assertRejects(() => prepareRelease("1.0.0", root), Error, "Unreleased");
    assertEquals(
      await fs.readFile(`${root}/package.json`, "utf8"),
      '{ "name": "acme", "version": "1.0.0-rc.1" }\n',
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
