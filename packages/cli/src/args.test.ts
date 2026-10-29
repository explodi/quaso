// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(option(parse("init", "--from-crowdin", "--json"), "from-crowdin")).toBe("");
  expect(flag(parse("init", "--from-crowdin", "--json"), "json")).toBe(true);
  expect(option(parse("init", "--from-crowdin", "custom.yml"), "from-crowdin")).toStrictEqual(
    "custom.yml",
  );
  expect(option(parse("init", "--from-crowdin=custom.yml"), "from-crowdin")).toStrictEqual(
    "custom.yml",
  );
  expect(option(parse("init", "--from-crowdin"), "from-crowdin")).toBe("");
  expect(() => parse("init", "--from-crowdin", "--from-crowdin")).toThrow(CliError);
});

/** The usage error (exit code 2) that `fn` throws, with `message`. */
function usage(fn: () => unknown, message: string | RegExp): CliError {
  try {
    fn();
  } catch (error) {
    assert(error instanceof CliError);
    expect(error.exitCode).toBe(2);
    if (typeof message === "string") expect(error.message).toBe(message);
    else expect(error.message).toMatch(message);
    return error;
  }
  throw new Error(`expected a usage error: ${message}`);
}

test("parseArgs finds the command and its options", () => {
  const args = parse("--json", "download", "--dry-run", "--language", "de", "--file=a.json");
  expect(args.command).toBe("download");
  expect(flag(args, "json")).toBe(true);
  expect(flag(args, "dry-run")).toBe(true);
  expect(values(args, "language")).toStrictEqual(["de"]);
  expect(values(args, "file")).toStrictEqual(["a.json"]);
  expect(args.positionals).toStrictEqual([]);
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
  expect(values(args, "language")).toStrictEqual(["de", "fr", "pl", "ja"]);
  expect(values(args, "file")).toStrictEqual(["a,b.json", "c.json"]);
});

test("parseArgs takes global options anywhere, and -h", () => {
  const args = parse("download", "--cwd", "games/demo", "-h", "--config=q.json");
  expect(option(args, "cwd")).toBe("games/demo");
  expect(option(args, "config")).toBe("q.json");
  expect(flag(args, "help")).toBe(true);
  expect(parse("--version").command).toBe(null);
});

test("parseArgs: booleans take true or false after =", () => {
  expect(flag(parse("download", "--dry-run=false"), "dry-run")).toBe(false);
  expect(flag(parse("download", "--dry-run=true"), "dry-run")).toBe(true);
  usage(() => parse("download", "--dry-run=yes"), /doesn't take a value/);
});

test("parseArgs: after --, everything is positional", () => {
  const args = parse("download", "--", "--dry-run", "-x");
  expect(args.positionals).toStrictEqual(["--dry-run", "-x"]);
  expect(flag(args, "dry-run")).toBe(false);
});

test("parseArgs refuses unknown options, with a suggestion", () => {
  const error = usage(() => parse("download", "--languag", "de"), "Unknown option --languag.");
  expect(error.hint).toStrictEqual(
    "Did you mean --language? Run quaso download --help for the options.",
  );
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
  expect(option(parse("download", "--as=blue"), "as")).toBe("blue");
});

test("parseArgs leaves the options of an unknown command alone", () => {
  const args = parse("translate", "--language", "de");
  expect(args.command).toBe("translate");
  expect(args.positionals).toStrictEqual(["--language", "de"]);
});

test("editDistance", () => {
  expect(editDistance("upload", "upload")).toBe(0);
  expect(editDistance("uplod", "upload")).toBe(1);
  expect(editDistance("statsu", "status")).toBe(2);
  expect(editDistance("", "abc")).toBe(3);
});
