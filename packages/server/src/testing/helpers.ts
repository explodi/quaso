// SPDX-License-Identifier: MIT
/** Helpers for the server's tests. */
import { assert } from "@quaso/runtime/assert";
import type { ServiceApi } from "@quaso/service";
import { type App, createApp } from "../app.ts";
import { type Config, type Env, loadConfig } from "../config.ts";
import { createLogger, type ServerLogger } from "../log.ts";

/** A valid config from test variables; the website folder doesn't exist unless given. */
export function testConfig(env: Env = {}): Config {
  const result = loadConfig(
    {
      DATA_DIR: "/nonexistent/quaso-data",
      WEB_DIR: "/nonexistent/quaso-web",
      SETUP_KEY: "test-setup-key-long-enough",
      ...env,
    },
    { cwd: "/" },
  );
  assert(result.ok, result.ok ? "" : result.problems.join("\n"));
  return result.config;
}

/** A logger that keeps its lines, parsed. */
export function memoryLogger(): ServerLogger & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(JSON.parse(line)) });
  return Object.assign(logger, { lines });
}

/** The app around a service, with a memory logger. */
export function testApp(
  service: ServiceApi,
  env: Env = {},
): { app: App; log: ReturnType<typeof memoryLogger> } {
  const log = memoryLogger();
  return { app: createApp({ config: testConfig(env), service, log, version: "9.9.9" }), log };
}

/** Calls the app with a request to `http://quaso.test` + path. */
export function call(
  app: App,
  path: string,
  init: RequestInit & { json?: unknown; key?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app(new Request(`http://quaso.test${path}`, { ...init, headers, body }), {
    remoteAddr: { hostname: "192.0.2.1" },
  });
}
