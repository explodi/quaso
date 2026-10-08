// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The server's settings (design §5.12). Every setting is an environment variable; an
 * optional `.env` file in the working directory fills in those that aren't set.
 * `loadConfig` checks them all at once and reports every problem together, so an operator
 * fixes their `.env` in one go.
 */
import { parse as parseDotenv } from "@std/dotenv";
import { fileURLToPath as fromFileUrl } from "node:url";
import { resolve } from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** A development instance (`QUASO_DEV=1`, set by `deno task dev`). */
  dev: boolean;
  port: number;
  /** Absolute. */
  dataDir: string;
  /** The public address, without a trailing slash, such as `https://translate.yourgame.com`. */
  publicUrl: string;
  domain: string | null;
  /** Null with local storage when not set: the server generates one in the data folder. */
  secretKey: string | null;
  setupKey: string | null;
  github: { clientId: string; clientSecret: string } | null;
  discord: { clientId: string; clientSecret: string } | null;
  turnstile: { siteKey: string; secretKey: string } | null;
  /** Set by the Cloudflare container controller; storage uses fixed private hostnames. */
  cloudflare: boolean;
  trustProxy: boolean;
  logLevel: LogLevel;
  /** The built website. Absolute. */
  webDir: string;
  /** Other origins the API accepts requests from, with credentials. */
  corsOrigins: string[];
}

/** Environment variables by name. */
export type Env = Record<string, string | undefined>;

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

export interface ConfigOptions {
  /** Relative paths resolve against it. Default: the working directory. */
  cwd?: string;
  /** Default: `packages/web/dist` next to the source, or inside the compiled binary. */
  webDir?: string;
}

/**
 * The website's build, next to the server's source. `deno compile --include` keeps that
 * path inside the binary too.
 */
export function defaultWebDir(): string {
  return fromFileUrl(new URL("../../web/dist", import.meta.url));
}

/**
 * The environment: the process's variables, with those of `.env` in `cwd` added where the
 * process doesn't set them.
 */
export async function readEnvironment(cwd = process.cwd()): Promise<Env> {
  let fromFile: Env = {};
  try {
    fromFile = parseDotenv(await fs.readFile(resolve(cwd, ".env"), "utf8"));
  } catch (error) {
    if (!((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  return { ...fromFile, ...{ ...process.env } };
}

/** Reads and checks every setting. Empty values count as not set. */
export function loadConfig(env: Env, options: ConfigOptions = {}): ConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const read = new Reader(env);

  const dev = read.boolean("QUASO_DEV", false);
  const port = read.integer("PORT", 8000, 1, 65535);
  const domain = read.hostname("QUASO_DOMAIN");
  const publicUrl =
    read.origin("PUBLIC_URL") ?? (domain ? `https://${domain}` : `http://localhost:${port}`);

  const cloudflare = read.boolean("QUASO_CLOUDFLARE", false);
  const secretKey = read.string("SECRET_KEY");
  if (secretKey !== null && secretKey.length < 32) {
    read.problem("SECRET_KEY", "must be at least 32 characters long (openssl rand -hex 32)");
  }

  const config: Config = {
    dev,
    port,
    dataDir: resolve(cwd, read.string("DATA_DIR") ?? (dev ? ".quaso" : "/data")),
    publicUrl,
    domain,
    secretKey,
    setupKey: read.string("SETUP_KEY"),
    github: read.pair("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "clientId", "clientSecret"),
    discord: read.pair("DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "clientId", "clientSecret"),
    turnstile: read.pair("TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "siteKey", "secretKey"),
    cloudflare,
    trustProxy: read.boolean("TRUST_PROXY", false),
    logLevel: read.oneOf("LOG_LEVEL", LOG_LEVELS) ?? "info",
    webDir: resolve(cwd, read.string("WEB_DIR") ?? options.webDir ?? defaultWebDir()),
    corsOrigins: read.origins("CORS_ORIGINS"),
  };
  return read.problems.length > 0 ? { ok: false, problems: read.problems } : { ok: true, config };
}

/** Reads variables and collects problems, as sentences that start with the name. */
class Reader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  problem(name: string, message: string): void {
    this.problems.push(`${name} ${message}.`);
  }

  has(name: string): boolean {
    return this.string(name) !== null;
  }

  /** The trimmed value, or null when missing or empty. */
  string(name: string): string | null {
    const value = this.env[name]?.trim();
    return value ? value : null;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const value = this.string(name);
    if (value === null) return fallback;
    const number = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      this.problem(name, `must be a whole number from ${min} to ${max}, not "${value}"`);
      return fallback;
    }
    return number;
  }

  number(name: string, fallback: number, min: number, max: number): number {
    const value = this.string(name);
    if (value === null) return fallback;
    const number = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < min || number > max) {
      this.problem(name, `must be a number from ${min} to ${max}, not "${value}"`);
      return fallback;
    }
    return number;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.string(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    this.problem(name, `must be true or false, not "${this.string(name)}"`);
    return fallback;
  }

  oneOf<const T extends string>(name: string, values: readonly T[]): T | null {
    const value = this.string(name);
    if (value === null) return null;
    if ((values as readonly string[]).includes(value)) return value as T;
    this.problem(name, `must be one of ${values.join(", ")}, not "${value}"`);
    return null;
  }

  /** A host name, such as `translate.yourgame.com`, without a scheme or path. */
  hostname(name: string): string | null {
    const value = this.string(name);
    if (value === null) return null;
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(value)
    ) {
      this.problem(name, `must be a host name such as translate.yourgame.com, not "${value}"`);
      return null;
    }
    return value.toLowerCase();
  }

  /** An origin, such as `https://translate.yourgame.com`, without a path. */
  origin(name: string): string | null {
    const value = this.string(name);
    return value === null ? null : this.checkOrigin(name, value);
  }

  /** A comma-separated list of origins. */
  origins(name: string): string[] {
    const value = this.string(name);
    if (value === null) return [];
    const origins: string[] = [];
    for (const item of value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const origin = this.checkOrigin(name, item);
      if (origin) origins.push(origin);
    }
    return origins;
  }

  /** Both variables, or neither. */
  pair<A extends string, B extends string>(
    first: string,
    second: string,
    a: A,
    b: B,
  ): Record<A | B, string> | null {
    if (!this.together(first, second)) return null;
    return { [a]: this.string(first), [b]: this.string(second) } as Record<A | B, string>;
  }

  /** Whether all the variables are set; a problem if only some are. */
  together(...names: string[]): boolean {
    const missing = names.filter((name) => !this.has(name));
    if (missing.length === 0) return true;
    if (missing.length < names.length) {
      this.problem(missing.join(", "), `must be set too, with ${names.join(", ")}`);
    }
    return false;
  }

  private checkOrigin(name: string, value: string): string | null {
    const url = URL.parse(value);
    const trimmed = value.replace(/\/$/, "");
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== trimmed) {
      this.problem(
        name,
        `must be an address such as https://translate.yourgame.com, without a path, not "${value}"`,
      );
      return null;
    }
    return url.origin;
  }
}
