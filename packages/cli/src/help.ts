// SPDX-License-Identifier: MIT
/** The help texts, and the same as data for `--help --json` (for scripts and AI agents). */
import { GLOBAL_OPTIONS, type OptionSpec } from "./args.ts";
import type { Command } from "./context.ts";
import { EXIT_CODES, type ExitCode } from "./errors.ts";
import { VERSION } from "./version.ts";

const WIDTH = 100;

/** `quaso --help`. */
export function generalHelp(commands: readonly Command[]): string {
  const names = commands.map((command) => command.name);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  return [
    `quaso ${VERSION}: the command line of Quaso, localization for i18next JSON files`,
    "",
    "Usage: quaso <command> [options]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(width)}${command.summary}`),
    `  ${"version".padEnd(width)}Print the version`,
    `  ${"help".padEnd(width)}Show the help of a command: quaso help <command>`,
    "",
    "Options for every command:",
    ...optionLines(GLOBAL_OPTIONS),
    "",
    "Connecting:",
    ...wrap(
      "QUASO_HOSTNAME is the instance, such as translate.yourgame.com (https is assumed) or " +
        'http://localhost:8000; "hostname" in quaso.config.json is the fallback. ' +
        "QUASO_API_KEY is an API key of the instance, only ever from the environment.",
      "  ",
    ),
    "",
    "Exit codes:",
    ...exitCodeLines(EXIT_CODES.map((entry) => entry.code)),
    "",
    "Run quaso <command> --help for a command's options.",
  ].join("\n");
}

/** `quaso <command> --help`. */
export function commandHelp(command: Command): string {
  return [
    `quaso ${command.name}: ${command.summary}`,
    "",
    `Usage: quaso ${command.name} [options]`,
    "",
    ...command.description.flatMap((paragraph) => [...wrap(paragraph, ""), ""]),
    ...(command.options.length > 0 ? ["Options:", ...optionLines(command.options), ""] : []),
    "Options for every command:",
    ...optionLines(GLOBAL_OPTIONS),
    "",
    "Exit codes:",
    ...exitCodeLines(command.exitCodes),
    ...(command.examples.length > 0
      ? ["", "Examples:", ...command.examples.map((example) => `  ${example}`)]
      : []),
  ].join("\n");
}

function optionLines(options: readonly OptionSpec[]): string[] {
  const labels = options.map(
    (option) =>
      `${option.short ? `-${option.short}, ` : ""}--${option.name}${
        option.value ? ` ${option.value}` : ""
      }`,
  );
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  return options.flatMap((option, index) => {
    const [first, ...rest] = wrap(option.description, "", WIDTH - width - 2);
    return [
      `  ${labels[index].padEnd(width)}${first}`,
      ...rest.map((line) => `  ${" ".repeat(width)}${line}`),
    ];
  });
}

function exitCodeLines(codes: readonly ExitCode[]): string[] {
  return EXIT_CODES.filter((entry) => codes.includes(entry.code)).map(
    (entry) => `  ${entry.code}  ${entry.meaning}`,
  );
}

/** Words wrapped into lines of at most `width` characters, each starting with `indent`. */
function wrap(text: string, indent: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line !== "" && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

/** The commands, their options and the exit codes, as data. */
export function helpJson(commands: readonly Command[], only?: Command) {
  const describe = (command: Command) => ({
    name: command.name,
    summary: command.summary,
    description: command.description,
    options: command.options.map(optionJson),
    exitCodes: command.exitCodes,
    examples: command.examples,
  });
  return {
    version: VERSION,
    commands: (only ? [only] : commands).map(describe),
    globalOptions: GLOBAL_OPTIONS.map(optionJson),
    environment: {
      QUASO_HOSTNAME: "The instance: a hostname (https is assumed) or a full URL",
      QUASO_API_KEY: "An API key of the instance (read or upload scope)",
      NO_COLOR: "Any value turns colours off",
    },
    exitCodes: EXIT_CODES,
  };
}

function optionJson(option: OptionSpec) {
  return {
    name: `--${option.name}`,
    ...(option.short ? { short: `-${option.short}` } : {}),
    type: option.type,
    ...(option.value ? { value: option.value } : {}),
    ...(option.choices ? { choices: option.choices } : {}),
    repeatable: option.type === "list" || option.type === "multiple",
    description: option.description,
  };
}
