// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { encodeBase64Url } from "@std/encoding";
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import { type App, createApp } from "./app.ts";
import { safeNext } from "./oauth.ts";
import { memoryLogger, testConfig } from "./testing/helpers.ts";
import { realService } from "./testing/real_service.ts";

const ENV = {
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: "dc-id",
  DISCORD_CLIENT_SECRET: "dc-secret",
};

interface Person {
  github?: {
    id: number;
    login: string;
    name: string | null;
    emails: { email: string; primary: boolean; verified: boolean }[];
  };
  discord?: {
    id: string;
    username: string;
    global_name: string | null;
    email: string | null;
    verified: boolean;
    avatar: string | null;
  };
}

/** GitHub and Discord, faked: the code "code-<n>" is person n's. */
function fakeProviders(people: Person[]) {
  const tokenRequests: URLSearchParams[] = [];
  let exchangeHook: (() => Promise<void>) | undefined;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.href === "https://github.com/login/oauth/access_token" ||
      url.href === "https://discord.com/api/oauth2/token"
    ) {
      const form = new URLSearchParams(await request.text());
      tokenRequests.push(form);
      await exchangeHook?.();
      const n = Number(form.get("code")?.replace("code-", ""));
      if (!people[n]) return Response.json({ error: "bad_verification_code" }, { status: 400 });
      return Response.json({ access_token: `token-${n}`, token_type: "bearer" });
    }
    const n = Number(request.headers.get("Authorization")?.replace("Bearer token-", ""));
    const person = people[n];
    if (url.href === "https://api.github.com/user" && person?.github) {
      const { emails: _emails, ...user } = person.github;
      return Response.json({ ...user, avatar_url: `https://avatars.example.com/${user.id}` });
    }
    if (url.href === "https://api.github.com/user/emails" && person?.github) {
      return Response.json(person.github.emails);
    }
    if (url.href === "https://discord.com/api/users/@me" && person?.discord) {
      return Response.json(person.discord);
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    tokenRequests,
    beforeExchange: (hook: () => Promise<void>) => {
      exchangeHook = hook;
    },
  };
}

async function setUp(people: Person[], env: Record<string, string> = ENV) {
  const real = await realService();
  const { token } = await real.service.ensureSetupToken(SYSTEM, {});
  const admin = await real.service.completeSetup(ANONYMOUS, {
    token: token!,
    email: "admin@example.com",
    password: "a long enough password",
    displayName: "Admin",
    projectName: "Game",
  });
  const providers = fakeProviders(people);
  const app = createApp({
    config: testConfig(env),
    service: real.service,
    log: memoryLogger(),
    secretKey: "s".repeat(32),
    fetch: providers.fetch,
  });
  return { ...real, app, admin, ...providers };
}

