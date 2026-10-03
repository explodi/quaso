// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The CLI's entry point as a function: parses the arguments, runs the command, prints its
 * result (or one JSON document with `--json`) and returns the exit code. It never asks
 * anything, never exits the process, and prints a stack trace only for bugs.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { editDistance, flag, option, parseArgs, type ParsedArgs } from "./args.ts";
import { type Command, Context } from "./context.ts";
import { CliError, EXIT, type ExitCode, usageError } from "./errors.ts";
import { commandHelp, generalHelp, helpJson } from "./help.ts";
import { type Env, errorDocument, Output, resultDocument, type Stream } from "./output.ts";
import { VERSION } from "./version.ts";
import { init } from "./commands/init.ts";
import { upload } from "./commands/upload.ts";
import { download } from "./commands/download.ts";
import { status } from "./commands/status.ts";
import { importCommand } from "./commands/import.ts";
import { translate } from "./commands/translate.ts";

export const COMMANDS: readonly Command[] = [
  init,
  upload,
  download,
  translate,
  status,
  importCommand,
];

const byName = new Map(COMMANDS.map((command) => [command.name, command]));

/** Commands of the design that later versions add. */
const LATER: Record<string, string> = {};

export interface RunOptions {
  /** Default: the process's current folder. */
  cwd?: string;
  /** Default: the process's environment. */
  env?: Env;
  stdout?: Stream;
  stderr?: Stream;
  /** Default: the global `fetch`. */
  fetch?: Fetch;
  /** Default: `setTimeout`. Tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs the CLI with the arguments (without the program's name) and returns the exit code. */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, (name) => byName.get(name)?.options ?? null);
  } catch (error) {
    return report(
      new Output({ stdout, stderr, env, json: wantsJson(argv) }),
      guessCommand(argv),
      error,
    );
  }
  const json = flag(args, "json");
  const out = new Output({ stdout, stderr, env, json });
  const name = args.command;

  try {
    if (flag(args, "version") && !flag(args, "help")) return version(out);
    if (name === null) {
      if (flag(args, "help")) return help(out, null);
      throw usageError(
        "Which command? quaso upload, download, translate, status, import or init.",
        {
          hint: "Run quaso --help for the commands.",
        },
      );
    }
    if (name === "help") {
      const topic = args.positionals[0];
      if (topic === undefined) return help(out, null);
      const command = byName.get(topic);
      if (!command) throw unknownCommand(topic);
      return help(out, command);
    }
    if (name === "version") return version(out);
    const command = byName.get(name);
    if (!command) throw unknownCommand(name);
    if (flag(args, "help")) return help(out, command);
    if (args.positionals.length > 0) {
      throw usageError(
        `quaso ${name} takes no arguments, but got: ${args.positionals.join(" ")}.`,
        {
          hint: `Run quaso ${name} --help for its options.`,
        },
      );
    }

    const cwd = await workingFolder(options.cwd ?? process.cwd(), option(args, "cwd"));
    const ctx = new Context({ args, cwd, env, out, fetch: options.fetch, sleep: options.sleep });
    const result = await command.run(ctx);
    if (json) out.document(resultDocument(name, result.exitCode, result.json));
    else result.render(out);
    return result.exitCode;
  } catch (error) {
    return report(out, name ?? "quaso", error);
  }
}

/** Prints an error (with `--json`, as the JSON document too) and returns its exit code. */
function report(out: Output, command: string, error: unknown): ExitCode {
  if (error instanceof CliError) {
    out.error(error);
    if (out.json) out.document(errorDocument(command, error));
    return error.exitCode;
  }
  const bug = new CliError(
    EXIT.unexpected,
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    {
      code: "internal",
      hint: `This is a bug in quaso ${VERSION}. Please report it with the text above.`,
    },
  );
  out.error(bug);
  if (error instanceof Error && error.stack) out.raw(error.stack);
  if (out.json) out.document(errorDocument(command, bug));
  return EXIT.unexpected;
}

function help(out: Output, command: Command | null): ExitCode {
  if (out.json) {
    out.document(resultDocument("help", EXIT.ok, helpJson(COMMANDS, command ?? undefined)));
  } else {
    out.print(command ? commandHelp(command) : generalHelp(COMMANDS));
  }
  return EXIT.ok;
}

function version(out: Output): ExitCode {
  const bun = process.versions.bun;
  const runtime = bun
    ? { name: "bun", version: bun }
    : { name: "node", version: process.versions.node };
  if (out.json) {
    out.document(resultDocument("version", EXIT.ok, { version: VERSION, runtime }));
  } else {
    out.print(`quaso ${VERSION} (${runtime.name} ${runtime.version})`);
  }
  return EXIT.ok;
}

function unknownCommand(name: string): CliError {
  if (LATER[name]) return usageError(LATER[name], { code: "unknown_command" });
  const names = [...byName.keys(), "help", "version"];
  const close = names.find((candidate) => editDistance(name, candidate) <= 2);
  return usageError(`Unknown command ${name}.`, {
    code: "unknown_command",
    hint: close ? `Did you mean quaso ${close}?` : "Run quaso --help for the commands.",
  });
}

/** The folder to run in: `--cwd`, relative to the current folder, which must exist. */
async function workingFolder(current: string, cwd: string | undefined): Promise<string> {
  const folder = resolve(current, cwd ?? ".");
  if (cwd === undefined) return folder;
  try {
    if ((await stat(folder)).isDirectory()) return folder;
  } catch {
    // Reported below.
  }
  throw usageError(`--cwd ${cwd} isn't a folder.`);
}

/**
 * Whether `--json` is among arguments that couldn't be parsed: `--json` or `--json=true`
 * before any `--`, as the parser reads it.
 */
export function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  let json = false;
  for (const arg of end === -1 ? argv : argv.slice(0, end)) {
    if (arg === "--json" || arg === "--json=true") json = true;
    else if (arg === "--json=false") json = false;
  }
  return json;
}

/** The command's name for a JSON error when the arguments couldn't be parsed. */
function guessCommand(argv: readonly string[]): string {
  return argv.find((arg) => byName.has(arg)) ?? "quaso";
}
