// SPDX-License-Identifier: MIT
/**
 * Output (design §5.10, CLI-4, S4.9): results on stdout, logs and progress on stderr.
 * Colours only on a terminal, never with `NO_COLOR` or `--json`. With `--json`, stdout gets
 * exactly one JSON document.
 */
import { SCHEMA_VERSION } from "@quaso/core";
import type { CliError, ExitCode, Problem } from "./errors.ts";

/** Where text goes: `process.stdout`, `process.stderr`, or a test's buffer. */
export interface Stream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export type Env = Record<string, string | undefined>;

/**
 * Whether an error is a closed pipe (`quaso status 2>&1 | head -1`): not an error of the
 * command, whose exit code stays. Node reports `EPIPE`, then `ERR_STREAM_DESTROYED` for
 * later writes; Deno a `BrokenPipe`.
 */
export function isClosedPipe(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || name === "BrokenPipe";
}

/** Writes to a stream, ignoring a closed pipe. */
function write(stream: Stream, text: string): void {
  try {
    stream.write(text);
  } catch (error) {
    if (!isClosedPipe(error)) throw error;
  }
}

type Style = (text: string) => string;

export interface Styles {
  bold: Style;
  dim: Style;
  red: Style;
  green: Style;
  yellow: Style;
  blue: Style;
  cyan: Style;
}

const plain: Style = (text) => text;
const PLAIN: Styles = {
  bold: plain,
  dim: plain,
  red: plain,
  green: plain,
  yellow: plain,
  blue: plain,
  cyan: plain,
};

function ansi(open: number, close: number): Style {
  return (text) => (text === "" ? text : `\x1b[${open}m${text}\x1b[${close}m`);
}

const COLOURS: Styles = {
  bold: ansi(1, 22),
  dim: ansi(2, 22),
  red: ansi(31, 39),
  green: ansi(32, 39),
  yellow: ansi(33, 39),
  blue: ansi(34, 39),
  cyan: ansi(36, 39),
};

/** Whether to colour a stream: a terminal, without `NO_COLOR` (any non-empty value). */
export function useColour(stream: Stream, env: Env, json: boolean): boolean {
  if (json) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

export class Output {
  readonly json: boolean;
  /** Styles for stdout. */
  readonly out: Styles;
  /** Styles for stderr. */
  readonly err: Styles;
  readonly #stdout: Stream;
  readonly #stderr: Stream;

  constructor(options: { stdout: Stream; stderr: Stream; env: Env; json: boolean }) {
    this.json = options.json;
    this.#stdout = options.stdout;
    this.#stderr = options.stderr;
    this.out = useColour(options.stdout, options.env, options.json) ? COLOURS : PLAIN;
    this.err = useColour(options.stderr, options.env, options.json) ? COLOURS : PLAIN;
  }

  /** A line of the result, on stdout. Never with `--json`: commands render only in text mode. */
  print(line = ""): void {
    if (this.json) throw new Error("print() with --json");
    write(this.#stdout, `${line}\n`);
  }

  /** Progress and information, on stderr. */
  info(message: string): void {
    write(this.#stderr, `${message}\n`);
  }

  warn(message: string): void {
    write(this.#stderr, `${this.err.yellow("warning:")} ${message}\n`);
  }

  /** An error and its details and hint, on stderr. */
  error(error: CliError): void {
    const lines = [`${this.err.red("error:")} ${error.message}`];
    // Details that only repeat the message's language or field add nothing here.
    const details = error.details.filter((detail) => detail.message !== "" || detail.file);
    for (const detail of details.slice(0, MAX_DETAILS)) {
      lines.push(`  ${formatProblem(detail)}`);
    }
    if (details.length > MAX_DETAILS) {
      lines.push(`  … and ${details.length - MAX_DETAILS} more (--json lists them all)`);
    }
    if (error.hint) lines.push(this.err.dim(error.hint));
    write(this.#stderr, `${lines.join("\n")}\n`);
  }

  /** Text for stderr as is (such as a stack trace). */
  raw(text: string): void {
    write(this.#stderr, text.endsWith("\n") ? text : `${text}\n`);
  }

  /** The one JSON document of `--json`. */
  document(document: JsonDocument): void {
    write(this.#stdout, `${JSON.stringify(document, null, 2)}\n`);
  }
}

/** How many details an error prints in text mode. */
const MAX_DETAILS = 50;

export interface JsonDocument {
  schemaVersion: number;
  command: string;
  ok: boolean;
  exitCode: ExitCode;
  result?: unknown;
  error?: { code: string; message: string; hint?: string; status?: number; details: Problem[] };
}

/** The `--json` document for a command's result. */
export function resultDocument(command: string, exitCode: ExitCode, result: unknown): JsonDocument {
  return { schemaVersion: SCHEMA_VERSION, command, ok: exitCode === 0, exitCode, result };
}

/** The `--json` document for an error. */
export function errorDocument(command: string, error: CliError): JsonDocument {
  const body: NonNullable<JsonDocument["error"]> = {
    code: error.code,
    message: error.message,
    details: error.details,
  };
  if (error.hint) body.hint = error.hint;
  if (error.status !== undefined) body.status = error.status;
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    exitCode: error.exitCode,
    error: body,
  };
}

/**
 * A problem in the design's format:
 * `src/locales/pl/common.json › inventory.itemCount (pl): placeholder {{total}} is missing`,
 * with `:line:column` after the file when known.
 */
export function formatProblem(problem: Problem): string {
  let where = "";
  if (problem.file) {
    where = problem.file;
    if (problem.line !== undefined) {
      where += `:${problem.line}${problem.column !== undefined ? `:${problem.column}` : ""}`;
    }
  }
  if (problem.key) where += where === "" ? problem.key : ` › ${problem.key}`;
  if (problem.language) where += where === "" ? `(${problem.language})` : ` (${problem.language})`;
  const message = sentenceFragment(problem.message);
  if (message === "") return where;
  return where === "" ? message : `${where}: ${message}`;
}

/**
 * A sentence as the end of a line: without its final period, and starting in lower case
 * unless it starts with an acronym or a name (`QA`, `JSON`).
 */
export function sentenceFragment(message: string): string {
  let text = message.trim();
  if (text.endsWith(".") && !text.endsWith("..")) text = text.slice(0, -1);
  if (/^[A-Z][a-z]/.test(text) && !/^(I|JSON|English)\b/.test(text)) {
    text = text[0].toLowerCase() + text.slice(1);
  }
  return text;
}

/** `1 file`, `2 files`. */
export function count(n: number, one: string, other = `${one}s`): string {
  return `${n} ${n === 1 ? one : other}`;
}

/**
 * Lines of a table with columns padded to their widths. Columns in `right` are aligned right.
 * `width` measures what is shown, so styled cells can be passed with their plain text.
 */
export function table(
  rows: string[][],
  options: { right?: number[]; gap?: string } = {},
): string[] {
  const right = new Set(options.right ?? []);
  const gap = options.gap ?? "  ";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, column) => {
        const padding = " ".repeat(widths[column] - displayWidth(cell));
        if (right.has(column)) return padding + cell;
        return column === row.length - 1 ? cell : cell + padding;
      })
      .join(gap),
  );
}

/** Characters shown, not counting ANSI escapes. */
export function displayWidth(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/**
 * Quotes an argument for a POSIX shell: as is when it only has harmless characters,
 * otherwise in single quotes (which PowerShell reads the same way, unless the text has one).
 */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_./:=#@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** A command line, quoted for the shell. */
export function commandLine(args: string[]): string {
  return args.map(shellQuote).join(" ");
}
