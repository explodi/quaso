// SPDX-License-Identifier: MIT
/**
 * S4.11: the end-to-end scenario against a real server, with the CLI in this process and
 * with the built bundle under Node. The bundle is built into a temporary folder, so the test
 * never uses a stale `dist/`.
 */
import { join } from "node:path";
import { test } from "vitest";
import { bundleCli } from "../../../scripts/build_cli.ts";
import { bundled, inProcess, tempDir } from "./harness.ts";
import { runScenario } from "./scenario.ts";

test("e2e: the CLI in-process", async () => {
  await runScenario(inProcess());
});

test(`e2e: the bundle under Node ${process.version}`, { timeout: 60000 }, async () => {
  const temp = await tempDir("quaso-cli-bundle-");
  try {
    const bundle = join(temp.dir, "quaso.mjs");
    const problems = await bundleCli(bundle);
    if (problems.length > 0) throw new Error(`The bundle is refused: ${problems.join("; ")}`);
    await runScenario(bundled(bundle));
  } finally {
    await temp.remove();
  }
});
