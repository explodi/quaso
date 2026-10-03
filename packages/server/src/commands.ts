// SPDX-License-Identifier: MIT
import { serveHttp } from "@quaso/runtime/http";
import type { HttpServer } from "@quaso/runtime/http";
import * as fs from "node:fs/promises";
/**
 * The server's commands (design §5.12, §5.13): `serve`, `healthcheck` for Docker's
 * `HEALTHCHECK`, `version`, `token create` for operators, and `seed-dev` for
 * `bun run dev`. Each returns its exit code. The Cloudflare container runs the service
 * on private D1/R2 storage; other deployments use the local data folder.
 */
import { CreateApiTokenRequest, formatIssue, PublicationTime, validate } from "@quaso/core";
import {
  type Logger,
  type ServiceApi,
  type Store,
  ServiceError,
  ServiceTransportError,
  SYSTEM,
} from "@quaso/service";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { type Config, type Env, loadConfig, readEnvironment } from "./config.ts";
import { demoDir, seedDemo } from "./dev_seed.ts";
import { startLocalService } from "./local_service.ts";
import { startCloudflareService } from "./cloudflare_service.ts";
import { createLogger } from "./log.ts";
import { configureSetupKey } from "./setup_key.ts";
import { InFlight, stopServer } from "./shutdown.ts";
import { restoreFile, storedBackupSnapshot } from "./storage/backup_files.ts";
import { createFolderStore } from "./storage/folder_store.ts";
import { LockBusyError } from "./storage/lock.ts";
import { connectRemoteService, RemoteSetupError } from "./storage/remote.ts";
import { VERSION } from "./version.ts";

export const USAGE = `Quaso server ${VERSION}

Usage: quaso [command]

Commands:
  serve                     Run the server (the default)
  healthcheck               Check that the server on PORT answers, for Docker's HEALTHCHECK
  version                   Print the version
  token create --name <name> --scope read|upload
                            Create an API key and print its secret, once. With local
                            storage, stop the server first: it holds the data folder.
  seed-dev                  Seed the demo project into a new development database
                            (QUASO_DEV=1; bun run dev runs it)
  restore <file>            Restore a backup (.sqlite, .json or .json.gz) into a new, empty
                            instance: the data folder (stop the server first), or
                            Cloudflare storage
  backup <store-key> <file> Extract a retained local SQLite backup without opening the database
  backup --at <UTC time> <file>
                            Extract the newest local backup at or before that time

Settings come from environment variables, and from a .env file in the working directory:
see deploy/.env.example.`;

/** The file `seed-dev` writes the development API key to, in the data folder. */
export const DEV_KEY_FILE = "dev-api-key";

/** Runs a command line and returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const [command = "serve", ...rest] = args;
  switch (command) {
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "healthcheck":
      return await healthcheck(await readEnvironment());
    case "serve":
    case "token":
    case "restore":
    case "backup":
    case "seed-dev": {
      const config = checkedConfig(await readEnvironment());
      if (!config) return 1;
      if (command === "serve") return await serve(config);
      // One-off commands log to stderr, and only warnings, so stdout stays clean.
      const log = createLogger({ level: "warn", write: (line) => console.error(line) });
      if (command === "restore") return await restore(config, log, rest);
      if (command === "backup") return await extractBackup(config, rest);
      return command === "token" ? await token(config, log, rest) : await seedDev(config, log);
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/** Recovery must remain possible when the live schema cannot start or migrate. */
async function extractBackup(config: Config, args: string[]): Promise<number> {
  const timed = args[0] === "--at";
  const validTime = timed && args.length === 3 && validate(PublicationTime, args[1]).ok;
  const named = !timed && args.length === 2;
  if (!validTime && !named) {
    console.error("Usage: quaso backup <store-key> <file>, or quaso backup --at <UTC time> <file>");
    return 2;
  }
  if (config.cloudflare || config.servicesUrl !== null) {
    console.error("Use the Cloudflare backup download and restore commands for remote storage.");
    return 1;
  }
  const input = timed ? { at: args[1] } : { file: args[0] };
  const path = timed ? args[2] : args[1];
  try {
    const backup = await storedBackupSnapshot(
      createFolderStore(join(config.dataDir, "store")),
      input,
    );
    await backup.snapshotTo(path, { exclusive: true });
    console.error(`Saved backup to ${path}.`);
    return 0;
  } catch (error) {
    console.error(`Couldn't extract the backup: ${(error as Error).message}`);
    return 1;
  }
}

/** The config, or null after printing its problems. */
function checkedConfig(env: Env): Config | null {
  const result = loadConfig(env);
  if (result.ok) return result.config;
  console.error("Quaso can't start, because of its settings:");
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error("Settings are environment variables (or a .env file): see deploy/.env.example.");
  return null;
}