/** The value of a cookie that a response sets. */
function setCookieOf(response: Response, name: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

function get(
  app: App,
  path: string,
  cookies: Record<string, string | null> = {},
): Promise<Response> {
  const cookie = Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return app(
    new Request(`http://localhost:8000${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
    { remoteAddr: { hostname: "192.0.2.9" } },
  );
}

/** Starts a flow and follows it to the callback, as the browser would. */
async function signInWith(
  app: App,
  provider: "github" | "discord",
  code: string,
  options: { query?: string; session?: string | null } = {},
) {
  const start = await get(app, `/auth/${provider}${options.query ?? ""}`, {
    quaso_session: options.session ?? null,
  });
  assertEquals(start.status, 302);
  const location = new URL(start.headers.get("Location")!);
  const oauth = setCookieOf(start, "quaso_oauth");
  const state = location.searchParams.get("state")!;
  const callback = await get(app, `/auth/${provider}/callback?code=${code}&state=${state}`, {
    quaso_oauth: oauth,
    quaso_session: options.session ?? null,
  });
  return { start, location, callback };
}

async function sessionUser(app: App, session: string | null) {
  const response = await get(app, "/api/v1/auth/session", { quaso_session: session });
  return (await response.json()).user;
}

test("oauth: the start sends to GitHub with PKCE (S256) and a state in a signed cookie", async () => {
  const setup = await setUp([]);
  try {
    const start = await get(setup.app, "/auth/github?next=/editor/fr");
    assertEquals(start.status, 302);
    const location = new URL(start.headers.get("Location")!);
    assertEquals(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    const params = Object.fromEntries(location.searchParams);
    assertEquals(params.client_id, "gh-id");
    assertEquals(params.redirect_uri, "http://localhost:8000/auth/github/callback");
    assertEquals(params.response_type, "code");
    assertEquals(params.scope, "read:user user:email");
    assertEquals(params.code_challenge_method, "S256");
    assertMatch(params.state, /^[\w-]{43}$/);
    assertMatch(params.code_challenge, /^[\w-]{43}$/);
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith("quaso_oauth="))!;
    assertMatch(cookie, /; Path=\/auth\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
    assert(!cookie.includes(params.state), "the state is signed, not readable as is");
  } finally {
    setup.close();
  }
});

test("oauth: GitHub signs in a new account, with the primary verified address", async () => {
  const setup = await setUp([
    {
      github: {
        id: 42,
        login: "octo",
        name: "Octo Cat",
        emails: [
          { email: "old@example.com", primary: false, verified: true },
          { email: "octo@example.com", primary: true, verified: true },
        ],
      },
    },
  ]);
  try {
    const { location, callback } = await signInWith(setup.app, "github", "code-0", {
      query: "?next=/editor/fr?state=green",
    });
    assertEquals(callback.status, 302);
    assertEquals(callback.headers.get("Location"), "http://localhost:8000/editor/fr?state=green");
    const session = setCookieOf(callback, "quaso_session");
    assert(session, "signed in");
    assertEquals(setCookieOf(callback, "quaso_oauth"), "", "the state cookie is cleared");

    // The code was exchanged with the verifier that matches the challenge.
    const exchange = setup.tokenRequests[0];
    assertEquals(exchange.get("client_id"), "gh-id");
    assertEquals(exchange.get("client_secret"), "gh-secret");
    assertEquals(exchange.get("redirect_uri"), "http://localhost:8000/auth/github/callback");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(exchange.get("code_verifier")!),
    );
    assertEquals(
      encodeBase64Url(new Uint8Array(digest)),
      location.searchParams.get("code_challenge"),
    );

    const user = await sessionUser(setup.app, session);
    assertEquals(
      [user.displayName, user.email, user.emailVerified, user.role],
      ["Octo Cat", "octo@example.com", true, "none"],
    );
    assertEquals(user.avatarUrl, "https://avatars.example.com/42");
    assertEquals(user.identities, [{ provider: "github", username: "octo" }]);
  } finally {
    setup.close();
  }
});

test("oauth: Discord links by a verified address, to a verified account; ?link=1 links to the signed-in one", async () => {
  const setup = await setUp([
    {
      discord: {
        id: "900",
        username: "admin",
        global_name: "The Admin",
        email: "ADMIN@example.com",
        verified: true,
        avatar: "abc",
      },
    },
    {
      discord: {
        id: "901",
        username: "twin",
        global_name: null,
        email: "admin@example.com",
        verified: false,
        avatar: null,
      },
    },
    { github: { id: 7, login: "admin-gh", name: null, emails: [] } },
  ]);
  try {
    // Until the account's own address is verified, whoever created the account could be
    // someone else than the address's owner: no link (a pre-account hijack).
    const early = await signInWith(setup.app, "discord", "code-0");
    assertEquals(
      early.callback.headers.get("Location"),
      "http://localhost:8000/signin?error=oauth_conflict",
    );
    assertEquals(setCookieOf(early.callback, "quaso_session"), null);
    const link = await setup.service.createEmailToken(SYSTEM, {
      email: "admin@example.com",
      purpose: "verify",
    });
    await setup.service.verifyEmail(ANONYMOUS, { token: link!.token });

    const verified = await signInWith(setup.app, "discord", "code-0");
    const session = setCookieOf(verified.callback, "quaso_session");
    const user = await sessionUser(setup.app, session);
    assertEquals(user.id, setup.admin.user.id, "the same account");
    assertEquals(user.identities, [{ provider: "discord", username: "admin" }]);

    // An unverified address is never linked: a new account, without the address.
    const unverified = await signInWith(setup.app, "discord", "code-1");
    const other = await sessionUser(setup.app, setCookieOf(unverified.callback, "quaso_session"));
    assert(other.id !== setup.admin.user.id);
    assertEquals([other.email, other.displayName], [null, "twin"]);

    // Linking GitHub to the signed-in admin keeps the session.
    const linked = await signInWith(setup.app, "github", "code-2", { query: "?link=1", session });
    assertEquals(linked.callback.headers.get("Location"), "http://localhost:8000/account");
    assertEquals(setCookieOf(linked.callback, "quaso_session"), null);
    const account = await sessionUser(setup.app, session);
    assertEquals(
      account.identities.map((i: { provider: string }) => i.provider),
      ["discord", "github"],
    );

    // ?link=1 without a session, and GitHub's account linked elsewhere.
    const signedOut = await get(setup.app, "/auth/github?link=1");
    assertEquals(
      signedOut.headers.get("Location"),
      "http://localhost:8000/account?error=signed_out",
    );
    const taken = await signInWith(setup.app, "github", "code-2", {
      query: "?link=1",
      session: setCookieOf(unverified.callback, "quaso_session"),
    });
    assertEquals(
      taken.callback.headers.get("Location"),
      "http://localhost:8000/account?error=oauth_conflict",
    );
  } finally {
    setup.close();
  }
});

test("oauth: refusals, bad states and failed exchanges go back to the sign-in page", async () => {
  const setup = await setUp([{ github: { id: 1, login: "a", name: null, emails: [] } }]);
  try {
    const start = await get(setup.app, "/auth/github");
    const oauth = setCookieOf(start, "quaso_oauth");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const cases: [string, Record<string, string | null>, string][] = [
      [
        `/auth/github/callback?error=access_denied&state=${state}`,
        { quaso_oauth: oauth },
        "oauth_denied",
      ],
      [`/auth/github/callback?code=code-0&state=wrong`, { quaso_oauth: oauth }, "oauth_failed"],
      [`/auth/github/callback?code=code-0&state=${state}`, {}, "oauth_failed"],
      [`/auth/github/callback?code=code-9&state=${state}`, { quaso_oauth: oauth }, "oauth_failed"],
      [`/auth/discord/callback?code=code-0&state=${state}`, { quaso_oauth: oauth }, "oauth_failed"],
    ];
    for (const [path, cookies, error] of cases) {
      const response = await get(setup.app, path, cookies);
      assertEquals(response.status, 302, path);
      assertEquals(
        response.headers.get("Location"),
        `http://localhost:8000/signin?error=${error}`,
        path,
      );
      assertEquals(setCookieOf(response, "quaso_session"), null, path);
    }
  } finally {
    setup.close();
  }
});

