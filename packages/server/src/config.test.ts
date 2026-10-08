// SPDX-License-Identifier: MIT
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
  assertEquals(config({}), {
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
    servicesUrl: null,
    serviceToken: null,
    cloudflare: false,
    trustProxy: false,
    logLevel: "info",
    webDir: "/srv/quaso/web",
    corsOrigins: [],
    locationHint: null,
  });
});

test("config: former retention variables cannot override saved settings", () => {
  assertEquals(config({ BACKUP_RETENTION_DAYS: "invalid", FILE_HISTORY_DAYS: "1" }), config({}));
});

test("config: development keeps its data in .quaso, relative to the working directory", () => {
  const dev = config({ QUASO_DEV: "1", PORT: "8123" });
  assertEquals(dev.dev, true);
  assertEquals(dev.dataDir, "/srv/quaso/.quaso");
  assertEquals(dev.publicUrl, "http://localhost:8123");
  assertEquals(config({ DATA_DIR: "data", WEB_DIR: "site" }).dataDir, "/srv/quaso/data");
  assertEquals(config({ WEB_DIR: "site" }).webDir, "/srv/quaso/site");
});

test("config: PUBLIC_URL defaults to QUASO_DOMAIN over HTTPS", () => {
  assertEquals(
    config({ QUASO_DOMAIN: "translate.example.com" }).publicUrl,
    "https://translate.example.com",
  );
  assertEquals(
    config({ QUASO_DOMAIN: "translate.example.com", PUBLIC_URL: "https://quaso.example.org/" })
      .publicUrl,
    "https://quaso.example.org",
  );
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
    LOCATION_HINT: "weur",
  });
  assertEquals(all.domain, "translate.example.com");

  assertEquals(all.github, { clientId: "gh-id", clientSecret: "gh-secret" });
  assertEquals(all.discord, { clientId: "dc-id", clientSecret: "dc-secret" });
  assertEquals(all.turnstile, { siteKey: "site", secretKey: "secret" });
  assertEquals(all.trustProxy, true);
  assertEquals(all.logLevel, "debug");
  assertEquals(all.corsOrigins, ["https://a.example.com", "http://localhost:5173"]);
  assertEquals(all.locationHint, "weur");
});

test("config: empty values count as not set, as in .env.example", () => {
  assertEquals(config({ PORT: "", SECRET_KEY: "  ", EMAIL_PROVIDER: "" }).port, 8000);
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
    LOCATION_HINT: "moon",
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
    "LOCATION_HINT",
  ]) {
    assertStringIncludes(text, name);
  }
  assertEquals(found.length, 9);
  assertStringIncludes(text, 'PORT must be a whole number from 1 to 65535, not "80a".');
});

test("config: Cloudflare storage needs SERVICE_TOKEN and SECRET_KEY", () => {
  const found = problems({ SERVICES_URL: "https://quaso.example.workers.dev" });
  assertEquals(found.length, 2);
  assertStringIncludes(found.join("\n"), "SERVICE_TOKEN is required with SERVICES_URL");
  assertStringIncludes(found.join("\n"), "SECRET_KEY is required with SERVICES_URL");
  const ok = config({
    SERVICES_URL: "https://quaso.example.workers.dev/",
    SERVICE_TOKEN: "token",
    SECRET_KEY: "s".repeat(32),
  });
  assertEquals(ok.servicesUrl, "https://quaso.example.workers.dev");
});

test("config: private Cloudflare storage needs no operator credentials", () => {
  const privateStorage = config({ QUASO_CLOUDFLARE: "1" });
  assertEquals(privateStorage.cloudflare, true);
  assertEquals(privateStorage.serviceToken, null);
  assertEquals(privateStorage.servicesUrl, null);
  assertStringIncludes(
    problems({
      QUASO_CLOUDFLARE: "1",
      SECRET_KEY: "s".repeat(32),
      SERVICES_URL: "https://quaso.test/internal",
      SERVICE_TOKEN: "legacy",
    }).join("\n"),
    "cannot be combined with private Cloudflare storage",
  );
});

test("config: .env fills in what the environment doesn't set", async () => {
  const dir = await Deno.makeTempDir();
  const name = "QUASO_TEST_FROM_ENVIRONMENT";
  try {
    await fs.writeFile(
      join(dir, ".env"),
      `# A comment\n${name}=from-file\nQUASO_TEST_ONLY_IN_FILE="only in file"\n`,
    );
    process.env[name] = "from-environment";
    const env = await readEnvironment(dir);
    assertEquals(env[name], "from-environment");
    assertEquals(env.QUASO_TEST_ONLY_IN_FILE, "only in file");
    assertEquals(process.env["QUASO_TEST_ONLY_IN_FILE"], undefined);
  } finally {
    delete process.env[name];
    await fs.rm(dir, { recursive: true });
  }
});

test("config: no .env file is fine", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = await readEnvironment(dir);
    assertEquals(env.PATH, process.env["PATH"]);
  } finally {
    await fs.rmdir(dir);
  }
});

test("config: former email variables are ignored", () => {
  assertEquals(
    config({ EMAIL_PROVIDER: "invalid", EMAIL_API_KEY: "ignored", EMAIL_FROM: "invalid" }),
    config({}),
  );
});

test("config: the former setup token variable is ignored", () => {
  assertEquals(config({ SETUP_TOKEN: "old-setup-token" }), config({}));
});