/**
 * Serves until SIGTERM or SIGINT, then finishes the requests in flight (for at most
 * `SHUTDOWN_DEADLINE_MS`) and closes storage.
 */
async function serve(config: Config): Promise<number> {
  const log = createLogger({ level: config.logLevel });
  const storage = await openStorage(config, log, { backups: true, llm: true });
  if (!storage) return 1;
  try {
    await configureSetupKey(storage.service, config, log);
  } catch (error) {
    storage.close();
    throw error;
  }
  const inFlight = new InFlight();
  const app = inFlight.wrap(
    createApp({
      config,
      service: storage.service,
      log,
      storage: storage.kind,
      backups: storage.backups,
      secretKey: storage.secretKey,
    }),
  );
  let server: HttpServer;
  try {
    server = serveHttp(
      {
        port: config.port,
        onListen: ({ hostname, port }) =>
          log.info("Listening", {
            address: `http://${hostname}:${port}`,
            publicUrl: config.publicUrl,
            version: VERSION,
            dev: config.dev || undefined,
          }),
      },
      app,
    );
  } catch (error) {
    storage.close();
    if (!((error as NodeJS.ErrnoException).code === "EADDRINUSE")) throw error;
    log.error(`Port ${config.port} is already in use. Stop what uses it, or set PORT.`);
    return 1;
  }

  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  const stop = async (signal: string) => {
    // `bun run --watch` sends SIGTERM after a Ctrl-C: once is enough. The deadline ends a
    // shutdown that hangs, such as on a client that never finishes its request; the exit
    // then closes what is still open.
    if (stopping) return;
    stopping = true;
    log.info("Shutting down", { signal, inFlight: inFlight.count });
    if (!(await stopServer(server, inFlight))) {
      log.warn("Stopped waiting for the requests in flight", { inFlight: inFlight.count });
    }
    storage.close();
    log.info("Stopped");
    stopped.resolve();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    try {
      process.on(signal, () => void stop(signal));
    } catch {
      // Windows has no SIGTERM.
    }
  }
  // Not `server.finished`: a connection left open would keep it waiting forever.
  await stopped.promise;
  return 0;
}

/** The service, on local or Cloudflare storage. */
interface OpenStorage {
  kind: "local" | "cloudflare";
  service: ServiceApi;
  /** Stops the host's timers and closes local storage when present. */
  close(): void;
  /** Local storage: consistent copies for backup downloads, and a folder for temporary files. */
  backups?: {
    snapshotTo(path: string): Promise<void>;
    tempDir: string;
    store?: Store;
  };
  /** `SECRET_KEY`, or the key local storage generated: it signs the session cookies. */
  secretKey?: string;
}

/**
 * Cloudflare storage when `SERVICES_URL` is set, local storage otherwise; or null after
 * explaining why it can't be used.
 */
async function openStorage(
  config: Config,
  log: Logger,
  options: { backups?: boolean; llm?: boolean; hint?: string; requireAnswer?: boolean } = {},
): Promise<OpenStorage | null> {
  if (config.cloudflare) {
    const cloud = await startCloudflareService({
      logger: log,
      backups: options.backups,
      dev: config.dev,
    });
    return {
      kind: "cloudflare",
      service: cloud.service,
      close: cloud.close,
      secretKey: cloud.secretKey,
    };
  }
  if (config.servicesUrl) {
    try {
      const service = await connectRemoteService(config, log, {
        requireAnswer: options.requireAnswer,
      });
      return {
        kind: "cloudflare",
        service,
        close() {},
        secretKey: config.secretKey ?? undefined,
      };
    } catch (error) {
      if (!(error instanceof RemoteSetupError)) throw error;
      console.error(error.message);
      return null;
    }
  }
  const local = await openOrExplain(config, log, options);
  return (
    local && {
      kind: "local",
      service: local.service,
      close: () => local.storage.close(),
      backups: {
        snapshotTo: local.storage.snapshotTo,
        tempDir: local.storage.tempDir,
        store: local.storage.store,
      },
      secretKey: local.secretKey,
    }
  );
}

/** Opens local storage and starts the service, or explains why it can't and returns null. */
async function openOrExplain(
  config: Config,
  log: Logger,
  options: { backups?: boolean; llm?: boolean; hint?: string } = {},
) {
  try {
    return await startLocalService(config, log, options);
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    console.error(options.hint ? `${error.message} ${options.hint}` : error.message);
    return null;
  }
}

/** Exit code 0 when `/healthz` on PORT answers `{ ok: true }`. */
export async function healthcheck(env: Env): Promise<number> {
  const port = Number(env.PORT?.trim() || 8000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok === true) {
      console.log("healthy");
      return 0;
    }
    console.error(`unhealthy: HTTP ${response.status}`);
  } catch (error) {
    console.error(`unhealthy: ${(error as Error).message}`);
  }
  return 1;
}

