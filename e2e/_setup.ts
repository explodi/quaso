// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
/// <reference lib="dom" />
/**
 * Browser tests drive Chromium with Puppeteer and run the real application in-process.
 * Each test gets its own database and serves the built website with real security headers.
 *
 * Every page also collects problems: console errors and warnings, uncaught exceptions,
 * failed requests and CSP violations. Tests end by asserting there were none.
 */
import { type Browser, launch, type Page } from "puppeteer";
import { assert } from "@std/assert";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import type { ProjectInfo, SessionInfo, StringsPage, UploadResult } from "@quaso/core";
import { type Service, type ServiceOptions, SYSTEM, ANONYMOUS } from "@quaso/service";
import type { App } from "../packages/server/src/app.ts";
import type { Env } from "../packages/server/src/config.ts";
import { demoDir, readProjectFiles, seedDemo } from "../packages/server/src/dev_seed.ts";
import { testApp } from "../packages/server/src/testing/helpers.ts";
import { realService } from "../packages/server/src/testing/real_service.ts";

export const ROOT = fromFileUrl(new URL("..", import.meta.url));
export const WEB_DIST = join(ROOT, "packages/web/dist");

/** Everything the website is built from: a change in any of them makes the build stale. */
const WEB_SOURCES = [
  "packages/web/src",
  "packages/web/public",
  "packages/web/index.html",
  "packages/web/design.html",
  "packages/web/vite.config.ts",
  "packages/web/package.json",
  "packages/core/src",
  "packages/core/mod.ts",
];

async function newestChange(path: string): Promise<number> {
  const info = await fs.stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.mtime?.getTime() ?? 0;
  let newest = 0;
  for await (const entry of await fs.readdir(path, { withFileTypes: true })) {
    newest = Math.max(newest, await newestChange(join(path, entry.name)));
  }
  return newest;
}

let building: Promise<void> | undefined;

/** Builds the website with Vite, unless `packages/web/dist` is newer than every source. */
export function ensureWebsiteBuilt(): Promise<void> {
  return (building ??= (async () => {
    const built = await fs.stat(join(WEB_DIST, "index.html")).then(
      (info) => info.mtime?.getTime() ?? 0,
      () => 0,
    );
    const sources = Math.max(
      ...(await Promise.all(WEB_SOURCES.map((p) => newestChange(join(ROOT, p))))),
    );
    if (built > sources) return;
    console.log("Building the website (deno task build:web)…");
    const { success } = await new Deno.Command(Deno.execPath(), {
      args: ["task", "build:web"],
      cwd: ROOT,
      stdout: "null",
      stderr: "inherit",
    }).output();
    assert(success, "deno task build:web failed");
  })());
}

/** A signed-in manager, for the editor's writing interface before the accounts API exists. */
export const MANAGER_SESSION: SessionInfo = {
  user: {
    id: 1,
    email: "manager@example.com",
    displayName: "Mia Manager",
    avatarUrl: null,
    role: "manager",
    languages: null,
    emailVerified: true,
    hasPassword: true,
    identities: [],
    volunteerRequest: null,
    createdAt: 0,
  },
  setupRequired: false,
  dev: false,
  providers: { github: false, discord: false, email: false },
  humanCheck: null,
};

/** Signed out, on a server with accounts (email and password, and GitHub). */
export const SIGNED_OUT_SESSION: SessionInfo = {
  user: null,
  setupRequired: false,
  dev: false,
  providers: { github: true, discord: false, email: true },
  humanCheck: null,
};

/**
 * Answers a request instead of the server, or passes it on (`next`) and changes the answer;
 * `undefined` leaves it to the server. For endpoints the server doesn't have yet (the writes
 * of Sprint 6), and for failures that are hard to cause for real.
 */
export type Intercept = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Response | undefined | Promise<Response | undefined>;

/**
 * The server's answer to a GET of `url` (the request's own by default) as JSON, uncompressed,
 * for an intercept to change.
 */
export async function serverJson<T>(
  request: Request,
  next: (request: Request) => Promise<Response>,
  url: string | URL = request.url,
): Promise<T> {
  const headers = new Headers(request.headers);
  headers.delete("Accept-Encoding");
  const response = await next(new Request(url, { headers }));
  return (await response.json()) as T;
}

