// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Fails when a dependency has a licence that isn't permissive.
 *
 * npm packages are checked from their installed `package.json`, in every `node_modules`
 * folder of the repository.
 */
import { walk } from "@std/fs/walk";

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  // Data only (such as caniuse-lite), not code.
  "CC-BY-4.0",
]);

/**
 * Dependencies of development tools that are never part of Quaso and never shipped with
 * it, each allowed only below its folder, with the reason.
 */
export const DEV_TOOL_EXCEPTIONS: {
  root: string;
  name: RegExp;
  license: string;
  reason: string;
}[] = [
  {
    root: "node_modules",
    name: /^lightningcss(?:-[a-z0-9-]+)?$/,
    license: "MPL-2.0",
    reason:
      "Vite 8 uses Lightning CSS at build time only. Its code is not bundled into " +
      "the browser, server or CLI; only the generated CSS is shipped.",
  },
  {
    root: "node_modules",
    name: /^@img\/sharp-libvips-/,
    license: "LGPL-3.0-or-later",
    reason:
      "libvips, which Miniflare's local image binding loads through sharp: used only " +
      "by Wrangler and the Cloudflare tests on a developer's machine or in CI, never " +
      "bundled into the Worker or the image",
  },
];

/** Is an SPDX expression such as `(MIT OR Apache-2.0)` allowed? */
export function isAllowed(expression: string): boolean {
  const cleaned = expression.replace(/[()]/g, " ").trim();
  if (cleaned === "") return false;
  // Every AND branch must be allowed; one allowed alternative is enough for OR.
  return cleaned
    .split(/\s+OR\s+/i)
    .some((alternative) =>
      alternative.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim().replace(/\+$/, ""))),
    );
}

function licenseOf(pkg: Record<string, unknown>): string {
  const license = pkg.license ?? pkg.licenses;
  if (typeof license === "string") return license;
  if (Array.isArray(license)) {
    return license.map((l) => (typeof l === "string" ? l : l?.type)).join(" OR ");
  }
  if (license && typeof license === "object" && "type" in license) {
    return String((license as { type: unknown }).type);
  }
  return "";
}

async function checkNpm(problems: string[]): Promise<number> {
  let count = 0;
  const roots = ["node_modules", "packages/cloudflare/node_modules", "site/node_modules"];
  for (const root of roots) {
    try {
      await fs.stat(root);
    } catch {
      continue;
    }
    for await (const entry of walk(root, {
      match: [/package\.json$/],
      includeDirs: false,
      followSymlinks: false,
    })) {
      // Only a package's own manifest: .../node_modules/<name>/package.json or @scope/<name>.
      const parts = entry.path.split("/");
      const at = parts.lastIndexOf("node_modules");
      const depth = parts.length - at - 1;
      const scoped = parts[at + 1]?.startsWith("@");
      if (at < 0 || depth !== (scoped ? 3 : 2)) continue;
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(await fs.readFile(entry.path, "utf8"));
      } catch {
        continue;
      }
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
      count++;
      const license = licenseOf(pkg);
      const excepted = DEV_TOOL_EXCEPTIONS.some(
        (exception) =>
          (exception.root === root ||
            (exception.root === "node_modules" && root === "packages/cloudflare/node_modules")) &&
          exception.name.test(pkg.name as string) &&
          exception.license === license,
      );
      if (!isAllowed(license) && !excepted) {
        problems.push(`npm:${pkg.name}@${pkg.version}: "${license || "no licence"}"`);
      }
    }
  }
  return count;
}

if (import.meta.main) {
  const problems: string[] = [];
  const npm = await checkNpm(problems);
  if (problems.length > 0) {
    console.error("Dependencies without a permissive licence (design §8, Licensing):");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Licences: ok (${npm} npm packages)`);
}
