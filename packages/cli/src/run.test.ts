// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { EXIT_CODES } from "./errors.ts";
import { COMMANDS, wantsJson } from "./run.ts";
import { CONFIG, fakeFetch, runCli, withProject } from "./test_helpers.ts";
import { VERSION } from "./version.ts";

test("--help lists the commands, the options and every exit code", async () => {
  const run = await runCli(["--help"]);
  assertEquals(run.code, 0);
  for (const command of COMMANDS) assertStringIncludes(run.stdout, `  ${command.name}`);
  for (const { code, meaning } of EXIT_CODES) {
    assertStringIncludes(run.stdout, `  ${code}  ${meaning}`);
  }
  assertStringIncludes(run.stdout, "QUASO_HOSTNAME");
  assertEquals((await runCli(["help"])).stdout, run.stdout);
});

test("each command's --help lists its options and exit codes", async () => {
  for (const command of COMMANDS) {
    const run = await runCli([command.name, "--help"]);
    assertEquals(run.code, 0);
    assertStringIncludes(run.stdout, `Usage: quaso ${command.name} [options]`);
    for (const option of command.options) assertStringIncludes(run.stdout, `--${option.name}`);
    for (const code of command.exitCodes) {
      const { meaning } = EXIT_CODES.find((entry) => entry.code === code)!;
      assertStringIncludes(run.stdout, `  ${code}  ${meaning}`);
    }
    assertEquals((await runCli(["help", command.name])).stdout, run.stdout);
  }
});

test("--help --json describes the commands as data", async () => {
  const run = await runCli(["upload", "--help", "--json"]);
  const document = JSON.parse(run.stdout);
  assertEquals(document.command, "help");
  assertEquals(
    document.result.commands.map((command: { name: string }) => command.name),
    ["upload"],
  );
  assert(
    document.result.commands[0].options.some(
      (option: { name: string }) => option.name === "--rename",
    ),
  );
  assertEquals(document.result.exitCodes.length, 8);
});

test("version and --version", async () => {
  const text = await runCli(["version"]);
  assertEquals(text.code, 0);
  assert(text.stdout.startsWith(`quaso ${VERSION} (deno `));
  assertEquals((await runCli(["--version"])).stdout, text.stdout);
  const json = JSON.parse((await runCli(["--version", "--json"])).stdout);
  assertEquals(json.result.version, VERSION);
  assertEquals(json.result.runtime.name, "deno");
});

test("usage errors exit with code 2 and never print a stack trace", async () => {
  const cases: [string[], string][] = [
    [[], "Which command?"],
    [["uplaod"], "Did you mean quaso upload?"],
    [["translate", "--language", "!!"], "isn't a valid BCP 47 language tag"],
    [["upload", "extra"], "quaso upload takes no arguments"],
    [["upload", "--nope"], "Unknown option --nope."],
    [["help", "nope"], "Unknown command nope."],
    [["status", "--cwd", "/nonexistent/quaso"], "--cwd /nonexistent/quaso isn't a folder."],
  ];
  for (const [args, message] of cases) {
    const run = await runCli(args);
    assertEquals(run.code, 2, args.join(" "));
    assertStringIncludes(run.stderr, message);
    assert(!run.stderr.includes("    at "), "no stack trace");
    assertEquals(run.stdout, "");
  }
});

test("with --json, errors are one JSON document on stdout too", async () => {
  const parse = await runCli(["upload", "--nope", "--json"]);
  assertEquals(parse.code, 2);
  const document = JSON.parse(parse.stdout);
  assertEquals(document.command, "upload");
  assertEquals(document.ok, false);
  assertEquals(document.error.code, "usage");
  await withProject({ "quaso.config.json": CONFIG, "src/locales/en/a.json": "{}" }, async (dir) => {
    const run = await runCli(["status", "--json"], { cwd: dir, env: { QUASO_HOSTNAME: "x.test" } });
    assertEquals(run.code, 3);
    assertEquals(JSON.parse(run.stdout).error.code, "missing_key");
  });
});

// Regression: --json=true, which the parser takes, got no document when parsing failed.
test("--json=true gets the error document too, when the arguments can't be parsed", async () => {
  for (const args of [
    ["status", "--json=true", "--bogus"],
    ["--json", "status", "--bogus"],
  ]) {
    const run = await runCli(args);
    assertEquals(run.code, 2);
    assertEquals(JSON.parse(run.stdout).error.message, "Unknown option --bogus.");
  }
  for (const args of [
    ["status", "--json=false", "--bogus"],
    ["status", "--bogus", "--", "--json"],
  ]) {
    const run = await runCli(args);
    assertEquals(run.code, 2);
    assertEquals(run.stdout, "", args.join(" "));
  }
  assertEquals(wantsJson(["--json", "--json=false"]), false);
});

test("--cwd and --config choose the project", async () => {
  await withProject(
    {
      "game/quaso.config.json": CONFIG,
      "game/src/locales/en/a.json": "{}",
      "game/other.json": { ...CONFIG, languages: ["fr"] },
    },
    async (dir) => {
      const fetch = fakeFetch(() => new Response("{}", { status: 500 }));
      const env = { QUASO_HOSTNAME: "x.test", QUASO_API_KEY: "k" };
      const none = await runCli(["download", "--dry-run"], { cwd: dir, env, fetch });
      assertEquals(none.code, 2);
      assertStringIncludes(none.stderr, "No quaso.config.json in");
      const cwd = await runCli(["download", "--dry-run", "--cwd", "game"], {
        cwd: dir,
        env,
        fetch,
      });
      assertEquals(cwd.code, 4, cwd.stderr);
      assertEquals(new URL(fetch.requests[0].url).searchParams.get("languages"), "de,pl");
      const config = await runCli(["download", "--dry-run", "--config", "other.json"], {
        cwd: join(dir, "game"),
        env,
        fetch,
      });
      assertEquals(config.code, 4, config.stderr);
      assertEquals(new URL(fetch.requests.at(-1)!.url).searchParams.get("languages"), "fr");
    },
  );
});

test("an unexpected error is exit code 1, with the stack for the bug report", async () => {
  const failing = COMMANDS.find((command) => command.name === "status")!;
  const original = failing.run;
  failing.run = () => Promise.reject(new TypeError("undefined is not a function"));
  try {
    await withProject({ "quaso.config.json": CONFIG }, async (dir) => {
      const run = await runCli(["status"], { cwd: dir });
      assertEquals(run.code, 1);
      assertStringIncludes(run.stderr, "Unexpected error: undefined is not a function");
      assertStringIncludes(run.stderr, "This is a bug in quaso");
      assertStringIncludes(run.stderr, "    at ");
    });
  } finally {
    failing.run = original;
  }
});
