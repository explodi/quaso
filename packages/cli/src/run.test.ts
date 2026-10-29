// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { join } from "node:path";
import { EXIT_CODES } from "./errors.ts";
import { COMMANDS, wantsJson } from "./run.ts";
import { CONFIG, fakeFetch, runCli, withProject } from "./test_helpers.ts";
import { VERSION } from "./version.ts";

test("--help lists the commands, the options and every exit code", async () => {
  const run = await runCli(["--help"]);
  expect(run.code).toBe(0);
  for (const command of COMMANDS) expect(run.stdout).toContain(`  ${command.name}`);
  for (const { code, meaning } of EXIT_CODES) {
    expect(run.stdout).toContain(`  ${code}  ${meaning}`);
  }
  expect(run.stdout).toContain("QUASO_HOSTNAME");
  expect((await runCli(["help"])).stdout).toStrictEqual(run.stdout);
});

test("each command's --help lists its options and exit codes", async () => {
  for (const command of COMMANDS) {
    const run = await runCli([command.name, "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Usage: quaso ${command.name} [options]`);
    for (const option of command.options) expect(run.stdout).toContain(`--${option.name}`);
    for (const code of command.exitCodes) {
      const { meaning } = EXIT_CODES.find((entry) => entry.code === code)!;
      expect(run.stdout).toContain(`  ${code}  ${meaning}`);
    }
    expect((await runCli(["help", command.name])).stdout).toStrictEqual(run.stdout);
  }
});

test("--help --json describes the commands as data", async () => {
  const run = await runCli(["upload", "--help", "--json"]);
  const document = JSON.parse(run.stdout);
  expect(document.command).toBe("help");
  expect(document.result.commands.map((command: { name: string }) => command.name)).toStrictEqual([
    "upload",
  ]);
  assert(
    document.result.commands[0].options.some(
      (option: { name: string }) => option.name === "--rename",
    ),
  );
  expect(document.result.exitCodes.length).toBe(8);
});

test("version and --version", async () => {
  const text = await runCli(["version"]);
  expect(text.code).toBe(0);
  assert(text.stdout.startsWith(`quaso ${VERSION} (node `));
  expect((await runCli(["--version"])).stdout).toStrictEqual(text.stdout);
  const json = JSON.parse((await runCli(["--version", "--json"])).stdout);
  expect(json.result.version).toStrictEqual(VERSION);
  expect(json.result.runtime.name).toBe("node");
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
    expect(run.code, args.join(" ")).toBe(2);
    expect(run.stderr).toContain(message);
    assert(!run.stderr.includes("    at "), "no stack trace");
    expect(run.stdout).toBe("");
  }
});

test("with --json, errors are one JSON document on stdout too", async () => {
  const parse = await runCli(["upload", "--nope", "--json"]);
  expect(parse.code).toBe(2);
  const document = JSON.parse(parse.stdout);
  expect(document.command).toBe("upload");
  expect(document.ok).toBe(false);
  expect(document.error.code).toBe("usage");
  await withProject({ "quaso.config.json": CONFIG, "src/locales/en/a.json": "{}" }, async (dir) => {
    const run = await runCli(["status", "--json"], { cwd: dir, env: { QUASO_HOSTNAME: "x.test" } });
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).error.code).toBe("missing_key");
  });
});

// Regression: --json=true, which the parser takes, got no document when parsing failed.
test("--json=true gets the error document too, when the arguments can't be parsed", async () => {
  for (const args of [
    ["status", "--json=true", "--bogus"],
    ["--json", "status", "--bogus"],
  ]) {
    const run = await runCli(args);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).error.message).toBe("Unknown option --bogus.");
  }
  for (const args of [
    ["status", "--json=false", "--bogus"],
    ["status", "--bogus", "--", "--json"],
  ]) {
    const run = await runCli(args);
    expect(run.code).toBe(2);
    expect(run.stdout, args.join(" ")).toBe("");
  }
  expect(wantsJson(["--json", "--json=false"])).toBe(false);
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
      expect(none.code).toBe(2);
      expect(none.stderr).toContain("No quaso.config.json in");
      const cwd = await runCli(["download", "--dry-run", "--cwd", "game"], {
        cwd: dir,
        env,
        fetch,
      });
      expect(cwd.code, cwd.stderr).toBe(4);
      expect(new URL(fetch.requests[0].url).searchParams.get("languages")).toBe("de,pl");
      const config = await runCli(["download", "--dry-run", "--config", "other.json"], {
        cwd: join(dir, "game"),
        env,
        fetch,
      });
      expect(config.code, config.stderr).toBe(4);
      expect(new URL(fetch.requests.at(-1)!.url).searchParams.get("languages")).toBe("fr");
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
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("Unexpected error: undefined is not a function");
      expect(run.stderr).toContain("This is a bug in quaso");
      expect(run.stderr).toContain("    at ");
    });
  } finally {
    failing.run = original;
  }
});