/** A JSON error in the API's shape. */
export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: { code, message, ...extra } },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export interface TestServer {
  url: string;
  /** An API key with the upload scope. */
  key: string;
  /** Real service for independent setup and explicit fake-translator alarm ticks. */
  service: Service;
  close(): Promise<void>;
  api<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface ServerOptions {
  /** Keep a fresh instance unclaimed for the first-administrator tests. */
  unclaimed?: boolean;
  /** Optional server features; the test's website folder and public URL are always used. */
  env?: Env;
  /**
   * Answers `GET /api/v1/auth/session` with this session instead of the server (which has no
   * accounts before Sprint 6), to test what signed-in people see. Everything else is real.
   */
  session?: SessionInfo;
  /** Upload the demo's English and import its translations (the development seed). */
  seed?: boolean;
  /** Sees every request first (before `session`). */
  intercept?: Intercept;
  serviceOptions?: Partial<ServiceOptions>;
  prepare?(service: Service): Promise<void>;
}

/** Starts the server with a new in-memory database, on a free port. */
export async function startServer(options: ServerOptions = {}): Promise<TestServer> {
  await ensureWebsiteBuilt();
  const real = await realService(options.serviceOptions);
  const token = await real.service.createApiToken(SYSTEM, {
    name: "Browser tests",
    scope: "upload",
  });
  if (options.seed) await seedDemo(real.service);
  await options.prepare?.(real.service);
  if (!options.unclaimed && (await real.service.getSession(SYSTEM, {})).setupRequired) {
    const project = await real.service.getProject(SYSTEM, {});
    const setup = await real.service.ensureSetupToken(SYSTEM, {});
    await real.service.completeSetup(ANONYMOUS, {
      token: setup.token!,
      email: "browser-fixture-owner@example.com",
      displayName: "Browser Fixture Owner",
      password: crypto.randomUUID(),
      projectName: project.name,
      sourceLanguage: project.sourceLanguage,
    });
  }
  // The browser's real origin is known once Deno chooses the ephemeral port. Use it for
  // CSRF checks and one-time links, just as a deployed instance uses PUBLIC_URL.
  const handler: App = async (request, info) => {
    const next = (r: Request) => app(r, info);
    const intercepted = await options.intercept?.(request, next);
    if (intercepted) return intercepted;
    if (options.session) {
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store" };
      if (url.pathname === "/api/v1/auth/session")
        return Response.json(options.session, { headers });
      // A mocked session has no server cookie; real signed-in tests exercise job polling.
      const activeJobs =
        url.pathname === "/api/v1/jobs" && url.searchParams.get("active") === "true";
      if (activeJobs) return Response.json({ jobs: [] }, { headers });
    }
    return await next(request);
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request, info) =>
    handler(request, { remoteAddr: { hostname: info.remoteAddr.hostname } }),
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  const { app } = testApp(real.service, { ...options.env, WEB_DIR: WEB_DIST, PUBLIC_URL: url });
  return {
    url,
    key: token.secret,
    service: real.service,
    async api<T>(path: string, init: RequestInit = {}): Promise<T> {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token.secret}`);
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`${url}/api/v1${path}`, { ...init, headers });
      const body = await response.json();
      assert(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
      return body as T;
    },
    async close() {
      await server.shutdown();
      real.close();
    },
  };
}

/** Uploads the demo game's English files, as `quaso upload` does. */
export async function uploadDemo(server: TestServer): Promise<UploadResult> {
  const { config, sources } = await readProjectFiles(demoDir());
  return await server.api<UploadResult>("/sources", {
    method: "POST",
    body: JSON.stringify({
      files: sources,
      sourceLanguage: config.sourceLanguage,
      languages: config.languages,
      limits: config.limits,
    }),
  });
}

export function getProject(server: TestServer): Promise<ProjectInfo> {
  return server.api<ProjectInfo>("/project");
}

/** Every string of a language, from the API. */
export function getStrings(server: TestServer, language: string, query = ""): Promise<StringsPage> {
  return server.api<StringsPage>(`/strings?language=${language}&limit=500${query}`);
}

/** Launches headless Chromium (downloaded by Puppeteer on first use). */
export async function openBrowser(): Promise<Browser> {
  // GitHub's Ubuntu runners don't let Chromium use its sandbox.
  const args = process.env["CI"] ? ["--no-sandbox"] : [];
  return await launch({ headless: true, args });
}

export interface Tab {
  page: Page;
  /** Console errors and warnings, exceptions, failed requests and CSP violations. */
  problems: string[];
}

const pageProblems = new WeakMap<Page, string[]>();

/**
 * Requests that are expected to fail for now, until the server has accounts (Sprint 6):
 * `/api/v1/auth/session` answers 404, which the website takes as signed out, and so does
 * the invite check on the sign-up page, which the website then leaves out.
 */
const EXPECTED = [
  /status of 404 .*\/api\/v1\/auth\/session\)$/,
  /status of 404 .*\/api\/v1\/invites\/[^/]+\)$/,
];

/**
 * Opens a page that records every problem, and goes to `path` on the server. `setup` runs
 * before the page loads (to emulate a platform or a window size, say).
 */
export async function openTab(
  browser: Browser,
  server: Pick<TestServer, "url">,
  path: string,
  setup?: (page: Page) => Promise<void>,
): Promise<Tab> {
  const page = await browser.newPage();
  await setup?.(page);
  const problems: string[] = [];
  pageProblems.set(page, problems);
  const celestial = await page.createCDPSession();
  // Headless windows may be occluded by the host. Exercise the visible, focused state
  // that keyboard users have, including animation frames and visibility-aware polling.
  await celestial.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await celestial.send("Log.enable");
  celestial.on("Log.entryAdded", (event) => {
    const { level, text, url, source } = event.entry;
    if (level !== "error" && level !== "warning") return;
    const line = `${source} ${level}: ${text}${url ? ` (${url})` : ""}`;
    if (!EXPECTED.some((pattern) => pattern.test(line))) problems.push(line);
  });
  // CSP violations also reach the console, but record them explicitly too.
  await celestial.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `document.addEventListener("securitypolicyviolation", (e) =>
      console.error("CSP violation: " + e.violatedDirective + " blocked " + e.blockedURI));`,
  });
  page.on("console", (event) => {
    const type = event.type();
    const text = event.text();
    // CDP's network log already records resource failures with their URL.
    if (text.startsWith("Failed to load resource:")) return;
    const url = event.location().url;
    if (type === "error" || type === "warn") {
      problems.push(`console ${type}: ${text}${url ? ` (${url})` : ""}`);
    }
  });
  page.on("pageerror", (event) => problems.push(`exception: ${String(event)}`));
  await page.goto(`${server.url}${path}`, { waitUntil: "networkidle0" });
  return { page, problems };
}

/** Waits until `fn` returns a truthy value in the page. */
export async function waitFor<T, A extends unknown[]>(
  page: Page,
  fn: (...args: A) => T,
  args: A = [] as unknown as A,
  timeout = 10_000,
): Promise<T> {
  const until = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < until) {
    last = (await page.evaluate(fn as (...args: any[]) => T, ...args)) as T;
    if (last) return last;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `Timed out waiting for ${fn.toString().slice(0, 200)} (last: ${JSON.stringify(
      last,
    )}). Browser: ${pageProblems.get(page)?.join("; ")}. Page: ${await page.evaluate(() =>
      document.body.textContent?.slice(0, 4000),
    )}`,
  );
}

/** The page's text content, for assertions. */
export function text(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (s: string) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    selector,
  );
}

/** Presses a key, with modifiers held. */
export async function press(
  page: Page,
  key: string,
  modifiers: ("Alt" | "Control" | "Meta" | "Shift")[] = [],
) {
  const k = key as any;
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(k);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

/**
 * Sends one key as the browser gets it from the system: `key` is what the layout makes of
 * it (`{` for Option+8 on a German Mac), `code` the physical key, `text` what it types.
 */
export async function sendKey(
  page: Page,
  init: {
    key: string;
    code: string;
    text?: string;
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    keyCode?: number;
  },
) {
  const modifiers =
    (init.alt ? 1 : 0) | (init.ctrl ? 2 : 0) | (init.meta ? 4 : 0) | (init.shift ? 8 : 0);
  const input = await page.createCDPSession();
  const common = {
    modifiers,
    key: init.key,
    code: init.code,
    windowsVirtualKeyCode: init.keyCode,
    nativeVirtualKeyCode: init.keyCode,
  };
  await input.send("Input.dispatchKeyEvent", {
    type: init.text ? "keyDown" : "rawKeyDown",
    ...common,
    text: init.text,
    unmodifiedText: init.text,
  });
  await input.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Makes the page believe it runs on a Mac (`navigator.platform`), before it loads. */
export async function emulateMac(page: Page) {
  // Puppeteer re-applies its own override after each navigation; a raw CDP one doesn't.
  const userAgent = await page.browser().userAgent();
  await page.setUserAgent({ userAgent, platform: "MacIntel" });
}

/** Where the page is: its path and query. */
export function pagePath(page: Page): Promise<string> {
  return page.evaluate(() => location.pathname + location.search);
}

/** Runs a browser test: a server, a browser, and cleanup, whatever happens. */
export function browserTest(
  name: string,
  options: ServerOptions,
  fn: (context: { server: TestServer; browser: Browser }) => Promise<void>,
): void {
  test(name, { timeout: 60000 }, async () => {
    const server = await startServer(options);
    let browser: Browser | undefined;
    try {
      browser = await openBrowser();
      await fn({ server, browser });
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