/** `token create --name <name> --scope read|upload` */
async function token(config: Config, log: Logger, args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  const flags = parseFlags(rest);
  const input = validate(CreateApiTokenRequest, { name: flags.name, scope: flags.scope });
  if (!input.ok) {
    for (const issue of input.issues) console.error(`--${formatIssue(issue)}`);
  }
  if (subcommand !== "create" || !input.ok) {
    console.error("Usage: quaso token create --name <name> --scope read|upload");
    return 2;
  }
  const storage = await openStorage(config, log, {
    hint: "Stop it first (docker compose stop quaso), then run this command again.",
    requireAnswer: true,
  });
  if (!storage) return 1;
  try {
    const created = await storage.service.createApiToken(SYSTEM, input.value);
    console.error(
      `Created the API key "${created.name}" with the ${created.scope} scope. ` +
        "Keep it somewhere safe: it is shown only once.",
    );
    console.log(created.secret);
    return 0;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    const detail = error instanceof ServiceTransportError ? ` (${error.detail})` : "";
    console.error(`Couldn't create the API key: ${error.message}${detail}`);
    return 1;
  } finally {
    storage.close();
  }
}

/**
 * `restore <file>`: a backup (a SQLite file, or JSON, gzip-compressed or not) into a new,
 * empty instance: the data folder, while the server is stopped (this takes its lock), or
 * Cloudflare storage with `SERVICES_URL` (the Durable Object must be empty).
 */
async function restore(config: Config, log: Logger, args: string[]): Promise<number> {
  const [file, ...extra] = args.filter((arg) => arg !== "--");
  if (file === undefined || extra.length > 0 || file.startsWith("--")) {
    console.error("Usage: quaso restore <file>   (a .sqlite, .json or .json.gz backup)");
    return 2;
  }
  if (
    !(await fs.stat(file).then(
      (info) => info.isFile(),
      () => false,
    ))
  ) {
    console.error(`There is no backup file at ${file}.`);
    return 1;
  }
  const storage = await openStorage(config, log, {
    hint: "Stop it first (docker compose stop quaso), then run this command again.",
    requireAnswer: true,
  });
  if (!storage) return 1;
  try {
    const where = storage.kind === "local" ? config.dataDir : config.servicesUrl;
    console.error(`Restoring ${file} into ${where}…`);
    const result = await restoreFile(storage.service, file, { tempDir: storage.backups?.tempDir });
    const rows = Object.values(result.tables).reduce((sum, n) => sum + n, 0);
    const migrated =
      result.schemaVersion.from === result.schemaVersion.to
        ? ""
        : `, migrated from schema version ${result.schemaVersion.from} to ${result.schemaVersion.to}`;
    console.error(
      `Restored ${rows} rows in ${Object.keys(result.tables).length} tables${migrated}. ` +
        "People sign in again: sessions aren't part of backups. Their passwords work with " +
        "the SECRET_KEY of the instance the backup comes from.",
    );
    if (result.missingSecrets.length > 0) {
      console.error(
        `Enter these credentials again in Settings: ${result.missingSecrets.join(", ")}.`,
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    const detail = error instanceof ServiceTransportError ? ` (${error.detail})` : "";
    console.error(`Couldn't restore ${file}: ${error.message}${detail}`);
    return 1;
  } finally {
    storage.close();
  }
}

/** `seed-dev`: the demo project, in a new development database. */
async function seedDev(config: Config, log: Logger): Promise<number> {
  if (!config.dev) {
    console.error("seed-dev only runs on a development instance (QUASO_DEV=1).");
    return 2;
  }
  if (config.cloudflare || config.servicesUrl) {
    console.error("seed-dev only seeds local storage.");
    return 2;
  }
  if (
    !(await fs.stat(demoDir()).then(
      () => true,
      () => false,
    ))
  ) {
    console.error(`seed-dev runs from the repository: ${demoDir()} is missing.`);
    return 1;
  }
  const local = await openOrExplain(config, log);
  if (!local) return 1;
  try {
    if (!local.created) {
      console.error(`${config.dataDir} already has a project. To start again: bun run dev:reset`);
      return 1;
    }
    const { apiKey, upload, imports } = await seedDemo(local.service, demoDir(), {
      people: true,
    });
    const file = join(config.dataDir, DEV_KEY_FILE);
    await fs.writeFile(file, apiKey + "\n", { mode: 0o600 });
    const imported = imports.map((result) => `${result.imported} in ${result.language}`);
    console.error(
      `Seeded the demo project: ${upload.files.length} files, with translations imported ` +
        `(${imported.join(", ")}). The development API key is in ${file}.`,
    );
    return 0;
  } finally {
    local.storage.close();
  }
}

/** `--name value` and `--name=value` flags. */
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!match) continue;
    if (match[2] !== undefined) flags[match[1]] = match[2];
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) flags[match[1]] = args[++i];
    else flags[match[1]] = "";
  }
  return flags;
}
