// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
/**
 * Accounts, roles and review through the HTTP API, with the real service (Sprint 6):
 * setup, sign-up, sign-in and sign-out with the session cookie, the Origin check, rate
 * limits, session renewal, email links, the team, and acceptance tests 4, 9 (the person
 * path) and 10.
 */
import type { ExportResult, SessionInfo, StringsPage, SuggestionInfo } from "@quaso/core";
import { type Service, SYSTEM } from "@quaso/service";
import { type App, createApp } from "./app.ts";
import type { Env } from "./config.ts";
import { contentSecurityPolicy } from "./http/headers.ts";
import { memoryLogger, testConfig } from "./testing/helpers.ts";
import { realService } from "./testing/real_service.ts";

const ORIGIN = "http://localhost:8000";
const PASSWORD = "correct horse battery";

/** A browser: keeps the session cookie, and sends the site's Origin with writes. */
class Browser {
  cookie: string | null = null;
  readonly app: App;
  readonly ip: string;
  readonly origin: string | null;
  constructor(app: App, ip = "192.0.2.1", origin: string | null = ORIGIN) {
    this.app = app;
    this.ip = ip;
    this.origin = origin;
  }

  async request(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.json === undefined ? "GET" : "POST");
    const headers = new Headers(init.headers);
    if (method !== "GET" && this.origin && !headers.has("Origin")) {
      headers.set("Origin", this.origin);
    }
    if (this.cookie) headers.set("Cookie", `quaso_session=${this.cookie}`);
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    const response = await this.app(new Request(`${ORIGIN}${path}`, { method, headers, body }), {
      remoteAddr: { hostname: this.ip },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const match = cookie.match(/^quaso_session=([^;]*)/);
      if (match) this.cookie = match[1] === "" ? null : match[1];
    }
    return response;
  }

  /** The JSON of a response with the expected status. */
  async json<T = Record<string, unknown>>(
    path: string,
    init: Parameters<Browser["request"]>[1] = {},
    status = 200,
  ): Promise<T> {
    const response = await this.request(path, init);
    const text = await response.text();
    expect(response.status, `${init.method ?? "GET"} ${path}: ${text}`).toStrictEqual(status);
    return text === "" ? (undefined as T) : JSON.parse(text);
  }
}

interface Instance {
  app: App;
  /** The server's clock (session tokens and rate limits), which only moves when told to. */
  clock: { now: number };
  service: Service;
  admin: Browser;
  /** An upload key, for the CLI's calls. */
  key: string;
  emails: { to: string; subject: string; text: string }[];
  /**
   * The emails sent so far, once there are `count`: links go out after the answer, so an
   * answer never waits for the email API (S6.4).
   */
  sent(count: number): Promise<Instance["emails"]>;
  /** Holds the email API's answers until the function returned is called. */
  holdEmails(): () => void;
  browser(ip?: string): Browser;
  close(): void;
}

const ENGLISH = {
  play: "Play",
  quit: "Quit",
  greeting: "Hello, {{name}}!",
  items_one: "{{count}} item",
  items_other: "{{count}} items",
};

/** A set-up instance (an administrator signed in) with `common.json` in French and German. */
async function instance(env: Env = {}): Promise<Instance> {
  const emails: Instance["emails"] = [];
  let held: Promise<void> | null = null;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://api.resend.com/emails") {
      await held;
      const body = await request.json();
      emails.push({ to: body.to[0], subject: body.subject, text: body.text });
      return Response.json({ id: "email" });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  const real = await realService({ emailFetch: fetch });
  const clock = { now: Date.UTC(2026, 8, 24, 12) };
  const app = createApp({
    config: testConfig(env),
    service: real.service,
    log: memoryLogger(),
    secretKey: "s".repeat(32),
    fetch,
    now: () => clock.now,
  });
  const admin = new Browser(app, "192.0.2.100");
  const { token } = await real.service.ensureSetupToken(SYSTEM, {});
  await admin.json("/api/v1/auth/setup", {
    json: {
      token,
      email: "admin@example.com",
      password: PASSWORD,
      displayName: "Admin",
      projectName: "Quaso Quest",
    },
  });
  const key = await admin.json<{ secret: string }>(
    "/api/v1/api-tokens",
    {
      json: { name: "CI", scope: "upload" },
    },
    201,
  );
  await admin.json("/api/v1/sources", {
    json: {
      files: [
        {
          path: "common.json",
          repoPath: "common.json",
          content: JSON.stringify(ENGLISH, null, 2) + "\n",
        },
      ],
      languages: ["fr", "de"],
    },
    headers: { Authorization: `Bearer ${key.secret}` },
  });
  let ips = 0;
  return {
    app,
    clock,
    service: real.service,
    admin,
    key: key.secret,
    emails,
    async sent(count) {
      for (let waited = 0; emails.length < count && waited < 2000; waited += 5) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Anything more would show up by now too.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return emails;
    },
    holdEmails() {
      const gate = Promise.withResolvers<void>();
      held = gate.promise;
      return () => {
        held = null;
        gate.resolve();
      };
    },
    browser: (ip = `192.0.2.${++ips}`) => new Browser(app, ip),
    close: real.close,
  };
}

