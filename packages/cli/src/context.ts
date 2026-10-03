// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * What a command runs with: its arguments, the folder, the environment, the output, and the
 * project and server client, loaded when first asked for.
 */
import type { OptionSpec, ParsedArgs } from "./args.ts";
import { apiKey, loadProject, type Project, serverUrl } from "./config.ts";
import { CliError, type ExitCode, type Problem } from "./errors.ts";
import { collectSources, type Sources } from "./files.ts";
import { ApiClient } from "./http.ts";
import type { Env, Output } from "./output.ts";

/** What a command returns: its exit code, its `--json` result, and its text for stdout. */
export interface CommandResult {
  exitCode: ExitCode;
  json: unknown;
  render(out: Output): void;
}

export interface Command {
  name: string;
  /** One line, for the list of commands. */
  summary: string;
  /** Paragraphs for the command's help. */
  description: string[];
  options: OptionSpec[];
  /** The exit codes it may end with. */
  exitCodes: ExitCode[];
  examples: string[];
  run(ctx: Context): Promise<CommandResult>;
}

export interface ContextOptions {
  args: ParsedArgs;
  cwd: string;
  env: Env;
  out: Output;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class Context {
  readonly args: ParsedArgs;
  /** The folder the command runs in (after `--cwd`), absolute. */
  readonly cwd: string;
  readonly env: Env;
  readonly out: Output;
  readonly #fetch?: Fetch;
  readonly #sleep?: (ms: number) => Promise<void>;
  #project?: Promise<Project>;
  #sources?: Promise<Sources>;

  constructor(options: ContextOptions) {
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.out = options.out;
    this.#fetch = options.fetch;
    this.#sleep = options.sleep;
  }

  /** The project: `--config`, or the nearest `quaso.config.json`. */
  project(): Promise<Project> {
    const config = this.args.options.config;
    this.#project ??= loadProject(this.cwd, typeof config === "string" ? config : undefined);
    return this.#project;
  }

  /** The project's source files. */
  sources(): Promise<Sources> {
    this.#sources ??= (async () => {
      const sources = await collectSources(await this.project());
      for (const warning of sources.warnings) this.out.warn(warning);
      return sources;
    })();
    return this.#sources;
  }

  /** Waits, as between polls of a job; tests pass a `sleep` that doesn't. */
  sleep(ms: number): Promise<void> {
    if (this.#sleep) return this.#sleep(ms);
    return new Promise((done) => setTimeout(done, ms));
  }

  /** A client for the instance, with the API key. */
  client(project: Project | null): ApiClient {
    const baseUrl = serverUrl(this.env, project);
    return new ApiClient({
      baseUrl,
      apiKey: apiKey(this.env),
      fetch: this.#fetch,
      sleep: this.#sleep,
      log: (message) => this.out.info(message),
    });
  }
}

/**
 * Rewrites the server's file paths in an error's details to local paths, with `local`
 * (which returns undefined to keep a path as it is), and adds a language to details
 * without one.
 */
export function localizeError(
  error: unknown,
  local: (file: string) => string | undefined,
  extra: { language?: string; configName?: string } = {},
): unknown {
  if (!(error instanceof CliError)) return error;
  error.details = error.details.map((detail): Problem => {
    const mapped: Problem = { ...detail };
    if (detail.file !== undefined) mapped.file = local(detail.file) ?? detail.file;
    else if (extra.configName && /^(limits|pluralExclusions)\[/.test(detail.key ?? "")) {
      mapped.file = extra.configName;
    }
    if (extra.language && detail.language === undefined && detail.file !== undefined) {
      mapped.language = extra.language;
    }
    return mapped;
  });
  return error;
}
