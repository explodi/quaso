// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Fails when a source file lacks the SPDX licence header.
 *
 * Every code file starts with `SPDX-License-Identifier: MIT` in a comment, on its first
 * line, or on its second after a shebang.
 */
import { repositoryFiles } from "./_files.ts";

const CODE = /\.(ts|tsx|mts|js|jsx|mjs|cjs|css|sh)$/;
const SKIP = [/^plans\//, /(^|\/)node_modules\//, /(^|\/)dist\//, /worker-configuration\.d\.ts$/];
const HEADER = "SPDX-License-Identifier: MIT";

export async function missingHeaders(files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    if (!CODE.test(file) || SKIP.some((pattern) => pattern.test(file))) continue;
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n", 3);
    const head = lines[0].startsWith("#!") ? (lines[1] ?? "") : lines[0];
    if (!head.includes(HEADER)) missing.push(file);
  }
  return missing;
}

if (import.meta.main) {
  const missing = await missingHeaders(await repositoryFiles());
  if (missing.length > 0) {
    console.error(`These files lack the "${HEADER}" header on their first line:`);
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log("SPDX headers: ok");
}