async function stringId(browser: Browser, key: string): Promise<number> {
  const page = await browser.json<StringsPage>(`/api/v1/strings?language=fr&limit=500`);
  return page.strings.find((s) => s.key === key)!.id;
}

async function frenchFile(s: Instance): Promise<Record<string, unknown>> {
  const result = await s.browser().json<ExportResult>("/api/v1/export?languages=fr", {
    headers: { Authorization: `Bearer ${s.key}` },
  });
  return JSON.parse(result.files.find((f) => f.language === "fr")!.content);
}

/** Signs up a visitor and returns their browser and ID. */
async function signUp(s: Instance, email: string, displayName: string, extra: object = {}) {
  const browser = s.browser();
  const session = await browser.json<SessionInfo>("/api/v1/auth/signup", {
    json: { email, password: PASSWORD, displayName, ...extra },
  });
  return { browser, id: session.user!.id };
}

test("accounts API: first start, then sign-up, sign-in and sign-out with the cookie", async () => {
  const real = await realService();
  try {
    const app = createApp({
      config: testConfig(),
      service: real.service,
      log: memoryLogger(),
      secretKey: "s".repeat(32),
    });
    const owner = new Browser(app);
    const before = await owner.json<SessionInfo>("/api/v1/auth/session");
    expect(before).toStrictEqual({
      user: null,
      setupRequired: true,
      setupKeyConfigured: true,
      dev: false,
      providers: { github: false, discord: false, email: false },
      humanCheck: null,
    });
    const setup = {
      email: "owner@example.com",
      password: PASSWORD,
      displayName: "Owner",
      projectName: "Quaso Quest",
    };
    await owner.json("/api/v1/auth/setup", { json: { ...setup, token: "wrong" } }, 403);
    await owner.json(
      "/api/v1/auth/signup",
      {
        json: { email: "early@example.com", password: PASSWORD, displayName: "Early" },
      },
      403,
    );
    const { token } = await real.service.ensureSetupToken(SYSTEM, {});
    const response = await owner.request("/api/v1/auth/setup", { json: { ...setup, token } });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toMatch(
      /^quaso_session=[\w-]{43}\.[\w-]+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const info: SessionInfo = await response.json();
    expect([info.user?.role, info.setupRequired]).toStrictEqual(["administrator", false]);
    expect((await owner.json<SessionInfo>("/api/v1/auth/session")).user?.displayName).toStrictEqual(
      "Owner",
    );
    await owner.json("/api/v1/auth/setup", { json: { ...setup, token } }, 404);
    expect((await owner.request("/setup")).status).toBe(404);

    // A visitor signs up, signs out, and signs in again.
    const visitor = new Browser(app, "192.0.2.50");
    const joined = await visitor.json<SessionInfo>("/api/v1/auth/signup", {
      json: { email: "Ada@Example.com", password: PASSWORD, displayName: "Ada" },
    });
    expect([joined.user?.email, joined.user?.role]).toStrictEqual(["ada@example.com", "none"]);
    const signedOut = await visitor.request("/api/v1/auth/signout", { method: "POST" });
    expect(signedOut.status).toBe(204);
    expect(visitor.cookie).toBe(null);
    expect((await visitor.json<SessionInfo>("/api/v1/auth/session")).user).toBe(null);
    const wrong = await visitor.json<{ error: { code: string; message: string } }>(
      "/api/v1/auth/signin",
      { json: { email: "ada@example.com", password: "not the password" } },
      401,
    );
    expect(wrong.error.message).toBe("The email address or the password is wrong.");
    await visitor.json("/api/v1/auth/signin", {
      json: { email: "ADA@example.com", password: PASSWORD },
    });
    expect((await visitor.json<SessionInfo>("/api/v1/auth/session")).user?.displayName).toBe("Ada");
    expect((await visitor.json<{ email: string }>("/api/v1/account")).email).toStrictEqual(
      "ada@example.com",
    );
  } finally {
    real.close();
  }
});

test("accounts API: writes with the session cookie need the site's Origin", async () => {
  const s = await instance({ CORS_ORIGINS: "https://www.example.com" });
  try {
    const { browser } = await signUp(s, "ada@example.com", "Ada");
    const patch = (headers: Record<string, string>) =>
      browser.request("/api/v1/account", {
        method: "PATCH",
        json: { displayName: "Ada" },
        headers,
      });
    const crossSite = await patch({ Origin: "https://evil.example.com" });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).error.code).toBe("forbidden");
    // A sign-in from another site is refused too, cookie or not (login CSRF).
    const loginCsrf = await s.browser().request("/api/v1/auth/signin", {
      json: { email: "ada@example.com", password: PASSWORD },
      headers: { Origin: "https://evil.example.com" },
    });
    expect(loginCsrf.status).toBe(403);
    await loginCsrf.body?.cancel();
    const noOrigin = new Browser(s.app, "192.0.2.77", null);
    noOrigin.cookie = browser.cookie;
    expect(
      (await noOrigin.request("/api/v1/account", { method: "PATCH", json: { displayName: "A" } }))
        .status,
    ).toBe(403);
    expect((await patch({ Origin: "null", Referer: `${ORIGIN}/account` })).status).toStrictEqual(
      200,
    );
    expect((await patch({ Origin: "null" })).status).toBe(403);
    expect((await patch({ Origin: "https://www.example.com" })).status, "CORS_ORIGINS").toBe(200);
    expect((await patch({})).status, "the site's own Origin").toBe(200);
    // Reads, and writes with an API key, don't need it.
    expect((await noOrigin.request("/api/v1/account")).status).toBe(200);
    const keyed = await s.app(
      new Request(`${ORIGIN}/api/v1/sources`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.key}`,
          Cookie: `quaso_session=${browser.cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: [
            { path: "common.json", repoPath: "common.json", content: JSON.stringify(ENGLISH) },
          ],
          dryRun: true,
        }),
      }),
    );
    expect(keyed.status).toBe(200);
    await keyed.body?.cancel();
  } finally {
    s.close();
  }
});

