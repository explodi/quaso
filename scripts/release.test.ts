// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(candidate).toContain("## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-10-01");
  expect(candidate).toContain("- Translation review.");
  expect(candidate).toContain("## [1.0.0] - unreleased");
  expect(() => releaseChangelog(candidate, "1.0.0-rc.1", "2026-10-02")).toThrow("already dated");
  const final = releaseChangelog(candidate, "1.0.0", "2026-10-03");
  expect(final).toContain("## [1.0.0] - 2026-10-03\n\n### Added\n\n- Translation review.");
  expect(final.includes("## [1.0.0] - unreleased")).toBe(false);
});

test("release accepts semantic versions and rejects unsafe or malformed input", () => {
  for (const version of ["1.0.0", "1.0.0-rc.1", "2.3.4-beta+build.2"]) {
    expect(validateVersion(version)).toStrictEqual(version);
  }
  for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-01", "1.0.0;echo secret", ""]) {
    expect(() => validateVersion(version)).toThrow();
  }
});

test("release changes the version in the root package.json only, and validates before writing", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "quaso-release-"));
  try {
    await fs.mkdir(`${root}/examples/demo-game`, { recursive: true });
    await fs.writeFile(`${root}/package.json`, '{ "name": "acme", "version": "0.1.0" }\n');
    await fs.writeFile(
      `${root}/examples/demo-game/package.json`,
      '{ "devDependencies": { "@acme/quaso-cli": "0.1.0" } }\n',
    );
    await fs.writeFile(`${root}/CHANGELOG.md`, NOTES);
    const files = await prepareRelease("1.0.0-rc.1", root, new Date("2026-10-01T00:00:00Z"));
    expect(files).toStrictEqual(["package.json", "CHANGELOG.md"]);
    expect(await fs.readFile(`${root}/package.json`, "utf8")).toStrictEqual(
      '{ "name": "acme", "version": "1.0.0-rc.1" }\n',
    );
    expect(await fs.readFile(`${root}/examples/demo-game/package.json`, "utf8")).toStrictEqual(
      '{ "devDependencies": { "@acme/quaso-cli": "0.1.0" } }\n',
    );
    await fs.writeFile(`${root}/CHANGELOG.md`, "invalid changelog");
    await expect(prepareRelease("1.0.0", root)).rejects.toThrow("Unreleased");
    expect(await fs.readFile(`${root}/package.json`, "utf8")).toStrictEqual(
      '{ "name": "acme", "version": "1.0.0-rc.1" }\n',
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
