// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { assert, expect, test } from "vitest";
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
  expect(toQueryString({ language: "de", ids: [1, 2, 3], q: "", state: undefined })).toStrictEqual(
    "?language=de&ids=1%2C2%2C3",
  );
  expect(toQueryString({ ids: [] })).toBe("");
  expect(apiUrl("/strings", { language: "pt-BR" })).toBe("/api/v1/strings?language=pt-BR");
});

test("requests send JSON with same-origin credentials", async () => {
  const calls = fakeServer(() => Response.json({ ok: true }));
  await saveTranslation(5, "pt-BR", { value: "Olá", baseRevision: 3 });
  expect(calls[0].url).toBe("/api/v1/strings/5/translations/pt-BR");
  expect(calls[0].init.method).toBe("PUT");
  expect(calls[0].init.credentials).toBe("same-origin");
  expect(JSON.parse(String(calls[0].init.body))).toStrictEqual({ value: "Olá", baseRevision: 3 });
  expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toStrictEqual(
    "application/json",
  );

  await listStrings({ language: "de", state: "green", q: "menu", limit: 50 });
  expect(calls[1].url).toBe("/api/v1/strings?language=de&state=green&q=menu&limit=50");
  expect(calls[1].init.body).toBe(undefined);
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
  const error = await saveTranslation(5, "de", { value: "Alt", baseRevision: 3 }).catch(
    (error: unknown) => error,
  );
  assert(error instanceof ApiError);
  expect(error.status).toBe(409);
  expect(error.code).toBe("conflict");
  expect(error.current?.value).toBe("Neu");
  expect(error.missingEndpoint).toBe(false);
});

test("an endpoint the server lacks is recognizable", () => {
  const missing = errorFromResponse(
    404,
    JSON.stringify({ error: { code: "not_found", message: "There is nothing at /api/v1/jobs." } }),
  );
  assert(missing.missingEndpoint);
  expect(errorMessage(missing)).toBe("This server doesn't support this yet.");
  const notFound = errorFromResponse(
    404,
    JSON.stringify({ error: { code: "not_found", message: "String 5 wasn't found." } }),
  );
  expect(notFound.missingEndpoint).toBe(false);
  const html = errorFromResponse(502, "<html>Bad gateway</html>");
  expect([html.code, html.status]).toStrictEqual(["unavailable", 502]);
});

test("a network failure is an ApiError with status 0", async () => {
  configureApi({ fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as Fetch });
  const error = await listStrings({ language: "de" }).catch((error: unknown) => error);
  assert(error instanceof ApiError);
  expect([error.status, error.code]).toStrictEqual([0, "unavailable"]);
  assert(error instanceof Error);
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
  expect(await getSession()).toStrictEqual({ info: SIGNED_OUT, accounts: false });

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
  expect(session.accounts).toBe(true);
  expect(session.info.setupRequired).toBe(true);
  expect(session.info.providers.github).toBe(true);

  fakeServer(() => new Response("oops", { status: 500 }));
  await expect(getSession()).rejects.toThrow(ApiError);
});

test("sign-in redirects go to the API's origin", () => {
  configureApi({ apiBase: "/api/v1" });
  expect(browserAuthUrl("/auth/github", "/translate/de")).toStrictEqual(
    "/auth/github?next=%2Ftranslate%2Fde",
  );
  configureApi({ apiBase: "https://api.example.com/api/v1" });
  expect(browserAuthUrl("/auth/dev-login")).toBe("https://api.example.com/auth/dev-login");
  configureApi({ apiBase: "/api/v1" });
});

test("fresh reads bypass the browser's HTTP cache; others may use it", async () => {
  const calls = fakeServer(() => Response.json({}));
  await getString(19, "ja");
  await getString(19, "ja", { fresh: true });
  await listStrings({ language: "ja", limit: 200 }, { fresh: true });
  await getProject({ fresh: false });
  await getSession({ fresh: true });
  expect(calls.map((call) => call.init.cache)).toStrictEqual([
    undefined,
    "no-cache",
    "no-cache",
    undefined,
    "no-cache",
  ]);
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
    expect([error.status, error.code], String(status)).toStrictEqual([status, code]);
  }
  expect(errorMessage(errorFromResponse(401, ""))).toBe("You need to sign in to do that.");
  expect(errorMessage(errorFromResponse(403, ""))).toStrictEqual(
    "You don't have permission to do that.",
  );
});

test("a 401 outside sign-in tells the session module, which fetches the session again", async () => {
  const told: string[] = [];
  const unauthorized = () =>
    Response.json({ error: { code: "unauthorized", message: "Sign in." } }, { status: 401 });
  fakeServer(unauthorized);
  configureApi({ onUnauthorized: (path) => told.push(path) });
  try {
    await expect(saveTranslation(5, "fr", { value: "Bonjour", baseRevision: 0 })).rejects.toThrow();
    // A proxy's 401 without a body too.
    fakeServer(() => new Response("Unauthorized", { status: 401 }));
    await expect(getString(5, "fr")).rejects.toThrow();
    // Not a wrong password, and not the session itself (it would ask again and again).
    fakeServer(unauthorized);
    await expect(getSession()).rejects.toThrow();
    await expect(signIn({ email: "a@example.com", password: "x" })).rejects.toThrow();
    expect(told).toStrictEqual(["/strings/5/translations/fr", "/strings/5"]);
  } finally {
    configureApi({ onUnauthorized: null });
  }
});
