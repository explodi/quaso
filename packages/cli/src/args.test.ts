// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertThrows } from "@std/assert";
import { editDistance, flag, option, type OptionSpec, parseArgs, values } from "./args.ts";
import { CliError } from "./errors.ts";

const OPTIONS: Record<string, OptionSpec[]> = {
  init: [{ name: "from-crowdin", type: "optional-string", description: "" }],
  download: [
    { name: "dry-run", type: "boolean", description: "" },
    { name: "language", type: "list", value: "<lang>", description: "" },
    { name: "file", type: "multiple", value: "<path>", description: "" },
    { name: "as", type: "string", choices: ["green", "blue"], description: "" },
  ],
};

const parse = (...argv: string[]) => parseArgs(argv, (name) => OPTIONS[name] ?? null);

test("optional string options preserve following flags and accept an explicit path", () => {
  assertEquals(option(parse("init", "--from-crowdin", "--json"), "from-crowdin"), "");
  assertEquals(flag(parse("init", "--from-crowdin", "--json"), "json"), true);
  assertEquals(option(parse("init", "--from-crowdin", "custom.yml"), "from-crowdin"), "custom.yml");
  assertEquals(option(parse("init", "--from-crowdin=custom.yml"), "from-crowdin"), "custom.yml");
  assertEquals(option(parse("init", "--from-crowdin"), "from-crowdin"), "");
  assertThrows(() => parse("init", "--from-crowdin", "--from-crowdin"), CliError);
});

function usage(fn: () => unknown, message: string | RegExp) {
  const error = assertThrows(fn, CliError);
  assertEquals(error.exitCode, 2);
  if (typeof message === "string") assertEquals(error.message, message);
  else if (!message.test(error.message)) throw new Error(`"${error.message}" !~ ${message}`);
  return error;
}

test("parseArgs finds the command and its options", () => {
  const args = parse("--json", "download", "--dry-run", "--language", "de", "--file=a.json");
  assertEquals(args.command, "download");
  assertEquals(flag(args, "json"), true);
  assertEquals(flag(args, "dry-run"), true);
  assertEquals(values(args, "language"), ["de"]);
  assertEquals(values(args, "file"), ["a.json"]);
  assertEquals(args.positionals, []);
});

test("parseArgs repeats lists and splits comma lists, but not multiple options", () => {
  const args = parse(
    "download",
    "--language",
    "de,fr",
    "--language=pl",
    "--language",
    " de , ja ",
    "--file",
    "a,b.json",
    "--file",
    "c.json",
  );
  assertEquals(values(args, "language"), ["de", "fr", "pl", "ja"]);
  assertEquals(values(args, "file"), ["a,b.json", "c.json"]);
});

test("parseArgs takes global options anywhere, and -h", () => {
  const args = parse("download", "--cwd", "games/demo", "-h", "--config=q.json");
  assertEquals(option(args, "cwd"), "games/demo");
  assertEquals(option(args, "config"), "q.json");
  assertEquals(flag(args, "help"), true);
  assertEquals(parse("--version").command, null);
});

test("parseArgs: booleans take true or false after =", () => {
  assertEquals(flag(parse("download", "--dry-run=false"), "dry-run"), false);
  assertEquals(flag(parse("download", "--dry-run=true"), "dry-run"), true);
  usage(() => parse("download", "--dry-run=yes"), /doesn't take a value/);
});

test("parseArgs: after --, everything is positional", () => {
  const args = parse("download", "--", "--dry-run", "-x");
  assertEquals(args.positionals, ["--dry-run", "-x"]);
  assertEquals(flag(args, "dry-run"), false);
});

test("parseArgs refuses unknown options, with a suggestion", () => {
  const error = usage(() => parse("download", "--languag", "de"), "Unknown option --languag.");
  assertEquals(error.hint, "Did you mean --language? Run quaso download --help for the options.");
  usage(() => parse("download", "-x"), "Unknown option -x.");
  usage(() => parse("--dry-run", "download"), "Unknown option --dry-run.");
});

test("parseArgs checks values: missing, empty, choices, given twice", () => {
  usage(() => parse("download", "--language"), "--language needs a value: <lang>.");
  usage(() => parse("download", "--language", "--dry-run"), "--language needs a value: <lang>.");
  usage(() => parse("download", "--language="), "--language needs a value: <lang>.");
  usage(() => parse("download", "--language", ","), "--language needs a value: <lang>.");
  usage(() => parse("download", "--as", "red"), '--as must be green or blue, not "red".');
  usage(() => parse("download", "--as", "green", "--as", "blue"), "--as can only be given once.");
  assertEquals(option(parse("download", "--as=blue"), "as"), "blue");
});

test("parseArgs leaves the options of an unknown command alone", () => {
  const args = parse("translate", "--language", "de");
  assertEquals(args.command, "translate");
  assertEquals(args.positionals, ["--language", "de"]);
});

test("editDistance", () => {
  assertEquals(editDistance("upload", "upload"), 0);
  assertEquals(editDistance("uplod", "upload"), 1);
  assertEquals(editDistance("statsu", "status"), 2);
  assertEquals(editDistance("", "abc"), 3);
});
