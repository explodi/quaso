// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep application options out of the test runner's own command-line parser.
const result = spawnSync(
  "npx",
  ["vitest", "run", "--project", "acceptance", "acceptance/acceptance.test.ts"],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, QUASO_ACCEPTANCE_ARGS: JSON.stringify(process.argv.slice(2)) },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
