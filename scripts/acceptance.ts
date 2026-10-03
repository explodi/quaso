// SPDX-License-Identifier: MIT
import { Command } from "@quaso/runtime/command";

// Keep application options out of the test runner's own command-line parser.
const result = await new Command(process.execPath, {
  args: ["test", "acceptance/acceptance.test.ts", "--timeout", "300000"],
  cwd: new URL("..", import.meta.url),
  env: { QUASO_ACCEPTANCE_ARGS: JSON.stringify(process.argv.slice(2)) },
}).spawn().status;
process.exit(result.code);
