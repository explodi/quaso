// SPDX-License-Identifier: MIT

// Keep application options out of the test runner's own command-line parser.
const result = await new Deno.Command(Deno.execPath(), {
  args: ["test", "-A", "acceptance/acceptance.test.ts"],
  cwd: new URL("..", import.meta.url),
  env: { QUASO_ACCEPTANCE_ARGS: JSON.stringify(process.argv.slice(2)) },
}).spawn().status;
process.exit(result.code);