test("accounts API: Origin null never signs anyone in (login CSRF from a sandboxed frame)", async () => {
  const s = await instance();
  try {
    await signUp(s, "mallory@example.com", "Mallory");
    // What a form with enctype=text/plain in a sandboxed frame sends: no cookie.
    const form = (headers: Record<string, string>) =>
      s.app(
        new Request(`${ORIGIN}/api/v1/auth/signin`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", ...headers },
          body: JSON.stringify({ email: "mallory@example.com", password: PASSWORD }),
        }),
        { remoteAddr: { hostname: "192.0.2.60" } },
      );
    const refused: Record<string, string>[] = [
      { Origin: "null" },
      { Origin: "null", Referer: "https://evil.example/" },
    ];
    for (const headers of refused) {
      const response = await form(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.headers.getSetCookie()).toStrictEqual([]);
      await response.body?.cancel();
    }
    // Scripts send no Origin and no cookie: they still work.
    const script = await form({});
    expect(script.status).toBe(200);
    await script.body?.cancel();
  } finally {
    s.close();
  }
});

test("accounts API: a signed-in person's password checks are limited per account too", async () => {
  const s = await instance();
  try {
    const { browser } = await signUp(s, "victim@example.com", "Victim");
    // Someone with the session cookie guesses the password from ever new addresses.
    const guess = (i: number, init: { method: string; json: unknown }) => {
      const thief = new Browser(s.app, `198.51.100.${i}`);
      thief.cookie = browser.cookie;
      return thief.request("/api/v1/account", init);
    };
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const response = await guess(i, {
        method: "PATCH",
        json: { email: "thief@example.com", currentPassword: `guess number ${i}` },
      });
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses).toStrictEqual([403, 403, 403, 403, 403, 429]);
    const deleting = await guess(50, {
      method: "DELETE",
      json: { confirm: "delete", password: PASSWORD },
    });
    expect(deleting.status).toBe(429);
    await deleting.body?.cancel();
    // A minute later, the right password works.
    s.clock.now += 60_000;
    const right = await guess(51, {
      method: "PATCH",
      json: { displayName: "V", currentPassword: PASSWORD, email: "victim2@example.com" },
    });
    expect(right.status).toBe(200);
    await right.body?.cancel();
  } finally {
    s.close();
  }
});

