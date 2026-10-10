// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import * as fs from "node:fs/promises";
/** Helpers for the CLI's tests: temporary projects, captured output and a fake `fetch`. */
import { dirname, join } from "node:path";
import type { JobInfo } from "@quaso/core";
import { type ExitCode } from "./errors.ts";
import { Output } from "./output.ts";
import { run, type RunOptions } from "./run.ts";

/** The demo's config, as a starting point. */
export const CONFIG = {
  sourceLanguage: "en",
  languages: ["de", "pl"],
  files: [{ source: "src/locales/en/**/*.json", translation: "src/locales/{lang}/{path}" }],
};

/**
 * Runs `fn` with a temporary folder holding `files` (paths with `/`; objects are written as
 * JSON), and removes the folder afterwards.
 */
export async function withProject(
  files: Record<string, string | object>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "quaso-cli-test-" });
  try {
    await writeFiles(dir, files);
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

export async function writeFiles(dir: string, files: Record<string, string | object>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.split("/"));
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
}

/** Output written to strings. */
export function captured(
  options: { json?: boolean; tty?: boolean; env?: Record<string, string> } = {},
) {
  const text = { stdout: "", stderr: "" };
  const stdout = { write: (chunk: string) => (text.stdout += chunk), isTTY: options.tty ?? false };
  const stderr = { write: (chunk: string) => (text.stderr += chunk), isTTY: options.tty ?? false };
  const output = new Output({
    stdout,
    stderr,
    env: options.env ?? {},
    json: options.json ?? false,
  });
  return { output, text, stdout, stderr };
}

/** Runs the CLI in-process with captured output. */
export async function runCli(
  args: string[],
  options: RunOptions = {},
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    env: {},
    sleep: () => Promise.resolve(),
    waitWhileAsleep: false,
    ...options,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

/** A `fetch` that answers with `handler` and records the requests. */
export function fakeFetch(
  handler: (request: Request, index: number) => Response | Promise<Response>,
): Fetch & { requests: Request[] } {
  const requests: Request[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(handler(request, requests.length - 1));
  };
  return Object.assign(fake as Fetch, { requests });
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A finished LLM job, as `GET /jobs/{id}` answers. */
export function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 7,
    status: "done",
    priority: "upload",
    scope: {},
    createdBy: { type: "token", id: 1, name: "ci" },
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    progress: { total: 4, done: 4, translated: 4, proposed: 0, failed: 0, skipped: 0 },
    tokens: { input: 1200, output: 300, thinking: 0 },
    failures: [],
    error: null,
    ...overrides,
  };
}
