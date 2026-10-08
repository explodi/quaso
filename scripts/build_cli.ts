// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * `deno task build:cli` (design §5.10, S4.1, S4.10): bundles the CLI into one JavaScript
 * file for npm, `packages/cli/dist/quaso.mjs`, that runs on Node ≥ 22 and Deno ≥ 2.9, and
 * writes the npm package around it (`package.json`, `README.md`, `LICENSE`).
 *
 * The build fails if the bundle could start a process (`child_process`, `Deno.Command`,
 * `Deno.run`, `spawn(`), imports anything but `node:` built-ins, or if the CLI's version
 * differs from `packages/cli/package.json`.
 */
import { fileURLToPath as fromFileUrl } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages", "cli");
const ENTRY = join(CLI, "main.ts");
const DIST = join(CLI, "dist");
const BUNDLE = "quaso.mjs";

/** What the bundle must never contain (CLI-5): code that starts processes. */
export const FORBIDDEN = ["child_process", "Deno.Command", "Deno.run", "spawn("];

/** The first lines of the bundle: the shebang for npm's `bin`, then the licence. */
export const HEADER = "#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n";

/** Problems with a bundle's code: forbidden words, and imports that aren't `node:` built-ins. */
export function checkBundle(code: string): string[] {
  const problems: string[] = [];
  for (const word of FORBIDDEN) {
    if (code.includes(word)) problems.push(`contains "${word}"`);
  }
  const imports = code.matchAll(
    /^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/gm,
  );
  for (const match of imports) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier.startsWith("node:")) problems.push(`imports "${specifier}"`);
  }
  if (/\bDeno\.[A-Za-z]/.test(code)) problems.push("uses the Deno namespace");
  return problems;
}

/** The npm package's `package.json`; `name` is the one in packages/cli/package.json. */
export function packageJson(
  name: string,
  version: string,
  repository?: string,
): Record<string, unknown> {
  const pkg: Record<string, unknown> = {
    name,
    version,
    description:
      "The command line of Quaso, localization for i18next JSON files: " +
      "upload, download, status and import, from a laptop, from CI and for AI agents",
    license: "MIT",
    type: "module",
    bin: { quaso: BUNDLE },
    files: [BUNDLE, "README.md", "LICENSE"],
    engines: { node: ">=22" },
    keywords: ["i18next", "localization", "translation", "i18n", "cli", "quaso"],
  };
  if (repository) {
    pkg.repository = {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
      directory: "packages/cli",
    };
  }
  return pkg;
}

/** The version in `packages/cli/package.json`, which must match the CLI's `VERSION`. */
export async function cliVersion(): Promise<string> {
  const config = JSON.parse(await fs.readFile(join(CLI, "package.json"), "utf8"));
  const { VERSION } = await import("../packages/cli/src/version.ts");
  if (config.version !== VERSION) {
    throw new Error(
      `packages/cli/package.json says ${config.version}, but packages/cli/src/version.ts says ${VERSION}`,
    );
  }
  return VERSION;
}

/**
 * Bundles the CLI into `output`, with the header, and checks it. Returns the problems
 * found (the file is removed when there are any).
 */
export async function bundleCli(output: string): Promise<string[]> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    // The "deno" platform leaves `node:` imports as they are, which Node runs too.
    args: ["bundle", "--platform=deno", "--output", output, ENTRY],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "piped",
  }).output();
  if (code !== 0) return [`deno bundle failed:\n${new TextDecoder().decode(stderr)}`];
  let text = await fs.readFile(output, "utf8");
  if (text.startsWith("#!")) text = text.slice(text.indexOf("\n") + 1);
  const problems = checkBundle(text);
  if (problems.length > 0) {
    await fs.rm(output);
    return problems;
  }
  await fs.writeFile(output, HEADER + text);
  if (process.platform !== "win32") await fs.chmod(output, 0o755);
  return [];
}

if (import.meta.main) {
  const version = await cliVersion();
  const { name } = JSON.parse(await fs.readFile(join(CLI, "package.json"), "utf8"));
  await fs.rm(DIST, { recursive: true }).catch(() => {});
  await fs.mkdir(DIST, { recursive: true });
  const output = join(DIST, BUNDLE);
  const problems = await bundleCli(output);
  if (problems.length > 0) {
    console.error("The CLI bundle is refused (design §5.10, CLI-5):");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const repository = process.env["GITHUB_REPOSITORY"];
  await fs.writeFile(
    join(DIST, "package.json"),
    `${JSON.stringify(packageJson(name, version, repository), null, 2)}\n`,
  );
  await fs.copyFile(join(CLI, "README.md"), join(DIST, "README.md"));
  const yamlPackage = createRequire(join(CLI, "package.json")).resolve("js-yaml/package.json");
  const license = await fs.readFile(join(ROOT, "LICENSE"), "utf8");
  const yamlLicense = await fs.readFile(join(dirname(yamlPackage), "LICENSE"), "utf8");
  await fs.writeFile(
    join(DIST, "LICENSE"),
    `${license}\nBundled dependency: js-yaml\n\n${yamlLicense}`,
  );
  const size = (await fs.stat(output)).size;
  console.log(`packages/cli/dist/${BUNDLE}: ${(size / 1024).toFixed(1)} KB, ${name} ${version}`);
}
