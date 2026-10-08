// SPDX-License-Identifier: MIT
/** Stream a portable backup into an empty Cloudflare instance through its setup API. */
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Fetch } from "../../core/mod.ts";
import { backupFileKind } from "../../server/src/storage/backup_files.ts";
import { BOOKMARK, restoreTimeTravel } from "./time_travel.ts";
import {
  configuredInstance,
  DEFAULT_INSTANCE_CONFIG,
  type Environment,
  readInstanceConfig,
} from "./instance_config.ts";

const MAX_BYTES = 1024 * 1024 * 1024;

export function restoreOptions(args: readonly string[]) {
  let environment: Environment | undefined;
  let file: string | undefined;
  let at: string | undefined;
  let bookmark: string | undefined;
  let resume = false;
  let takeover = false;
  let configPath = DEFAULT_INSTANCE_CONFIG;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Use ${flag} once.`);
    seen.add(flag);
    if (flag === "--resume") {
      resume = true;
      continue;
    }
    if (flag === "--takeover") {
      takeover = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
    if (flag === "--env") {
      if (value !== "staging" && value !== "production")
        throw new Error("Use --env staging or production.");
      environment = value;
    } else if (flag === "--file") file = resolve(value);
    else if (flag === "--instance-config") configPath = resolve(value);
    else if (flag === "--at") {
      const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
      const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      );
      if (rfc3339) {
        const [year, month, day] = value.slice(0, 10).split("-").map(Number);
        const calendarDate = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
        if (calendarDate !== value.slice(0, 10))
          throw new Error("--at requires a valid calendar date.");
      }
      const time = seconds === undefined ? (rfc3339 ? Date.parse(value) : NaN) : seconds * 1000;
      if (!Number.isFinite(time) || time <= 0 || time > Date.now())
        throw new Error("--at requires a past Unix timestamp or RFC3339 time with a timezone.");
      at = new Date(time).toISOString();
    } else if (flag === "--bookmark") {
      if (!BOOKMARK.test(value)) throw new Error("--bookmark requires a valid D1 bookmark.");
      bookmark = value;
    } else throw new Error(`Unknown restore option ${flag}.`);
  }
  if (!environment || [file, at, bookmark, resume || undefined].filter(Boolean).length !== 1)
    throw new Error(
      "Use cf:restore --env staging|production with exactly one of --file, --at, --bookmark or --resume.",
    );
  if (takeover && !at && !bookmark)
    throw new Error("--takeover is only for a Time Travel retry with --at or --bookmark.");
  return { environment, file, at, bookmark, resume, takeover, configPath };
}

export async function restore(
  args: readonly string[],
  dependencies: {
    key: () => Promise<string>;
    fetch?: Fetch;
    print?: (message: string) => void;
    timeTravel?: typeof restoreTimeTravel;
  },
) {
  const options = restoreOptions(args);
  const instance = configuredInstance(
    await readInstanceConfig(options.configPath),
    options.environment,
  );
  if (options.file === undefined) {
    const source = options.at
      ? { timestamp: options.at }
      : options.bookmark
        ? { bookmark: options.bookmark }
        : { resume: true as const };
    const target = { ...source, takeover: options.takeover };
    return (dependencies.timeTravel ?? restoreTimeTravel)(instance, options.environment, target, {
      fetch: dependencies.fetch,
      print: dependencies.print,
    });
  }
  const file = await fs.stat(options.file);
  if (!file.isFile() || file.size === 0 || file.size > MAX_BYTES)
    throw new Error("Choose a nonempty backup file of at most 1 GiB.");
  const kind = await backupFileKind(options.file);
  const contentType =
    kind === "gzip"
      ? "application/gzip"
      : kind === "sqlite"
        ? "application/vnd.sqlite3"
        : "application/json";
  const key = (await dependencies.key()).trim();
  if (!key) throw new Error("The instance's setup key is required.");
  const print = dependencies.print ?? console.log;
  print(`Restoring ${options.environment} at https://${instance.hostname}…`);
  const response = await (dependencies.fetch ?? fetch)(
    `https://${instance.hostname}/api/v1/restore`,
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(file.size),
        "X-Setup-Key": key,
      },
      body: (await Deno.open(options.file)).readable,
      redirect: "error",
      signal: AbortSignal.timeout(15 * 60_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    const refused = response.status === 401 || response.status === 403;
    const detail = refused
      ? " Check the setup key and that the instance is empty and not set up."
      : " Check the server logs before retrying the same backup.";
    throw new Error(`Restore failed (HTTP ${response.status}).${detail}`);
  }
  const result = await response.json();
  print(`Restored ${options.environment}. Open https://${instance.hostname} to sign in.`);
  return result;
}

const HELP = `Usage: deno task cf:restore --env staging|production <source> [options]

Restores SQLite, JSON or gzip JSON into an empty instance before initial setup.
  --file <backup>            Import a portable backup using the setup key.
  --at <time>                Restore D1 in place to a Unix or RFC3339 timestamp.
  --bookmark <bookmark>      Restore D1 in place, including undoing a previous restore.
  --resume                  Leave failed restoration's maintenance mode after inspection.
  --takeover                Retry Time Travel while retaining an inspected failed pause.
  --instance-config <file>   Use another operator configuration file.

Enter the instance's setup key when prompted, or set QUASO_SETUP_KEY.
Time Travel uses the authenticated Cloudflare account and pauses the running server.
`;

if (import.meta.main) {
  let prompt: ReturnType<typeof createInterface> | undefined;
  try {
    if (process.argv.slice(2).includes("--help")) console.log(HELP);
    else
      await restore(process.argv.slice(2), {
        key: async () => {
          if (process.env.QUASO_SETUP_KEY) return process.env.QUASO_SETUP_KEY;
          if (!process.stdin.isTTY)
            throw new Error("Set QUASO_SETUP_KEY when restoring without an interactive terminal.");
          prompt = createInterface({ input: process.stdin, output: process.stdout });
          return await prompt.question("Setup key: ");
        },
      });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  } finally {
    prompt?.close();
  }
}
