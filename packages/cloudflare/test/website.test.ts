// SPDX-License-Identifier: MIT
/**
 * The website from the Worker's static assets (test/website), and `/wake`, which says whether
 * the server is ready: neither waits for the container.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/worker.ts";
import { env } from "./env.ts";

async function call(path: string, bindings: Env = env as unknown as Env, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://quaso.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    bindings,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, text };
}

/** Bindings with a container of its own, so that a test can set its startup status. */
function withOwnContainer() {
  const id = env.QUASO_CONTAINER.newUniqueId();
  const container = env.QUASO_CONTAINER.get(id);
  const bindings = {
    ...env,
    QUASO_CONTAINER: { idFromName: () => id, get: () => container },
  } as unknown as Env;
  return { container, bindings };
}

it("serves the website's HTML without the container, revalidated every time", async () => {
  const own = withOwnContainer();
  const page = await call("/", own.bindings);
  expect(page.status).toBe(200);
  expect(page.text).toContain('<div id="root">');
  expect(page.headers.get("Cache-Control")).toBe("no-cache");
  expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  expect(page.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  expect(await own.container.served()).toBe(0);
});

it("answers every page path with the website, as a single-page app", async () => {
  const page = await call("/sources/de/main.json");
  expect(page.status).toBe(200);
  expect(page.text).toContain('<div id="root">');
});

it("keeps build files for a year, and a missing one is a 404", async () => {
  const file = await call("/assets/app-test.js");
  expect(file.status).toBe(200);
  expect(file.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  const missing = await call("/assets/app-gone.js");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("Cache-Control")).toBe("no-cache");
});

it("serves the website's config.json from the build", async () => {
  const config = await call("/config.json");
  expect(JSON.parse(config.text)).toEqual({ apiBase: "/api/v1" });
});

it("sends the server's paths to the container", async () => {
  const own = withOwnContainer();
  await call("/healthz", own.bindings);
  await call("/auth/github", own.bindings);
  await call("/schema/config-v1.json", own.bindings);
  expect(await own.container.served()).toBe(3);
});

it("says the server is ready", async () => {
  const wake = await call("/wake");
  expect(JSON.parse(wake.text)).toEqual({ state: "ready" });
  expect(wake.headers.get("Cache-Control")).toBe("private, no-store");
});

it("says how far along a start is", async () => {
  const own = withOwnContainer();
  await own.container.setStartupStatus({
    state: "starting",
    elapsedMs: 12_000,
    expectedMs: 50_000,
  });
  const wake = await call("/wake", own.bindings);
  expect(JSON.parse(wake.text)).toEqual({
    state: "starting",
    elapsedMs: 12_000,
    expectedMs: 50_000,
  });
});

it("says the instance is paused during maintenance, and still serves the website", async () => {
  const paused = { ...env, QUASO_RESTORE_PAUSED: "true" } as unknown as Env;
  expect(JSON.parse((await call("/wake", paused)).text)).toEqual({ state: "paused" });
  expect((await call("/", paused)).status).toBe(200);
});