test("oauth: providers without a client ID and secret don't exist", async () => {
  const setup = await setUp([], { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
  try {
    assertEquals((await get(setup.app, "/auth/github")).status, 302);
    const discord = await get(setup.app, "/auth/discord");
    assertEquals(discord.status, 404);
    await discord.body?.cancel();
    const session = await (await get(setup.app, "/api/v1/auth/session")).json();
    assertEquals(session.providers, { github: true, discord: false, email: false });
  } finally {
    setup.close();
  }
});

test("oauth: password recovery stops a revoked session starting or finishing identity linking", async () => {
  const setup = await setUp([{ github: { id: 7, login: "attacker", name: null, emails: [] } }]);
  try {
    const signedIn = await setup.app(
      new Request("http://localhost:8000/api/v1/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
        body: JSON.stringify({ email: "admin@example.com", password: "a long enough password" }),
      }),
    );
    assertEquals(signedIn.status, 200);
    await signedIn.body?.cancel();
    const session = setCookieOf(signedIn, "quaso_session");
    const start = await get(setup.app, "/auth/github?link=1", { quaso_session: session });
    const oauth = setCookieOf(start, "quaso_oauth");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const reset = (await setup.service.createEmailToken(SYSTEM, {
      email: "admin@example.com",
      purpose: "reset",
    }))!;
    await setup.service.resetPassword(ANONYMOUS, {
      token: reset.token,
      password: "the recovered password",
    });
    const callback = await get(setup.app, `/auth/github/callback?code=code-0&state=${state}`, {
      quaso_session: session,
      quaso_oauth: oauth,
    });
    assertEquals(
      callback.headers.get("Location"),
      "http://localhost:8000/account?error=signed_out",
    );
    const again = await get(setup.app, "/auth/github?link=1", { quaso_session: session });
    assertEquals(again.headers.get("Location"), "http://localhost:8000/account?error=signed_out");
    assertEquals(setup.tokenRequests.length, 0, "refused before exchanging the OAuth code");
    // Recovery may happen while a callback is already exchanging its provider code.
    const current = await setup.app(
      new Request("http://localhost:8000/api/v1/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
        body: JSON.stringify({ email: "admin@example.com", password: "the recovered password" }),
      }),
    );
    assertEquals(current.status, 200);
    await current.body?.cancel();
    const currentSession = setCookieOf(current, "quaso_session");
    setup.beforeExchange(async () => {
      const during = (await setup.service.createEmailToken(SYSTEM, {
        email: "admin@example.com",
        purpose: "reset",
      }))!;
      await setup.service.resetPassword(ANONYMOUS, {
        token: during.token,
        password: "recovered while OAuth exchanges",
      });
    });
    const raced = await signInWith(setup.app, "github", "code-0", {
      query: "?link=1",
      session: currentSession,
    });
    assertEquals(
      raced.callback.headers.get("Location"),
      "http://localhost:8000/account?error=signed_out",
    );
    assertEquals(setup.tokenRequests.length, 1);
    const account = await setup.service.getAccount(
      { type: "user", userId: setup.admin.user.id },
      {},
    );
    assertEquals(account.identities, []);
  } finally {
    setup.close();
  }
});

test("oauth: next is a path on this site, never another site", () => {
  assertEquals(safeNext("/editor/fr?q=a#b"), "/editor/fr?q=a#b");
  assertEquals(safeNext(null), "/");
  assertEquals(safeNext("https://evil.example.com/"), "/");
  assertEquals(safeNext("//evil.example.com/"), "/");
  assertEquals(safeNext("/\\evil.example.com"), "/");
  assertEquals(safeNext("editor"), "/");
  assertEquals(safeNext("/%2F%2Fevil.example.com"), "/%2F%2Fevil.example.com");
  assertEquals(safeNext(null, "/account"), "/account");
});
