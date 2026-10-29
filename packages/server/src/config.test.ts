// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { assert, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type Config, type Env, loadConfig, readEnvironment } from "./config.ts";

function config(env: Env): Config {
  const result = loadConfig(env, { cwd: "/srv/quaso", webDir: "/srv/quaso/web" });
  assert(result.ok, result.ok ? "" : result.problems.join("\n"));
  return result.config;
}

function problems(env: Env): string[] {
  const result = loadConfig(env, { cwd: "/srv/quaso", webDir: "/srv/quaso/web" });
  assert(!result.ok, "expected problems");
  return result.problems;
}

test("config: the defaults", () => {
  expect(config({})).toStrictEqual({
    dev: false,
    port: 8000,
    dataDir: "/data",
    publicUrl: "http://localhost:8000",
    domain: null,
    secretKey: null,
    setupKey: null,
    github: null,
    discord: null,
    turnstile: null,
    cloudflare: false,
    trustProxy: false,
    logLevel: "info",
    webDir: "/srv/quaso/web",
    corsOrigins: [],
  });
});

test("config: former retention variables cannot override saved settings", () => {
  expect(config({ BACKUP_RETENTION_DAYS: "invalid", FILE_HISTORY_DAYS: "1" })).toStrictEqual(
    config({}),
  );
});

test("config: development keeps its data in .quaso, relative to the working directory", () => {
  const dev = config({ QUASO_DEV: "1", PORT: "8123" });
  expect(dev.dev).toBe(true);
  expect(dev.dataDir).toBe("/srv/quaso/.quaso");
  expect(dev.publicUrl).toBe("http://localhost:8123");
  expect(config({ DATA_DIR: "data", WEB_DIR: "site" }).dataDir).toBe("/srv/quaso/data");
  expect(config({ WEB_DIR: "site" }).webDir).toBe("/srv/quaso/site");
});

test("config: PUBLIC_URL defaults to QUASO_DOMAIN over HTTPS", () => {
  expect(config({ QUASO_DOMAIN: "translate.example.com" }).publicUrl).toStrictEqual(
    "https://translate.example.com",
  );
  expect(
    config({ QUASO_DOMAIN: "translate.example.com", PUBLIC_URL: "https://quaso.example.org/" })
      .publicUrl,
  ).toBe("https://quaso.example.org");
});

test("config: every value is read and typed", () => {
  const all = config({
    QUASO_DOMAIN: "Translate.Example.com",
    SECRET_KEY: "k".repeat(64),
    SETUP_KEY: "setup",
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "email-key",
    EMAIL_FROM: "Quaso <quaso@example.com>",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    DISCORD_CLIENT_ID: "dc-id",
    DISCORD_CLIENT_SECRET: "dc-secret",
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "secret",
    TRUST_PROXY: "true",
    LOG_LEVEL: "debug",
    CORS_ORIGINS: "https://a.example.com, http://localhost:5173/",
  });
  expect(all.domain).toBe("translate.example.com");

  expect(all.github).toStrictEqual({ clientId: "gh-id", clientSecret: "gh-secret" });
  expect(all.discord).toStrictEqual({ clientId: "dc-id", clientSecret: "dc-secret" });
  expect(all.turnstile).toStrictEqual({ siteKey: "site", secretKey: "secret" });
  expect(all.trustProxy).toBe(true);
  expect(all.logLevel).toBe("debug");
  expect(all.corsOrigins).toStrictEqual(["https://a.example.com", "http://localhost:5173"]);
});

test("config: empty values count as not set, as in .env.example", () => {
  expect(config({ PORT: "", SECRET_KEY: "  ", EMAIL_PROVIDER: "" }).port).toBe(8000);
});

test("config: every problem is reported at once", () => {
  const found = problems({
    PORT: "80a",
    QUASO_DOMAIN: "https://translate.example.com",
    PUBLIC_URL: "https://example.com/quaso",
    SECRET_KEY: "short",
    TRUST_PROXY: "maybe",
    LOG_LEVEL: "loud",
    GITHUB_CLIENT_ID: "id-without-secret",
    EMAIL_PROVIDER: "carrier-pigeon",
    CORS_ORIGINS: "https://ok.example.com,not a url",
  });
  const text = found.join("\n");
  for (const name of [
    "PORT",
    "QUASO_DOMAIN",
    "PUBLIC_URL",
    "SECRET_KEY",
    "TRUST_PROXY",
    "LOG_LEVEL",
    "GITHUB_CLIENT_SECRET",
    "CORS_ORIGINS",
  ]) {
    expect(text).toContain(name);
  }
  expect(found.length).toBe(8);
  expect(text).toContain('PORT must be a whole number from 1 to 65535, not "80a".');
});

test("config: private Cloudflare storage needs no operator credentials", () => {
  expect(config({ QUASO_CLOUDFLARE: "1" }).cloudflare).toBe(true);
});

test("config: .env fills in what the environment doesn't set", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  const name = "QUASO_TEST_FROM_ENVIRONMENT";
  try {
    await fs.writeFile(
      join(dir, ".env"),
      `# A comment\n${name}=from-file\nQUASO_TEST_ONLY_IN_FILE="only in file"\n`,
    );
    process.env[name] = "from-environment";
    const env = await readEnvironment(dir);
    expect(env[name]).toBe("from-environment");
    expect(env.QUASO_TEST_ONLY_IN_FILE).toBe("only in file");
    expect(process.env["QUASO_TEST_ONLY_IN_FILE"]).toBe(undefined);
  } finally {
    delete process.env[name];
    await fs.rm(dir, { recursive: true });
  }
});

test("config: no .env file is fine", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  try {
    const env = await readEnvironment(dir);
    expect(env.PATH).toStrictEqual(process.env["PATH"]);
  } finally {
    await fs.rmdir(dir);
  }
});

test("config: former email variables are ignored", () => {
  expect(
    config({ EMAIL_PROVIDER: "invalid", EMAIL_API_KEY: "ignored", EMAIL_FROM: "invalid" }),
  ).toStrictEqual(config({}));
});

test("config: the former setup token variable is ignored", () => {
  expect(config({ SETUP_TOKEN: "old-setup-token" })).toStrictEqual(config({}));
});
