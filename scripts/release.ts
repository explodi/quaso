// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/** Prepare release files. Never invokes git, tags, publishes, or deploys. */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function validateVersion(version: string): string {
  if (!SEMVER.test(version)) throw new Error(`Not a semantic version: ${version}`);
  return version;
}

/** Move pending notes under a dated version; consume an optional prepared placeholder. */
export function releaseChangelog(changelog: string, version: string, date: string): string {
  validateVersion(version);
  const unreleased = /^## \[Unreleased\]\s*$/m.exec(changelog);
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const start = unreleased.index + unreleased[0].length;
  const rest = changelog.slice(start);
  const next = /^## /m.exec(rest);
  const end = next ? start + next.index : changelog.length;
  const entries = changelog.slice(start, end).trim();
  const versionHeader = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\] - (.+)$`,
    "m",
  );
  const existing = versionHeader.exec(changelog);
  if (existing && existing[1] !== "unreleased") {
    throw new Error(`${version} is already dated in CHANGELOG.md`);
  }
  let tail = changelog.slice(end);
  if (existing) {
    const placeholder = versionHeader.exec(tail)!;
    const after = placeholder.index + placeholder[0].length;
    const following = /^## /m.exec(tail.slice(after));
    const placeholderEnd = following ? after + following.index : tail.length;
    // A prepared heading must never hide actual release notes.
    const body = tail.slice(after, placeholderEnd).trim();
    if (body && !body.startsWith("<!--")) {
      throw new Error(
        `${version}'s prepared section contains notes; move them to Unreleased first`,
      );
    }
    tail = tail.slice(0, placeholder.index) + tail.slice(placeholderEnd);
  }
  if (!entries && !version.includes("-")) {
    // A final release may adopt the latest release candidate's notes.
    const candidate =
      /^## \[(\d+\.\d+\.\d+-[^\]]+)\] - [^\n]+\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(tail);
    if (candidate?.[1].startsWith(`${version}-`)) {
      return (
        changelog.slice(0, start).trimEnd() +
        `\n\n## [${version}] - ${date}\n\n${candidate[2].trim()}\n\n${tail.trim()}\n`
      );
    }
  }
  return (
    changelog.slice(0, start).trimEnd() +
    `\n\n## [${version}] - ${date}\n\n${entries || "No additional changes."}\n\n${tail.trim()}\n`
  );
}

export async function prepareRelease(
  version: string,
  root = ROOT,
  now = new Date(),
): Promise<string[]> {
  validateVersion(version);
  const files = new Map<string, string>();
  const jsonFiles = [
    "packages/core/package.json",
    "packages/service/package.json",
    "packages/server/package.json",
    "packages/cli/package.json",
    "packages/web/package.json",
    "packages/cloudflare/package.json",
    "site/package.json",
  ];
  // Read and validate every input before writing any output.
  for (const path of jsonFiles) {
    const original = await fs.readFile(join(root, path), "utf8");
    const parsed = JSON.parse(original);
    if (typeof parsed.version !== "string") throw new Error(`${path} has no version`);
    files.set(path, original.replace(/("version"\s*:\s*")[^"]+"/, `$1${version}"`));
  }
  const lockPath = join(root, "deno.lock");
  const lock = await fs.readFile(lockPath, "utf8");
  files.set("deno.lock", lock.replace(/("version"\s*:\s*")[^"]+"/g, `$1${version}"`));
  const examplePath = "examples/demo-game/package.json";
  const example = await fs.readFile(join(root, examplePath), "utf8");
  if (!JSON.parse(example).devDependencies?.["@quaso/cli"]) {
    throw new Error(`${examplePath} has no @quaso/cli pin`);
  }
  files.set(examplePath, example.replace(/("@quaso\/cli"\s*:\s*")[^"]+"/, `$1${version}"`));
  const versionPath = "packages/core/src/version.ts";
  const source = await fs.readFile(join(root, versionPath), "utf8");
  if (!/export const VERSION = "[^"]+";/.test(source)) throw new Error("Missing canonical VERSION");
  files.set(
    versionPath,
    source.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`),
  );
  files.set(
    "CHANGELOG.md",
    releaseChangelog(
      await fs.readFile(join(root, "CHANGELOG.md"), "utf8"),
      version,
      now.toISOString().slice(0, 10),
    ),
  );
  for (const [path, contents] of files) await fs.writeFile(join(root, path), contents);
  return [...files.keys()];
}

if (import.meta.main) {
  if (process.argv.slice(2).length !== 1) {
    console.error("Usage: deno task release <version> (for example, 1.0.0-rc.1)");
    process.exit(2);
  }
  try {
    const version = validateVersion(process.argv.slice(2)[0]);
    const files = await prepareRelease(version);
    console.log(`Prepared ${version}:\n${files.map((file) => `  ${file}`).join("\n")}`);
    console.log(
      `\nReview and test the changes, then run these commands yourself:\n` +
        `git add ${files.join(" ")}\n` +
        `git commit -m "Release ${version}"\n` +
        `git tag -a v${version} -m "Quaso ${version}"\n` +
        `git push origin HEAD\ngit push origin v${version}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
