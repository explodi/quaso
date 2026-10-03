// SPDX-License-Identifier: MIT
import { test } from "node:test";
/**
 * S4.11: the end-to-end scenario against a real server, with the CLI in this process
 * (Bun), and with the built bundle under Node and under Bun. The bundle is built into a
 * temporary folder, so the test never uses a stale `dist/`.
 */
import { join } from "node:path";
import { bundleCli } from "../../../scripts/build_cli.ts";
import { bundled, inProcess, nodeVersion, tempDir } from "./harness.ts";
import { runScenario } from "./scenario.ts";

test("e2e: the CLI in-process under Bun", async () => {
  await runScenario(inProcess());
});

const node = await nodeVersion();
/** The CLI needs Node 22 or later (CI's matrix tests 22 and 24). */
const nodeMajor = node === null ? 0 : Number(/^v(\d+)/.exec(node)?.[1] ?? 0);
const skipNode =
  node === null ? "node isn't installed" : nodeMajor < 22 ? `node ${node} is older than 22` : null;

test("e2e: the bundle under Node and under Bun", { timeout: 60000 }, async (t) => {
  const temp = await tempDir("quaso-cli-bundle-");
  try {
    const bundle = join(temp.dir, "quaso.mjs");
    const problems = await bundleCli(bundle);
    if (problems.length > 0) throw new Error(`The bundle is refused: ${problems.join("; ")}`);
    await t.test(
      `node ${node ?? "(not installed)"}`,
      { skip: skipNode !== null, timeout: 60000 },
      () => runScenario(bundled("node", bundle)),
    );
    await t.test("bun", { timeout: 60000 }, () => runScenario(bundled("bun", bundle)));
  } finally {
    await temp.remove();
  }
});

if (skipNode) console.log(`${skipNode}: the bundle's test under Node is skipped.`);
