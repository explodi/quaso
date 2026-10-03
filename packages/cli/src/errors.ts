// SPDX-License-Identifier: MIT
/**
 * Exit codes (design §5.10, CLI-4) and the errors that carry them. An expected error is a
 * `CliError`: the CLI prints its message and details, never a stack trace.
 */

export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  network: 4,
  invalidSource: 5,
  refused: 6,
  failOn: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The table in `--help`, the README and docs/cli.md. */
export const EXIT_CODES: readonly { code: ExitCode; meaning: string }[] = [
  { code: 0, meaning: "success" },
  { code: 1, meaning: "unexpected error" },
  { code: 2, meaning: "bad usage or invalid config" },
  { code: 3, meaning: "authentication or permission problem (missing API key, wrong scope)" },
  { code: 4, meaning: "network error or server unavailable (safe to retry)" },
  { code: 5, meaning: "invalid source file (JSON syntax, duplicate key)" },
  { code: 6, meaning: "finished, but some items were refused or failed; the output lists them" },
  { code: 7, meaning: "the status --fail-on condition is met" },
];

/**
 * One problem, located as precisely as possible. Paths are local paths (relative to the
 * project folder) once a command has mapped them; the server's details name its own paths.
 */
export interface Problem {
  file?: string;
  key?: string;
  language?: string;
  line?: number;
  column?: number;
  /** The quality check or the request field concerned. */
  check?: string;
  message: string;
}

export interface CliErrorOptions {
  /** A machine-readable code: the API's error code, or one of the CLI's own. */
  code?: string;
  details?: Problem[];
  /** What to do about it, printed after the message. */
  hint?: string;
  /** The HTTP status, for errors from the server. */
  status?: number;
}

/** An expected error: its message is for people, its exit code for scripts. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  details: Problem[];
  readonly hint?: string;
  readonly status?: number;

  constructor(exitCode: ExitCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = options.code ?? defaultCode(exitCode);
    this.details = options.details ?? [];
    this.hint = options.hint;
    this.status = options.status;
  }
}

function defaultCode(exitCode: ExitCode): string {
  switch (exitCode) {
    case EXIT.usage:
      return "usage";
    case EXIT.auth:
      return "unauthorized";
    case EXIT.network:
      return "network";
    case EXIT.invalidSource:
      return "invalid_source";
    default:
      return "error";
  }
}

/** Bad usage or an invalid config: exit code 2. */
export function usageError(message: string, options: Omit<CliErrorOptions, "status"> = {}) {
  return new CliError(EXIT.usage, message, { code: "usage", ...options });
}
