// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * `deno task docker:smoke`: acceptance test 1 against the Docker image (S2.10, design
 * §5.12). On a new volume: an API key from `token create`, a server that becomes healthy,
 * the demo game's English files uploaded with curl, a stop, and a new container on the same
 * volume that still has every string. Also checks that the server runs as a non-root user,
 * stops cleanly, runs with a read-only root (as in compose.yaml), that a second server on
 * the same volume refuses to start, and that the log never discloses the configured setup key.
 *
 * Needs Docker and curl. The task builds the image first; to test another one:
 *   deno run -A scripts/docker_smoke.ts --image explodi/quaso:latest --port 8124
 * Everything it creates (containers, the volume) is removed at the end, pass or fail.
 */
import type { Progress, StatusResult } from "@quaso/core";
import { demoDir, readProjectFiles } from "../packages/server/src/dev_seed.ts";

const decoder = new TextDecoder();

function option(name: string, fallback: string): string {
  const index = process.argv.slice(2).indexOf(name);
  return index === -1 ? fallback : (process.argv.slice(2)[index + 1] ?? fallback);
}

const IMAGE = option("--image", "quaso:dev");
const PORT = Number(option("--port", "8124"));
const RUN = `quaso-smoke-${Date.now().toString(36)}`;
const VOLUME = RUN;
const BASE = `http://127.0.0.1:${PORT}`;