test("accounts API: rate limits on sign-in, per IP address and per account", async () => {
  const s = await instance();
  try {
    await signUp(s, "ada@example.com", "Ada");
    const attacker = s.browser("198.51.100.1");
    for (let i = 0; i < 10; i++) {
      await attacker.json(
        "/api/v1/auth/signin",
        {
          json: { email: `x${i}@example.com`, password: "wrong" },
        },
        401,
      );
    }
    const limited = await attacker.request("/api/v1/auth/signin", {
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(limited.headers.get("Retry-After")).toBe("6");

    // Five tries a minute for one account, from anywhere (the sign-up was the first).
    for (let i = 0; i < 4; i++) {
      await s.browser(`203.0.113.${i}`).json(
        "/api/v1/auth/signin",
        {
          json: { email: "ada@example.com", password: "wrong" },
        },
        401,
      );
    }
    const account = await s.browser("203.0.113.99").request("/api/v1/auth/signin", {
      json: { email: "ada@example.com", password: PASSWORD },
    });
    expect(account.status).toBe(429);
    expect(account.headers.get("Retry-After")).toBe("12");
  } finally {
    s.close();
  }
});

test("accounts API: anonymous reads and writes have their limits too", async () => {
  const s = await instance();
  try {
    const reader = s.browser("198.51.100.2");
    for (let i = 0; i < 600; i++) {
      const response = await reader.request("/api/v1/auth/session");
      await response.body?.cancel();
      expect(response.status).toBe(200);
    }
    const limited = await reader.request("/api/v1/project");
    expect(limited.status).toBe(429);
    await limited.body?.cancel();
    s.clock.now += 100; // One comes back every 100 ms.
    const again = await reader.request("/api/v1/project");
    expect(again.status).toBe(200);
    await again.body?.cancel();
    // Another visitor, and signed-in people, aren't affected.
    expect((await s.browser().request("/api/v1/project")).status).toBe(200);
    const { browser } = await signUp(s, "ada@example.com", "Ada");
    for (let i = 0; i < 120; i++) {
      await browser.json("/api/v1/account", { method: "PATCH", json: { displayName: `Ada ${i}` } });
    }
    expect(
      (await browser.request("/api/v1/account", { method: "PATCH", json: { displayName: "Ada" } }))
        .status,
    ).toBe(429);
  } finally {
    s.close();
  }
});

test("accounts API: an expired token is renewed from the service; a revoked session ends", async () => {
  const s = await instance();
  try {
    const { browser } = await signUp(s, "ada@example.com", "Ada");
    // Within the hour, the token is enough; after it, the service renews it.
    const fresh = await browser.request("/api/v1/auth/session");
    expect(fresh.headers.getSetCookie()).toStrictEqual([]);
    await fresh.body?.cancel();
    const before = browser.cookie;
    s.clock.now += 60 * 60 * 1000;
    const hourLater = await browser.request("/api/v1/auth/session");
    expect((await hourLater.json()).user.displayName).toBe("Ada");
    expect(hourLater.headers.getSetCookie().length).toBe(1);
    assert(browser.cookie !== before, "a new token");
    const [sessionId, payload] = browser.cookie!.split(".");
    // A token that doesn't verify (or expired): the service says whether the session lives.
    browser.cookie = `${sessionId}.${payload}.AAAA`;
    const renewed = await browser.request("/api/v1/auth/session");
    expect((await renewed.json()).user.displayName).toBe("Ada");
    expect(renewed.headers.getSetCookie()[0]).toMatch(new RegExp(`^quaso_session=${sessionId}\\.`));
    expect(renewed.headers.get("Cache-Control")).toBe("private, no-store");
    assert(!browser.cookie.endsWith(".AAAA"), "the browser has the new token");

    await s.service.signOut(SYSTEM, { sessionId });
    browser.cookie = `${sessionId}.${payload}.AAAA`;
    const ended = await browser.request("/api/v1/auth/session");
    expect((await ended.json()).user).toBe(null);
    expect(ended.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(browser.cookie).toBe(null);
  } finally {
    s.close();
  }
});

test("acceptance test 10: a visitor signs up, volunteers for French, is approved, and suggests", async () => {
  const s = await instance();
  try {
    const { browser: visitor, id } = await signUp(s, "camille@example.com", "Camille");
    const play = await stringId(visitor, "play");
    // Before approval, a visitor can't suggest.
    await visitor.json(
      `/api/v1/strings/${play}/suggestions/fr`,
      {
        json: { kind: "translation", value: "Jouer", baseRevision: 0 },
      },
      403,
    );
    const asked = await visitor.json<{ volunteerRequest: { status: string } }>(
      "/api/v1/volunteer-requests",
      {
        json: { languages: ["fr"], message: "Je parle français." },
      },
      201,
    );
    expect(asked.volunteerRequest.status).toBe("pending");

    const requests = await s.admin.json<{ members: { id: number; displayName: string }[] }>(
      "/api/v1/team/volunteer-requests",
    );
    expect(requests.members.map((m) => [m.id, m.displayName])).toStrictEqual([[id, "Camille"]]);
    await visitor.json("/api/v1/team/volunteer-requests", {}, 403);
    const approved = await s.admin.json<{ role: string; languages: string[] }>(
      `/api/v1/team/volunteer-requests/${id}`,
      { json: { approve: true, role: "contributor", languages: ["fr"] } },
    );
    expect([approved.role, approved.languages]).toStrictEqual(["contributor", ["fr"]]);

    const suggestion = await visitor.json<SuggestionInfo>(
      `/api/v1/strings/${play}/suggestions/fr`,
      {
        json: { kind: "translation", value: "Jouer", baseRevision: 0 },
      },
      201,
    );
    expect([suggestion.status, suggestion.author.name]).toStrictEqual(["pending", "Camille"]);
    // Only in French.
    await visitor.json(
      `/api/v1/strings/${play}/suggestions/de`,
      {
        json: { kind: "translation", value: "Spielen", baseRevision: 0 },
      },
      403,
    );
    const mine = await visitor.json<{ suggestions: SuggestionInfo[] }>(
      "/api/v1/suggestions?author=me",
    );
    expect(mine.suggestions.map((g) => g.id)).toStrictEqual([suggestion.id]);
    expect((await frenchFile(s)).play, "pending changes aren't downloaded").toBe("Play");
  } finally {
    s.close();
  }
});

test("accounts API: recovery immediately blocks revoked cookies on writes and private reads", async () => {
  const s = await instance();
  try {
    const stolen = s.admin.cookie;
    const reset = (await s.service.createEmailToken(SYSTEM, {
      email: "admin@example.com",
      purpose: "reset",
    }))!;
    await s.browser().json("/api/v1/auth/password-reset", {
      json: { token: reset.token, password: "recovered account password" },
    });
    for (const path of [
      "account",
      "backup",
      "admin",
      "settings",
      "team/members",
      "api-tokens",
      "jobs",
      "usage",
    ]) {
      const replay = s.browser();
      replay.cookie = stolen;
      await replay.json(`/api/v1/${path}`, {}, 401);
      expect(replay.cookie).toBe(null);
    }
    for (const change of [
      { email: "stolen@example.com", currentPassword: PASSWORD },
      { password: "attacker's next password", currentPassword: PASSWORD },
      { displayName: "Still hijacked" },
    ]) {
      const replay = s.browser();
      replay.cookie = stolen;
      await replay.json("/api/v1/account", { method: "PATCH", json: change }, 401);
    }
    const replay = s.browser();
    replay.cookie = stolen;
    expect((await replay.json<SessionInfo>("/api/v1/auth/session")).user).toBe(null);
    replay.cookie = stolen;
    await replay.json("/api/v1/project");
    await s.browser().json("/api/v1/project");
  } finally {
    s.close();
  }
});

test("acceptance test 4: a volunteer's correction is downloaded once a manager approves it, blue", async () => {
  const s = await instance();
  try {
    const { browser: volunteer, id } = await signUp(s, "camille@example.com", "Camille");
    await s.admin.json(`/api/v1/team/members/${id}`, {
      method: "PATCH",
      json: { role: "contributor", languages: ["fr"] },
    });
    const { browser: manager, id: managerId } = await signUp(s, "morgan@example.com", "Morgan");
    await s.admin.json(`/api/v1/team/members/${managerId}`, {
      method: "PATCH",
      json: { role: "manager" },
    });
    await s.admin.json("/api/v1/imports", {
      json: {
        language: "fr",
        as: "green",
        files: [{ path: "common.json", content: '{"play": "Jouez"}' }],
      },
      headers: { Authorization: `Bearer ${s.key}` },
    });
    const play = await stringId(volunteer, "play");
    const detail = await volunteer.json<{ translation: { revision: number; colour: string } }>(
      `/api/v1/strings/${play}?language=fr`,
    );
    expect(detail.translation.colour).toBe("green");
    const correction = await volunteer.json<SuggestionInfo>(
      `/api/v1/strings/${play}/suggestions/fr`,
      {
        json: { kind: "correction", value: "Jouer", baseRevision: detail.translation.revision },
      },
      201,
    );
    expect((await frenchFile(s)).play).toBe("Jouez");

    await volunteer.json(
      "/api/v1/suggestions/review",
      {
        json: { ids: [correction.id], action: "approve" },
      },
      403,
    );
    const queue = await manager.json<{ suggestions: SuggestionInfo[] }>(
      "/api/v1/suggestions?language=fr",
    );
    expect(queue.suggestions.map((g) => [g.id, g.current?.value, g.value])).toStrictEqual([
      [correction.id, "Jouez", "Jouer"],
    ]);
    const result = await manager.json("/api/v1/suggestions/review", {
      json: { ids: [correction.id], action: "approve", comment: "Merci" },
    });
    expect(result).toStrictEqual({ approved: [correction.id], rejected: [], failed: [] });
    expect((await frenchFile(s)).play).toBe("Jouer");
    const after = await volunteer.json<{
      translation: { colour: string; author: { name: string }; approver: { name: string } };
    }>(`/api/v1/strings/${play}?language=fr`);
    expect([
      after.translation.colour,
      after.translation.author.name,
      after.translation.approver.name,
    ]).toStrictEqual(["blue", "Camille", "Morgan"]);
    const history = await volunteer.json<{
      entries: {
        event: string;
        actor: { name: string };
        detail: Record<string, unknown> | null;
      }[];
    }>(`/api/v1/strings/${play}/history?language=fr`);
    const approval = history.entries.find((e) => e.event === "suggestion_approved")!;
    expect(approval.actor.name).toBe("Morgan");
    expect(approval.detail?.author).toStrictEqual({ type: "user", id });
    const mine = await volunteer.json<{ suggestions: SuggestionInfo[] }>(
      "/api/v1/suggestions?status=all",
    );
    expect(mine.suggestions.map((g) => [g.status, g.comment, g.reviewer?.name])).toStrictEqual([
      ["approved", "Merci", "Morgan"],
    ]);
  } finally {
    s.close();
  }
});

test("acceptance test 9, the person path: dropping {{count}} is refused with qa_failed", async () => {
  const s = await instance();
  try {
    const items = await stringId(s.admin, "items");
    const saved = await s.admin.json<{
      error: { code: string; details: { check: string; value: string }[] };
    }>(
      `/api/v1/strings/${items}/translations/fr`,
      {
        method: "PUT",
        json: { value: { one: "un objet", many: "objets", other: "objets" }, baseRevision: 0 },
      },
      422,
    );
    expect(saved.error.code).toBe("qa_failed");
    expect(saved.error.details[0].check).toBe("placeholder_missing");
    const { browser, id } = await signUp(s, "camille@example.com", "Camille");
    await s.admin.json(`/api/v1/team/members/${id}`, {
      method: "PATCH",
      json: { role: "contributor" },
    });
    const suggested = await browser.json<{ error: { code: string } }>(
      `/api/v1/strings/${items}/suggestions/fr`,
      {
        json: {
          kind: "translation",
          value: { one: "{{count}} objet", many: "objets", other: "objets" },
          baseRevision: 0,
        },
      },
      422,
    );
    expect(suggested.error.code).toBe("qa_failed");
  } finally {
    s.close();
  }
});

test("direct edits API: blue saves, If-Match, 409 with the current text, approve, unapprove, delete", async () => {
  const s = await instance();
  try {
    const play = await stringId(s.admin, "play");
    const path = `/api/v1/strings/${play}/translations/fr`;
    const saved = await s.admin.json<{ translation: { revision: number; colour: string } }>(path, {
      method: "PUT",
      json: { value: "Jouer" },
      headers: { "If-Match": '"0"' },
    });
    expect(saved.translation.colour).toBe("blue");
    const conflict = await s.admin.json<{ error: { code: string; current: { value: string } } }>(
      path,
      {
        method: "PUT",
        json: { value: "Lancer", baseRevision: 0 },
      },
      409,
    );
    expect([conflict.error.code, conflict.error.current.value]).toStrictEqual([
      "conflict",
      "Jouer",
    ]);
    await s.admin.json(path, { method: "PUT", json: { value: "Lancer" } }, 400);
    await s.admin.json(
      path,
      {
        method: "PUT",
        json: { value: "x", baseRevision: 1 },
        headers: { "If-Match": "2" },
      },
      400,
    );

    const revision = saved.translation.revision;
    const green = await s.admin.json<{ translation: { colour: string; revision: number } }>(
      `${path}/unapprove`,
      {
        json: { baseRevision: revision },
      },
    );
    expect(green.translation.colour).toBe("green");
    const blue = await s.admin.json<{ translation: { colour: string; revision: number } }>(
      `${path}/approve`,
      {
        method: "POST",
        headers: { "If-Match": String(green.translation.revision) },
      },
    );
    expect(blue.translation.colour).toBe("blue");
    const deleted = await s.admin.json(path, {
      method: "DELETE",
      headers: { "If-Match": `"${blue.translation.revision}"` },
    });
    expect(deleted).toStrictEqual({ translation: null });
    // Contributors can't edit directly.
    const { browser, id } = await signUp(s, "camille@example.com", "Camille");
    await s.admin.json(`/api/v1/team/members/${id}`, {
      method: "PATCH",
      json: { role: "contributor" },
    });
    await browser.json(path, { method: "PUT", json: { value: "Jouer", baseRevision: 0 } }, 403);
    await s.browser().json(path, { method: "PUT", json: { value: "Jouer", baseRevision: 0 } }, 401);
  } finally {
    s.close();
  }
});

test("accounts API: deleting the account signs out and keeps the translations", async () => {
  const s = await instance();
  try {
    const { browser, id } = await signUp(s, "ada@example.com", "Ada");
    await s.admin.json(`/api/v1/team/members/${id}`, {
      method: "PATCH",
      json: { role: "manager" },
    });
    const quit = await stringId(browser, "quit");
    await browser.json(`/api/v1/strings/${quit}/translations/fr`, {
      method: "PUT",
      json: { value: "Quitter", baseRevision: 0 },
    });
    await browser.json("/api/v1/account", { method: "DELETE", json: { confirm: "delete" } }, 400);
    const deleted = await browser.request("/api/v1/account", {
      method: "DELETE",
      json: { confirm: "delete", password: PASSWORD },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(browser.cookie).toBe(null);
    const detail = await s
      .browser()
      .json<{ translation: { author: { name: string } } }>(`/api/v1/strings/${quit}?language=fr`);
    expect(detail.translation.author.name).toBe("Deleted user");
    await s.browser().json(
      "/api/v1/auth/signin",
      {
        json: { email: "ada@example.com", password: PASSWORD },
      },
      401,
    );
  } finally {
    s.close();
  }
});

test("accounts API: a deleted account's other devices browse as visitors", async () => {
  const s = await instance();
  try {
    const { browser } = await signUp(s, "ada@example.com", "Ada");
    const other = s.browser();
    await other.json("/api/v1/auth/signin", {
      json: { email: "ada@example.com", password: PASSWORD },
    });
    await browser.json("/api/v1/account", {
      method: "DELETE",
      json: { confirm: "delete", password: PASSWORD },
    });
    // The other device's signed token is still good for its hour: it reads like anyone.
    assert(other.cookie !== null);
    expect((await other.json<{ name: string }>("/api/v1/project")).name).toStrictEqual(
      "Quaso Quest",
    );
    await other.json("/api/v1/strings?language=fr");
    await other.json("/api/v1/account", {}, 401);
    // The website asks who is signed in on load: nobody, and the cookie goes.
    expect((await other.json<SessionInfo>("/api/v1/auth/session")).user).toBe(null);
    expect(other.cookie).toBe(null);
  } finally {
    s.close();
  }
});

test("team API: invites, members, reset links and unlinking", async () => {
  const s = await instance();
  try {
    const invite = await s.admin.json<{ id: number; url: string }>(
      "/api/v1/team/invites",
      {
        json: { role: "manager", languages: ["de"] },
      },
      201,
    );
    expect(invite.url).toMatch(/^http:\/\/localhost:8000\/signup\?invite=[\w-]{43}$/);
    const token = new URL(invite.url).searchParams.get("invite")!;
    expect(await s.browser().json(`/api/v1/invites/${token}`)).toStrictEqual({
      valid: true,
      role: "manager",
      languages: ["de"],
    });
    const { browser, id } = await signUp(s, "morgan@example.com", "Morgan", { invite: token });
    expect((await browser.json<{ role: string }>("/api/v1/account")).role).toBe("manager");
    expect((await s.browser().json<{ valid: boolean }>(`/api/v1/invites/${token}`)).valid).toBe(
      false,
    );
    const invites = await s.admin.json<{ invites: { usedBy: { name: string } }[] }>(
      "/api/v1/team/invites",
    );
    expect(invites.invites[0].usedBy.name).toBe("Morgan");
    await s.admin.json(`/api/v1/team/invites/${invite.id}`, { method: "DELETE" });

    const members = await s.admin.json<{ members: { displayName: string; role: string }[] }>(
      "/api/v1/team/members",
    );
    expect(members.members.map((m) => [m.displayName, m.role])).toStrictEqual([
      ["Admin", "administrator"],
      ["Morgan", "manager"],
    ]);
    await browser.json("/api/v1/team/members", {}, 403);

    const link = await s.admin.json<{ url: string }>(`/api/v1/team/members/${id}/reset-link`, {
      method: "POST",
    });
    expect(link.url).toMatch(/^http:\/\/localhost:8000\/reset-password\?token=/);
    const resetter = s.browser();
    const reset = await resetter.json<SessionInfo>("/api/v1/auth/password-reset", {
      json: {
        token: new URL(link.url).searchParams.get("token"),
        password: "a fresh password now",
      },
    });
    expect(reset.user?.displayName).toBe("Morgan");
    await s.admin.json(`/api/v1/team/members/${id}`, { method: "DELETE" });
    expect((await resetter.json<{ role: string }>("/api/v1/account")).role).toBe("none");
    await resetter.json("/api/v1/account/identities/github", { method: "DELETE" }, 404);
  } finally {
    s.close();
  }
});

test("accounts API: email links, when an email service is set", async () => {
  const off = await instance();
  try {
    await off.browser().json(
      "/api/v1/auth/password-reset/request",
      {
        json: { email: "admin@example.com" },
      },
      404,
    );
    await off.browser().json(
      "/api/v1/auth/email-link/request",
      {
        json: { email: "admin@example.com" },
      },
      404,
    );
  } finally {
    off.close();
  }

  const s = await instance();
  await s.service.updateSettings(SYSTEM, {
    email: { provider: "resend", from: "quaso@example.com", accountId: "" },
  });
  await s.service.setSecret(SYSTEM, { name: "email_api_key", value: "re_key" });
  try {
    expect((await s.browser().json<SessionInfo>("/api/v1/auth/session")).providers.email).toBe(
      true,
    );
    // Sign-up sends a verification link.
    const { browser } = await signUp(s, "ada@example.com", "Ada");
    expect((await s.sent(1)).map((e) => [e.to, e.subject])).toStrictEqual([
      ["ada@example.com", "Confirm your email address (Quaso Quest)"],
    ]);
    const verify = s.emails[0].text.match(/verify-email\?token=([\w-]+)/)![1];
    await s.browser().json("/api/v1/auth/verify-email", { json: { token: verify } });
    expect((await browser.json<{ emailVerified: boolean }>("/api/v1/account")).emailVerified).toBe(
      true,
    );

    // A reset request answers 204 either way, without waiting for the email API (which would
    // tell which addresses have an account); only a known address gets an email.
    const release = s.holdEmails();
    for (const email of ["ada@example.com", "nobody@example.com"]) {
      for (const path of ["password-reset/request", "email-link/request"]) {
        const response = await s.browser().request(`/api/v1/auth/${path}`, { json: { email } });
        expect(response.status, `${path} ${email}`).toBe(204);
      }
    }
    expect(s.emails.length, "none sent yet").toBe(1);
    release();
    expect((await s.sent(3)).slice(1).map((e) => [e.to, e.subject.split(" (")[0]])).toStrictEqual([
      ["ada@example.com", "Reset your password"],
      ["ada@example.com", "Your sign-in link"],
    ]);
    s.emails.splice(1);
    s.clock.now += 60 * 60 * 1000; // A new hour for the rate limits.
    const anyone = s.browser();
    const unknown = await anyone.request("/api/v1/auth/password-reset/request", {
      json: { email: "nobody@example.com" },
    });
    expect(unknown.status).toBe(204);
    const known = await anyone.request("/api/v1/auth/password-reset/request", {
      json: { email: "ada@example.com" },
    });
    expect(known.status).toBe(204);
    expect((await s.sent(2)).length).toBe(2);
    expect(s.emails[1].text).toContain("http://localhost:8000/reset-password?token=");
    const reset = s.emails[1].text.match(/reset-password\?token=([\w-]+)/)![1];
    await anyone.json("/api/v1/auth/password-reset", {
      json: { token: reset, password: "a new password here" },
    });
    // Other sessions end (their signed tokens still work for the rest of their hour).
    const [sessionId] = browser.cookie!.split(".");
    expect(await s.service.resolveSession(SYSTEM, { sessionId })).toBe(null);

    // A sign-in link.
    await anyone.request("/api/v1/auth/email-link/request", { json: { email: "ada@example.com" } });
    const signin = (await s.sent(3))[2].text.match(/signin\/link\?token=([\w-]+)/)![1];
    const linked = s.browser();
    expect(
      (await linked.json<SessionInfo>("/api/v1/auth/email-link", { json: { token: signin } })).user
        ?.displayName,
    ).toBe("Ada");
    // Three requests an hour per IP address, and per address.
    const fourth = await anyone.request("/api/v1/auth/password-reset/request", {
      json: { email: "other@example.com" },
    });
    expect(fourth.status).toBe(429);
    const third = await s.browser().request("/api/v1/auth/password-reset/request", {
      json: { email: "ada@example.com" },
    });
    expect(third.status).toBe(204);
    const limited = await s.browser().request("/api/v1/auth/password-reset/request", {
      json: { email: "ada@example.com" },
    });
    expect(limited.status).toBe(429);
    expect((await s.sent(4)).length).toBe(4);
  } finally {
    s.close();
  }
});

test("accounts API: the development sign-in exists only with QUASO_DEV", async () => {
  const s = await instance();
  try {
    const response = await s.browser().request("/auth/dev-login");
    expect(response.status).toBe(404);
    await response.body?.cancel();
  } finally {
    s.close();
  }
  const real = await realService({ dev: true });
  try {
    const app = createApp({
      config: testConfig({ QUASO_DEV: "1" }),
      service: real.service,
      log: memoryLogger(),
    });
    const browser = new Browser(app);
    const response = await browser.request("/auth/dev-login");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://localhost:8000/");
    const info = await browser.json<SessionInfo>("/api/v1/auth/session");
    expect([info.user?.displayName, info.user?.role, info.dev]).toStrictEqual([
      "Developer",
      "administrator",
      true,
    ]);
  } finally {
    real.close();
  }
});

test("accounts API: the human check, HSTS and the Content Security Policy", async () => {
  const turnstile: string[] = [];
  const real = await realService();
  try {
    const { token } = await real.service.ensureSetupToken(SYSTEM, {});
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      turnstile.push(form.get("response")!);
      return Promise.resolve(Response.json({ success: form.get("response") === "human" }));
    }) as typeof globalThis.fetch;
    const app = createApp({
      config: testConfig({
        PUBLIC_URL: "https://translate.example.com",
        TURNSTILE_SITE_KEY: "site-key",
        TURNSTILE_SECRET_KEY: "secret",
      }),
      service: real.service,
      log: memoryLogger(),
      fetch,
    });
    const origin = "https://translate.example.com";
    const post = (path: string, json: unknown, cookie?: string) =>
      app(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(json),
        }),
      );
    const setup = await post("/api/v1/auth/setup", {
      token,
      email: "owner@example.com",
      password: PASSWORD,
      displayName: "Owner",
      projectName: "Game",
    });
    expect(setup.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(setup.headers.getSetCookie()[0]).toContain("; Secure");
    await setup.body?.cancel();
    const account = { email: "ada@example.com", password: PASSWORD, displayName: "Ada" };
    expect((await post("/api/v1/auth/signup", account)).status).toBe(400);
    expect((await post("/api/v1/auth/signup", { ...account, humanCheck: "bot" })).status).toBe(400);
    const joined = await post("/api/v1/auth/signup", { ...account, humanCheck: "human" });
    expect(joined.status).toBe(200);
    const cookie = joined.headers.getSetCookie()[0].split(";")[0];
    expect((await joined.json()).humanCheck).toStrictEqual({
      provider: "turnstile",
      siteKey: "site-key",
    });
    const volunteer = { languages: ["fr"], message: "Hi" };
    expect((await post("/api/v1/volunteer-requests", volunteer, cookie)).status).toBe(400);
    expect(
      (await post("/api/v1/volunteer-requests", { ...volunteer, humanCheck: "human" }, cookie))
        .status,
      "no French yet",
    ).toBe(400);
    expect(turnstile).toStrictEqual(["bot", "human", "human"]);

    const policy = contentSecurityPolicy(true);
    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(policy).toContain("frame-src https://challenges.cloudflare.com");
    expect(contentSecurityPolicy(false).includes("challenges")).toBe(false);
    const page = await app(new Request(`${origin}/`));
    await page.body?.cancel();
    const served = page.headers.get("Content-Security-Policy");
    if (served !== null) expect(served).toStrictEqual(policy);
  } finally {
    real.close();
  }
});
