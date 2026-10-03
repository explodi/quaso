// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { test } from "node:test";
import { assert, assertEquals, assertInstanceOf, assertRejects } from "@quaso/runtime/assert";
import {
  ApiError,
  apiUrl,
  browserAuthUrl,
  configureApi,
  errorFromResponse,
  errorMessage,
  getProject,
  getSession,
  getString,
  listStrings,
  saveTranslation,
  SIGNED_OUT,
  signIn,
  toQueryString,
} from "./api.ts";

interface Call {
  url: string;
  init: RequestInit;
}

/** Points the client at a fake server that answers `respond`. */
function fakeServer(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  configureApi({
    apiBase: "/api/v1",
    fetch: ((url: string, init: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      return Promise.resolve(respond(call));
    }) as Fetch,
  });
  return calls;
}

test("query strings join arrays with commas and leave out empty values", () => {
  assertEquals(
    toQueryString({ language: "de", ids: [1, 2, 3], q: "", state: undefined }),
    "?language=de&ids=1%2C2%2C3",
  );
  assertEquals(toQueryString({ ids: [] }), "");
  assertEquals(apiUrl("/strings", { language: "pt-BR" }), "/api/v1/strings?language=pt-BR");
});

test("requests send JSON with same-origin credentials", async () => {
  const calls = fakeServer(() => Response.json({ ok: true }));
  await saveTranslation(5, "pt-BR", { value: "Olá", baseRevision: 3 });
  assertEquals(calls[0].url, "/api/v1/strings/5/translations/pt-BR");
  assertEquals(calls[0].init.method, "PUT");
  assertEquals(calls[0].init.credentials, "same-origin");
  assertEquals(JSON.parse(String(calls[0].init.body)), { value: "Olá", baseRevision: 3 });
  assertEquals(
    (calls[0].init.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );

  await listStrings({ language: "de", state: "green", q: "menu", limit: 50 });
  assertEquals(calls[1].url, "/api/v1/strings?language=de&state=green&q=menu&limit=50");
  assertEquals(calls[1].init.body, undefined);
});

test("errors keep their code, details and the current translation", async () => {
  const current = {
    value: "Neu",
    colour: "blue",
    outdated: false,
    revision: 4,
    qa: { errors: 0, warnings: 0 },
    author: { type: "user", id: 2, name: "Ana" },
    approver: null,
    updatedAt: 1,
  };
  fakeServer(() =>
    Response.json(
      { error: { code: "conflict", message: "Changed meanwhile.", current } },
      {
        status: 409,
      },
    ),
  );
  const error = await assertRejects(
    () => saveTranslation(5, "de", { value: "Alt", baseRevision: 3 }),
    ApiError,
  );
  assertEquals(error.status, 409);
  assertEquals(error.code, "conflict");
  assertEquals(error.current?.value, "Neu");
  assertEquals(error.missingEndpoint, false);
});

test("an endpoint the server lacks is recognizable", () => {
  const missing = errorFromResponse(
    404,
    JSON.stringify({ error: { code: "not_found", message: "There is nothing at /api/v1/jobs." } }),
  );
  assert(missing.missingEndpoint);
  assertEquals(errorMessage(missing), "This server doesn't support this yet.");
  const notFound = errorFromResponse(
    404,
    JSON.stringify({ error: { code: "not_found", message: "String 5 wasn't found." } }),
  );
  assertEquals(notFound.missingEndpoint, false);
  const html = errorFromResponse(502, "<html>Bad gateway</html>");
  assertEquals([html.code, html.status], ["unavailable", 502]);
});

test("a network failure is an ApiError with status 0", async () => {
  configureApi({ fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as Fetch });
  const error = await assertRejects(() => listStrings({ language: "de" }), ApiError);
  assertEquals([error.status, error.code], [0, "unavailable"]);
  assertInstanceOf(error, Error);
});

test("GET /auth/session answering 404 means signed out, without accounts", async () => {
  fakeServer(() =>
    Response.json(
      {
        error: { code: "not_found", message: "There is nothing at /api/v1/auth/session." },
      },
      {
        status: 404,
      },
    ),
  );
  assertEquals(await getSession(), { info: SIGNED_OUT, accounts: false });

  fakeServer(() =>
    Response.json({
      user: null,
      setupRequired: true,
      dev: true,
      providers: { github: true, discord: false, email: false },
      humanCheck: null,
    }),
  );
  const session = await getSession();
  assertEquals(session.accounts, true);
  assertEquals(session.info.setupRequired, true);
  assertEquals(session.info.providers.github, true);

  fakeServer(() => new Response("oops", { status: 500 }));
  await assertRejects(() => getSession(), ApiError);
});

test("sign-in redirects go to the API's origin", () => {
  configureApi({ apiBase: "/api/v1" });
  assertEquals(
    browserAuthUrl("/auth/github", "/translate/de"),
    "/auth/github?next=%2Ftranslate%2Fde",
  );
  configureApi({ apiBase: "https://api.example.com/api/v1" });
  assertEquals(browserAuthUrl("/auth/dev-login"), "https://api.example.com/auth/dev-login");
  configureApi({ apiBase: "/api/v1" });
});

test("fresh reads bypass the browser's HTTP cache; others may use it", async () => {
  const calls = fakeServer(() => Response.json({}));
  await getString(19, "ja");
  await getString(19, "ja", { fresh: true });
  await listStrings({ language: "ja", limit: 200 }, { fresh: true });
  await getProject({ fresh: false });
  await getSession({ fresh: true });
  assertEquals(
    calls.map((call) => call.init.cache),
    [undefined, "no-cache", "no-cache", undefined, "no-cache"],
  );
});

test("errors without an error body get the status's code", () => {
  const cases: [number, string][] = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [502, "unavailable"],
  ];
  for (const [status, code] of cases) {
    const error = errorFromResponse(status, "<html>Proxy error</html>");
    assertEquals([error.status, error.code], [status, code], String(status));
  }
  assertEquals(errorMessage(errorFromResponse(401, "")), "You need to sign in to do that.");
  assertEquals(errorMessage(errorFromResponse(403, "")), "You don't have permission to do that.");
});

test("a 401 outside sign-in tells the session module, which fetches the session again", async () => {
  const told: string[] = [];
  const unauthorized = () =>
    Response.json({ error: { code: "unauthorized", message: "Sign in." } }, { status: 401 });
  fakeServer(unauthorized);
  configureApi({ onUnauthorized: (path) => told.push(path) });
  try {
    await assertRejects(() => saveTranslation(5, "fr", { value: "Bonjour", baseRevision: 0 }));
    // A proxy's 401 without a body too.
    fakeServer(() => new Response("Unauthorized", { status: 401 }));
    await assertRejects(() => getString(5, "fr"));
    // Not a wrong password, and not the session itself (it would ask again and again).
    fakeServer(unauthorized);
    await assertRejects(() => getSession());
    await assertRejects(() => signIn({ email: "a@example.com", password: "x" }));
    assertEquals(told, ["/strings/5/translations/fr", "/strings/5"]);
  } finally {
    configureApi({ onUnauthorized: null });
  }
});
