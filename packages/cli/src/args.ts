// SPDX-License-Identifier: MIT
/**
 * A small argument parser: `quaso [global options] <command> [options]`.
 *
 * - `--flag`, `--option value` and `--option=value`; `-h` for `--help`.
 * - Options of type `list` may be repeated and take comma lists: `--language de,fr` is
 *   `--language de --language fr`. Options of type `multiple` may be repeated but aren't
 *   split, because their values may contain commas (file paths, renames).
 * - An `optional-string` consumes a following value or stores an empty string when omitted.
 * - `--` ends the options: what follows is positional, even if it starts with `-`.
 * - Global options go anywhere; a command's options after the command.
 * - Anything unknown is a usage error (exit code 2), with a suggestion when it looks like a
 *   typo.
 */
import { usageError } from "./errors.ts";

export type OptionType = "boolean" | "string" | "optional-string" | "multiple" | "list";

export interface OptionSpec {
  /** The long name, without `--`. */
  name: string;
  type: OptionType;
  /** A one-letter alias, without `-`. */
  short?: string;
  /** The value's name in the help, such as `<lang>`. */
  value?: string;
  description: string;
  /** The values allowed (each item, for lists). */
  choices?: readonly string[];
}

export type OptionValue = boolean | string | string[];

export interface ParsedArgs {
  /** The command, or null when there is none (`quaso --help`). */
  command: string | null;
  options: Record<string, OptionValue>;
  /** Arguments after the command that aren't options. */
  positionals: string[];
}

/** The options every command takes. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "json",
    type: "boolean",
    description: "Print one JSON document on stdout, for scripts and AI agents",
  },
  {
    name: "cwd",
    type: "string",
    value: "<dir>",
    description: "Run as if started in this folder",
  },
  {
    name: "config",
    type: "string",
    value: "<path>",
    description: "The config file, instead of the nearest quaso.config.json",
  },
  { name: "help", type: "boolean", short: "h", description: "Show the help" },
  { name: "version", type: "boolean", description: "Print the version" },
];

/**
 * Parses the arguments. `commandOptions` gives the options of a command once it is known;
 * it returns null for an unknown command, whose options are then not checked.
 */
export function parseArgs(
  argv: readonly string[],
  commandOptions: (command: string) => readonly OptionSpec[] | null,
): ParsedArgs {
  const result: ParsedArgs = { command: null, options: {}, positionals: [] };
  let specs: readonly OptionSpec[] = GLOBAL_OPTIONS;
  let known = true;
  let index = 0;

  const take = (spec: OptionSpec, raw: string, inline: string | undefined): void => {
    if (spec.type === "boolean") {
      if (inline === undefined || inline === "true") return set(result, spec, true);
      if (inline === "false") return set(result, spec, false);
      throw usageError(`--${spec.name} doesn't take a value (got "${raw}").`);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        if (spec.type === "optional-string") return addValue(result, spec, "");
        throw usageError(`--${spec.name} needs a value${spec.value ? `: ${spec.value}` : ""}.`);
      }
      value = next;
      index++;
    }
    addValue(result, spec, value);
  };

  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      result.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const inline = equals === -1 ? undefined : arg.slice(equals + 1);
      const spec = specs.find((option) => option.name === name);
      if (spec) take(spec, arg, inline);
      else if (known) throw unknownOption(`--${name}`, specs, result.command);
      else result.positionals.push(arg);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const spec = specs.find((option) => option.short !== undefined && `-${option.short}` === arg);
      if (spec) take(spec, arg, undefined);
      else if (known) throw unknownOption(arg, specs, result.command);
      else result.positionals.push(arg);
      continue;
    }
    if (result.command === null) {
      result.command = arg;
      const extra = commandOptions(arg);
      known = extra !== null;
      specs = [...GLOBAL_OPTIONS, ...(extra ?? [])];
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}

function set(result: ParsedArgs, spec: OptionSpec, value: boolean): void {
  result.options[spec.name] = value;
}

function addValue(result: ParsedArgs, spec: OptionSpec, value: string): void {
  const items =
    spec.type === "list"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : [value];
  if (
    items.length === 0 ||
    (spec.type !== "list" && spec.type !== "optional-string" && value === "")
  ) {
    throw usageError(`--${spec.name} needs a value${spec.value ? `: ${spec.value}` : ""}.`);
  }
  if (spec.choices) {
    for (const item of items) {
      if (!spec.choices.includes(item)) {
        throw usageError(`--${spec.name} must be ${formatChoices(spec.choices)}, not "${item}".`);
      }
    }
  }
  if (spec.type === "string" || spec.type === "optional-string") {
    if (result.options[spec.name] !== undefined) {
      throw usageError(`--${spec.name} can only be given once.`);
    }
    result.options[spec.name] = value;
    return;
  }
  const list = (result.options[spec.name] as string[] | undefined) ?? [];
  for (const item of items) if (!list.includes(item)) list.push(item);
  result.options[spec.name] = list;
}

function formatChoices(choices: readonly string[]): string {
  if (choices.length === 1) return choices[0];
  return `${choices.slice(0, -1).join(", ")} or ${choices[choices.length - 1]}`;
}

function unknownOption(arg: string, specs: readonly OptionSpec[], command: string | null) {
  const names = specs.map((spec) => `--${spec.name}`);
  const close = names
    .map((name) => ({ name, distance: editDistance(arg, name) }))
    .filter((candidate) => candidate.distance <= 2)
    .sort((a, b) => a.distance - b.distance)[0];
  const where = command === null ? "quaso" : `quaso ${command}`;
  const hint = close
    ? `Did you mean ${close.name}? Run ${where} --help for the options.`
    : `Run ${where} --help for the options.`;
  return usageError(`Unknown option ${arg}.`, { hint });
}

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Whether a boolean option is set. */
export function flag(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

/** A string option's value. */
export function option(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

/** A list or multiple option's values (empty when not given). */
export function values(args: ParsedArgs, name: string): string[] {
  const value = args.options[name];
  return Array.isArray(value) ? value : [];
}
