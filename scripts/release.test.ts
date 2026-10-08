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

test("release updates all artifacts from one version and validates before writing", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const path of [
      "packages/core/src",
      "packages/service",
      "packages/server",
      "packages/cli",
      "packages/web",
      "packages/cloudflare",
      "site",
      "examples/demo-game",
    ]) {
      await fs.mkdir(`${root}/${path}`, { recursive: true });
    }
    for (const path of [
      "packages/core/package.json",
      "packages/service/package.json",
      "packages/server/package.json",
      "packages/cli/package.json",
      "packages/web/package.json",
      "packages/cloudflare/package.json",
      "site/package.json",
    ]) {
      await fs.writeFile(`${root}/${path}`, '{ "version": "0.1.0", "other": true }\n');
    }
    await fs.writeFile(
      `${root}/examples/demo-game/package.json`,
      '{ "devDependencies": { "@quaso/cli": "0.1.0" } }\n',
    );
    await fs.writeFile(
      `${root}/packages/core/src/version.ts`,
      '// SPDX-License-Identifier: MIT\nexport const VERSION = "0.1.0";\n',
    );
    await fs.writeFile(`${root}/CHANGELOG.md`, NOTES);
    await fs.writeFile(
      `${root}/deno.lock`,
      '{"workspaces":{"packages/core":{"version":"0.1.0"}}}\n',
    );
    const files = await prepareRelease("1.0.0-rc.1", root, new Date("2026-10-01T00:00:00Z"));
    assertEquals(files.length, 11);
    for (const file of files) {
      assertStringIncludes(await fs.readFile(`${root}/${file}`, "utf8"), "1.0.0-rc.1");
    }
    const before = await fs.readFile(`${root}/packages/core/package.json`, "utf8");
    await fs.writeFile(`${root}/CHANGELOG.md`, "invalid changelog");
    await assertRejects(() => prepareRelease("1.0.0", root), Error, "Unreleased");
    assertEquals(await fs.readFile(`${root}/packages/core/package.json`, "utf8"), before);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