class Failure extends Error {}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Failure(message);
}

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(command: string, args: string[], timeoutMs = 120_000): Promise<Output> {
  const output = await new Deno.Command(command, {
    args,
    stdin: "null",
    signal: AbortSignal.timeout(timeoutMs),
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/** Runs docker; fails with its error output unless `allowFailure`. */
async function docker(
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
) {
  const output = await run("docker", args, options.timeoutMs);
  if (output.code !== 0 && !options.allowFailure) {
    throw new Failure(`docker ${args.join(" ")} failed (${output.code}): ${output.stderr}`);
  }
  return output;
}

/** An HTTP call with curl, as an operator or a CI job would make it. */
async function curl(
  path: string,
  options: { key?: string; bodyFile?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const args = ["-sS", "-w", "\n%{http_code}"];
  if (options.key) args.push("-H", `Authorization: Bearer ${options.key}`);
  if (options.bodyFile) {
    args.push("-H", "Content-Type: application/json", "--data-binary", `@${options.bodyFile}`);
  }
  const output = await run("curl", [...args, `${BASE}${path}`]);
  check(output.code === 0, `curl ${path} failed: ${output.stderr}`);
  const split = output.stdout.lastIndexOf("\n");
  const text = output.stdout.slice(0, split);
  return { status: Number(output.stdout.slice(split + 1)), body: text ? JSON.parse(text) : null };
}

/** Waits until the container's HEALTHCHECK says healthy; fails if it stops or turns unhealthy. */
async function waitHealthy(container: string, timeoutMs = 120_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { stdout } = await docker([
      "inspect",
      "-f",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      container,
    ]);
    const [state, health] = stdout.split(" ");
    if (health === "healthy") return Date.now() - started;
    if (state !== "running" || health === "unhealthy" || health === "none") {
      const logs = await docker(["logs", "--tail", "20", container], { allowFailure: true });
      throw new Failure(
        `${container} is ${state}, health ${health}:\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Failure(`${container} wasn't healthy within ${timeoutMs / 1000} s`);
}

/** What must survive a restart: the strings and words of every language and file. */
function summary(status: StatusResult) {
  const pick = ({ strings, words, untranslated }: Progress) => ({ strings, words, untranslated });
  return status.languages.map((language) => ({
    tag: language.tag,
    ...pick(language),
    files: language.files.map((file) => ({ path: file.path, ...pick(file) })),
  }));
}

const steps: [string, () => Promise<string | void>][] = [];
const step = (name: string, fn: () => Promise<string | void>) => steps.push([name, fn]);

let key = "";
let bodyFile = "";
let before: ReturnType<typeof summary> = [];
let languages: string[] = [];
let sourceFiles = 0;

step("the image runs as a non-root user", async () => {
  const { stdout } = await docker(["image", "inspect", "-f", "{{.Config.User}}", IMAGE]);
  check(!["", "0", "root"].includes(stdout), `the image's user is "${stdout}"`);
  return `user ${stdout}`;
});

step("token create on a new volume prints an API key", async () => {
  await docker(["volume", "create", VOLUME]);
  const { stdout } = await docker([
    "run",
    "--rm",
    "-v",
    `${VOLUME}:/data`,
    IMAGE,
    "token",
    "create",
    "--name",
    "ci",
    "--scope",
    "upload",
  ]);
  check(/^qso_[A-Za-z0-9_-]{43}$/.test(stdout), `unexpected output: ${stdout}`);
  key = stdout;
  return `${key.slice(0, 8)}…`;
});

step("the server starts and its HEALTHCHECK reports healthy", async () => {
  await docker([
    "run",
    "-d",
    "--name",
    `${RUN}-1`,
    "-p",
    `127.0.0.1:${PORT}:8000`,
    "-v",
    `${VOLUME}:/data`,
    "-e",
    "SETUP_KEY=smoke-test-setup-key-not-for-production",
    IMAGE,
  ]);
  return `healthy after ${((await waitHealthy(`${RUN}-1`)) / 1000).toFixed(0)} s`;
});

async function checkSetupLog(container: string) {
  const { stdout, stderr } = await docker(["logs", container]);
  const log = `${stdout}\n${stderr}`;
  check(log.includes("Setup required: open /setup"), "setup instructions missing");
  check(!log.includes("smoke-test-setup-key-not-for-production"), "setup key exposed in logs");
}
step("setup instructions never disclose the configured key", () => checkSetupLog(`${RUN}-1`));

step("the server process runs as a non-root user", async () => {
  // `docker top` needs the PID column in what it asks `ps` for.
  const { stdout } = await docker(["top", `${RUN}-1`, "-eo", "pid,uid,comm"]);
  const processes = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
  const quaso = processes.find(([, , command]) => command === "quaso");
  check(quaso !== undefined, `no quaso process in:\n${stdout}`);
  check(quaso[1] !== "0", "quaso runs as root");
  check(
    processes.every(([, uid]) => uid !== "0"),
    `a process runs as root:\n${stdout}`,
  );
  return `uid ${quaso[1]}`;
});

step("the demo game's English files upload with the key (curl)", async () => {
  const { config, sources } = await readProjectFiles(demoDir());
  languages = config.languages;
  sourceFiles = sources.length;
  bodyFile = await Deno.makeTempFile({ prefix: "quaso-smoke-", suffix: ".json" });
  await fs.writeFile(
    bodyFile,
    JSON.stringify({
      files: sources,
      sourceLanguage: config.sourceLanguage,
      languages: config.languages,
      limits: config.limits,
    }),
  );
  const anonymous = await curl("/api/v1/sources", { bodyFile });
  check(anonymous.status === 401, `without the key: ${anonymous.status}, expected 401`);
  const { status, body } = await curl("/api/v1/sources", { key, bodyFile });
  check(status === 200, `upload: ${status} ${JSON.stringify(body)}`);
  const files = (body as { files: { status: string }[] }).files;
  check(
    files.length === sources.length,
    `${files.length} files uploaded, expected ${sources.length}`,
  );
  check(
    files.every((file) => file.status === "new"),
    `file statuses: ${JSON.stringify(files)}`,
  );
  return `${files.length} files`;
});

step("every string is there, untranslated, in every language", async () => {
  const { status, body } = await curl("/api/v1/status", { key });
  check(status === 200, `status: ${status}`);
  before = summary(body as StatusResult);
  check(
    before
      .map((l) => l.tag)
      .sort()
      .join() === [...languages].sort().join(),
    `languages: ${before.map((l) => l.tag).join()}`,
  );
  check(
    before.every((l) => l.strings > 0 && l.untranslated === l.strings && l.files.length > 0),
    JSON.stringify(before),
  );
  return `${before[0].strings} strings in ${before.length} languages`;
});

step("a second server on the same volume refuses to start (the lock)", async () => {
  const second = await docker(
    ["run", "--rm", "--name", `${RUN}-lock`, "-v", `${VOLUME}:/data`, IMAGE],
    { allowFailure: true, timeoutMs: 60_000 },
  );
  const text = `${second.stdout}\n${second.stderr}`;
  check(second.code !== 0, "the second server started");
  check(text.includes("Another Quaso server is using /data"), `unexpected output: ${text}`);
  return `exit code ${second.code}`;
});

step("docker stop shuts the server down cleanly", async () => {
  await docker(["stop", `${RUN}-1`], { timeoutMs: 60_000 });
  const { stdout } = await docker(["inspect", "-f", "{{.State.ExitCode}}", `${RUN}-1`]);
  check(stdout === "0", `exit code ${stdout}`);
  const logs = await docker(["logs", "--tail", "1", `${RUN}-1`]);
  check(logs.stdout.includes('"msg":"Stopped"'), `last log line: ${logs.stdout}`);
  await docker(["rm", `${RUN}-1`]);
  return "exit code 0, removed";
});

step("a new container on the volume, with a read-only root, becomes healthy", async () => {
  await docker([
    "run",
    "-d",
    "--name",
    `${RUN}-2`,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-p",
    `127.0.0.1:${PORT}:8000`,
    "-v",
    `${VOLUME}:/data`,
    "-e",
    "SETUP_KEY=smoke-test-setup-key-not-for-production",
    IMAGE,
  ]);
  return `healthy after ${((await waitHealthy(`${RUN}-2`)) / 1000).toFixed(0)} s`;
});

step("setup instructions remain private after restart", () => checkSetupLog(`${RUN}-2`));

step("after the restart, the status shows the same strings and the key still works", async () => {
  const { status, body } = await curl("/api/v1/status", { key });
  check(status === 200, `status: ${status}`);
  const after = summary(body as StatusResult);
  check(
    JSON.stringify(after) === JSON.stringify(before),
    `before: ${JSON.stringify(before)}\nafter: ${JSON.stringify(after)}`,
  );
  const exported = await curl("/api/v1/export", { key });
  check(exported.status === 200, `export: ${exported.status}`);
  const files = (exported.body as { files: unknown[] }).files.length;
  check(files === languages.length * sourceFiles, `${files} exported files`);
  return `same status; ${files} files exported`;
});

async function cleanUp(): Promise<void> {
  for (const container of [`${RUN}-1`, `${RUN}-2`, `${RUN}-lock`]) {
    await docker(["rm", "-f", container], { allowFailure: true });
  }
  await docker(["volume", "rm", VOLUME], { allowFailure: true });
  if (bodyFile) await fs.rm(bodyFile).catch(() => {});
}

if (import.meta.main) {
  console.log(`Docker smoke test (acceptance test 1): ${IMAGE}, port ${PORT}, volume ${VOLUME}`);
  let failed = false;
  try {
    for (const [name, fn] of steps) {
      try {
        const detail = await fn();
        console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL  ${name}\n        ${message.replaceAll("\n", "\n        ")}`);
        break;
      }
    }
  } finally {
    await cleanUp();
    console.log("  Removed the containers and the volume.");
  }
  console.log(failed ? "FAIL" : "PASS");
  process.exit(failed ? 1 : 0);
}
