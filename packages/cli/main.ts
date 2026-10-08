// SPDX-License-Identifier: MIT
/**
 * @module
 * The `quaso` command (design §5.10): upload the source files of an i18next project to a
 * Quaso instance, download the translations, check progress in CI and import existing
 * translations. It runs on Node ≥ 22 and Deno ≥ 2.9 from one source, with only `node:`
 * built-ins and web APIs.
 *
 * ```sh
 * deno run -A npm:@quaso/cli upload
 * npx @quaso/cli download
 * ```
 *
 * `run()` runs it in-process, for scripts: it returns the exit code.
 */
import process from "node:process";
import { isClosedPipe } from "./src/output.ts";
import { run } from "./src/run.ts";

export { COMMANDS, run, type RunOptions } from "./src/run.ts";
export { EXIT, EXIT_CODES } from "./src/errors.ts";
export { VERSION } from "./src/version.ts";

// Node 22 has no `import.meta.main` (it is undefined there): the bundle then always runs.
// Deno, and Node from 24.2, set it to false when this module is imported rather than run.
if (import.meta.main !== false) {
  // A closed pipe (`quaso status 2>&1 | head -1`) is not an error: the exit code stays the
  // command's. Both streams, since either may be the pipe.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on?.("error", (error: unknown) => {
      if (!isClosedPipe(error)) throw error;
    });
  }
  process.exitCode = await run(process.argv.slice(2));
}
