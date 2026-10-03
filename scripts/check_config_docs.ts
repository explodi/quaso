// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/** Keep every server environment variable discoverable in the template and reference. */
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";

export function configurationVariables(source: string): string[] {
  // Only Reader calls define config inputs; comments and examples are not authoritative.
  return [
    ...new Set(
      [...source.matchAll(/read\.\w+\(([^)]*)\)/g)].flatMap((call) =>
        [...call[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]),
      ),
    ),
  ].sort();
}

export function missingConfigurationDocs(
  source: string,
  template: string,
  reference: string,
): string[] {
  const missing: string[] = [];
  for (const name of configurationVariables(source)) {
    if (!new RegExp(`^\\s*(?:#\\s*)?${name}=`, "m").test(template)) {
      missing.push(`${name} is missing from deploy/.env.example`);
    }
    if (!reference.includes(`\`${name}\``)) {
      missing.push(`${name} is missing from docs/configuration.md`);
    }
  }
  return missing;
}

export async function checkConfigurationDocs(root = fromFileUrl(new URL("..", import.meta.url))) {
  const [source, template, reference] = await Promise.all(
    ["packages/server/src/config.ts", "deploy/.env.example", "docs/configuration.md"].map((path) =>
      fs.readFile(join(root, path), "utf8"),
    ),
  );
  return missingConfigurationDocs(source, template, reference);
}

if (import.meta.main) {
  const missing = await checkConfigurationDocs();
  if (missing.length) {
    for (const message of missing) console.error(message);
    process.exit(1);
  }
  console.log("Configuration documentation: ok");
}
