// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { FakeService } from "./testing/fake_service.ts";
import { call, testApp } from "./testing/helpers.ts";

test("app: /healthz reports the service's health, never cached", async () => {
  const service = new FakeService();
  const { app, log } = testApp(service);
  const response = await call(app, "/healthz");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    version: "9.9.9",
    storage: "local",
    schemaVersion: 1,
    revision: 7,
    busy: false,
    nextWakeUp: null,
  });
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(log.lines.at(-1)?.level, "debug");

  service.busy = true;
  service.nextWakeUp = 200;
  const active = await (await call(app, "/healthz")).json();
  assertEquals([active.busy, active.nextWakeUp], [true, 200]);

  service.healthy = false;
  const failing = await call(app, "/healthz");
  assertEquals(failing.status, 503);
  assertEquals((await failing.json()).ok, false);
});

test("app: anonymous API reads are JSON, public for 30 seconds, and logged", async () => {
  const service = new FakeService();
  const { app, log } = testApp(service);
  const response = await call(app, "/api/v1/project");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertEquals(
    response.headers.get("Cache-Control"),
    "public, max-age=30, stale-while-revalidate=300",
  );
  assertEquals(response.headers.get("Vary"), "Authorization, Cookie, Accept-Encoding");
  assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
  assertEquals(response.headers.get("X-Frame-Options"), "DENY");
  assertEquals((await response.json()).name, "Demo");
  assertEquals(service.calls.at(-1), {
    method: "getProject",
    actor: { type: "anonymous" },
    input: {},
  });

  const id = response.headers.get("X-Request-Id")!;
  assertMatch(id, /^[0-9a-f-]{36}$/);
  const line = log.lines.at(-1)!;
  assertEquals(line.msg, "request");
  assertEquals(line.level, "info");
  assertEquals(
    { ...line, time: undefined, duration: undefined },
    {
      time: undefined,
      level: "info",
      msg: "request",
      method: "GET",
      path: "/api/v1/project",
      status: 200,
      duration: undefined,
      requestId: id,
      ip: "192.0.2.1",
    },
  );
  assertEquals(typeof line.duration, "number");
});

test("app: requests with an API key are private, and the service sees the key", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("read");
  const { app } = testApp(service);
  const response = await call(app, "/api/v1/export?languages=de,fr", { key: secret });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(service.calls.at(-1), {
    method: "exportFiles",
    actor: { type: "token", tokenId: id },
    input: { languages: ["de", "fr"] },
  });
});

test("app: the service decides who may do what", async () => {
  const service = new FakeService();
  const read = service.addToken("read").secret;
  const upload = service.addToken("upload").secret;
  const { app } = testApp(service);
  const body = { files: [{ path: "common.json", repoPath: "common.json", content: "{}" }] };

  const anonymous = await call(app, "/api/v1/sources", { method: "POST", json: body });
  assertEquals(anonymous.status, 401);
  assertEquals((await anonymous.json()).error.code, "unauthorized");
  const wrongScope = await call(app, "/api/v1/sources", { method: "POST", json: body, key: read });
  assertEquals(wrongScope.status, 403);
  await wrongScope.body?.cancel();
  const ok = await call(app, "/api/v1/sources", { method: "POST", json: body, key: upload });
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("Cache-Control"), "private, no-store");
  assertEquals((await ok.json()).uploadId, 1);
  assertEquals(service.calls.at(-1)?.input, body);

  const badKey = await call(app, "/api/v1/project", { key: "qso_nope" });
  assertEquals(badKey.status, 401);
  assertEquals(badKey.headers.get("Cache-Control"), "private, no-store");
  await badKey.body?.cancel();
});

test("app: callers who can't upload are refused before the body is read", async () => {
  const service = new FakeService();
  const read = service.addToken("read").secret;
  const upload = service.addToken("upload").secret;
  const { app } = testApp(service);
  const send = async (path: string, key?: string) => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{"files": []}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await call(app, path, { method: "POST", body, key });
    await response.body?.cancel();
    return [response.status, pulled];
  };
  for (const path of ["/api/v1/sources", "/api/v1/imports", "/api/v1/api-tokens"]) {
    assertEquals(await send(path), [401, false], path);
  }
  for (const path of ["/api/v1/sources", "/api/v1/imports"]) {
    assertEquals(await send(path, read), [403, false], path);
  }
  assertEquals((await send("/api/v1/sources", upload))[1], true);
  // A read key revoked meanwhile is a 401, as always.
  service.tokens.get(read)!.revoked = true;
  assertEquals(await send("/api/v1/sources", read), [401, false]);
});

test("app: a long or malformed key is unknown, not a validation error", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  for (const key of [`qso_${"a".repeat(300)}`, "qso_a.b", "qso_"]) {
    const response = await call(app, "/api/v1/project", { key });
    assertEquals(response.status, 401, key);
    assertEquals((await response.json()).error.message, "This API key is unknown or was revoked.");
  }
  assertEquals(service.count("authenticateToken"), 0);
});

test("app: validation errors are 400 with details, before the service is called", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  const missing = await call(app, "/api/v1/strings");
  assertEquals(missing.status, 400);
  assertEquals(await missing.json(), {
    error: {
      code: "validation_failed",
      message: "Invalid request: language: is required.",
      details: [{ path: "language", message: "is required" }],
    },
  });
  const badId = await call(app, "/api/v1/strings/abc?language=de");
  assertEquals((await badId.json()).error.details, [
    { path: "id", message: "must be an integer, not a string" },
  ]);
  const upload = service.addToken("upload").secret;
  const badBody = await call(app, "/api/v1/imports", {
    method: "POST",
    key: upload,
    json: { language: "xx-invalid-", files: [], as: "purple" },
  });
  assertEquals(badBody.status, 400);
  assertEquals(
    (await badBody.json()).error.details.map((d: { path: string }) => d.path),
    ["language", "files", "as"],
  );
  const notJson = await call(app, "/api/v1/sources", { method: "POST", key: upload, body: "{" });
  assertEquals(notJson.status, 400);
  assertEquals((await notJson.json()).error.code, "bad_request");
  assertEquals(service.count("upload") + service.count("importTranslations"), 0);
});

test("app: bodies are limited: 50 MB for uploads and imports, 1 MB otherwise", async () => {
  const service = new FakeService();
  const upload = service.addToken("upload").secret;
  const { app } = testApp(service);
  const content = "x".repeat(2 * 1024 * 1024);
  const big = await call(app, "/api/v1/sources", {
    method: "POST",
    key: upload,
    json: { files: [{ path: "common.json", repoPath: "common.json", content }] },
  });
  assertEquals(big.status, 200);
  await big.body?.cancel();
  const tooBig = await call(app, "/api/v1/api-tokens", {
    method: "POST",
    key: upload,
    json: { name: content, scope: "read" },
  });
  assertEquals(tooBig.status, 413);
  assertEquals((await tooBig.json()).error.code, "payload_too_large");
});

test("app: parameters reach the service as the core schemas describe them", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  const paths = [
    "/api/v1/files?language=de",
    "/api/v1/strings?language=de&file=menus/&state=outdated&q=play&ids=1,2&limit=20",
    "/api/v1/strings/7/history",
    "/api/v1/strings/7/history?language=pl",
    "/api/v1/activity?cursor=abc&limit=5",
    "/api/v1/status",
    "/api/v1/status?language=ja",
  ];
  const key = service.addToken("read").secret;
  for (const path of paths) {
    const response = await call(app, path, path.startsWith("/api/v1/status") ? { key } : {});
    assertEquals(response.status, 200, path);
    await response.body?.cancel();
  }
  const calls = service.calls.filter((c) => c.method !== "authenticateToken");
  assertEquals(
    calls.map((c) => [c.method, c.input]),
    [
      ["listFiles", { language: "de" }],
      [
        "listStrings",
        {
          language: "de",
          file: "menus/",
          state: "outdated",
          q: "play",
          ids: [1, 2],
          limit: 20,
        },
      ],
      ["getHistory", { id: 7 }],
      ["getHistory", { id: 7, language: "pl" }],
      ["getActivity", { cursor: "abc", limit: 5 }],
      ["getStatus", {}],
      ["getStatus", { language: "ja" }],
    ],
  );
  const detail = await call(app, "/api/v1/strings/7?language=de");
  assertEquals(detail.status, 404);
  assertEquals((await detail.json()).error.message, "String 7 was not found.");
});

test("app: unknown paths and methods get the API's error shape", async () => {
  const { app } = testApp(new FakeService());
  for (const path of ["/api/v1/nothing", "/api/v2/project", "/auth/session", "/schema/v9.json"]) {
    const response = await call(app, path);
    assertEquals(response.status, 404, path);
    assertEquals((await response.json()).error.code, "not_found");
  }
  const wrong = await call(app, "/api/v1/project", { method: "PUT" });
  assertEquals(wrong.status, 405);
  assertEquals(wrong.headers.get("Allow"), "GET, HEAD");
  assertEquals((await wrong.json()).error.code, "bad_request");
});

test("app: a crash is a 500 with the request ID, logged", async () => {
  const service = new FakeService();
  service.projectError = new Error("disk on fire");
  const { app, log } = testApp(service);
  const response = await call(app, "/api/v1/project");
  assertEquals(response.status, 500);
  const id = response.headers.get("X-Request-Id")!;
  assertEquals((await response.json()).error, {
    code: "internal",
    message: `Something went wrong on the server. The request ID is ${id}.`,
  });
  const error = log.lines.find((line) => line.level === "error")!;
  assertEquals(error.requestId, id);
  assertEquals(log.recentErrors().length, 1);
});

test("app: behind a trusted proxy, its request ID and client address are used", async () => {
  const headers = { "X-Request-Id": "caddy-42", "X-Forwarded-For": "203.0.113.9" };
  const trusted = testApp(new FakeService(), { TRUST_PROXY: "true" });
  const response = await call(trusted.app, "/api/v1/project", { headers });
  await response.body?.cancel();
  assertEquals(response.headers.get("X-Request-Id"), "caddy-42");
  assertEquals(trusted.log.lines.at(-1)?.ip, "203.0.113.9");

  const direct = testApp(new FakeService());
  const other = await call(direct.app, "/api/v1/project", { headers });
  await other.body?.cancel();
  assert(other.headers.get("X-Request-Id") !== "caddy-42");
  assertEquals(direct.log.lines.at(-1)?.ip, "192.0.2.1");
});

test("app: HEAD answers like GET, without a body", async () => {
  const { app } = testApp(new FakeService());
  const response = await call(app, "/api/v1/project", { method: "HEAD" });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertEquals(response.body, null);
});

test("app: revoking a key through the API stops it at once", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("upload");
  const { app } = testApp(service);
  assertEquals((await call(app, "/api/v1/status", { key: secret })).status, 200);
  const revoke = await call(app, `/api/v1/api-tokens/${id}`, { method: "DELETE", key: secret });
  assertEquals(await revoke.json(), { ok: true });
  const after = await call(app, "/api/v1/status", { key: secret });
  assertEquals(after.status, 401);
  await after.body?.cancel();
});

test("app: creating an API key answers 201, with the secret", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  const response = await call(app, "/api/v1/api-tokens", {
    method: "POST",
    json: { name: "CI", scope: "upload" },
    key: service.addToken("upload").secret,
  });
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  const created = await response.json();
  assertEquals([created.name, created.scope], ["CI", "upload"]);
  assertMatch(created.secret, /^qso_/);
  assertEquals(service.calls.at(-1)?.input, { name: "CI", scope: "upload" });
});

test("app: the config schema and the OpenAPI document", async () => {
  const { app } = testApp(new FakeService(), { PUBLIC_URL: "https://translate.example.com" });
  const schema = await (await call(app, "/schema/config-v1.json")).json();
  assertEquals(schema.$id, "https://translate.example.com/schema/config-v1.json");
  assertEquals(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertEquals(schema.required, ["sourceLanguage", "languages", "files"]);

  const openApi = await call(app, "/api/v1/openapi.json");
  assertEquals((await openApi.json()).servers, [{ url: "https://translate.example.com/api/v1" }]);
});

test("app: CORS only for the configured origins, with credentials", async () => {
  const { app } = testApp(new FakeService(), { CORS_ORIGINS: "https://web.example.com" });
  const preflight = await call(app, "/api/v1/sources", {
    method: "OPTIONS",
    headers: { Origin: "https://web.example.com", "Access-Control-Request-Method": "POST" },
  });
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), "https://web.example.com");
  assertEquals(preflight.headers.get("Access-Control-Allow-Credentials"), "true");
  assertMatch(preflight.headers.get("Access-Control-Allow-Headers")!, /Authorization/);

  const read = await call(app, "/api/v1/project", {
    headers: { Origin: "https://web.example.com" },
  });
  await read.body?.cancel();
  assertEquals(read.headers.get("Access-Control-Allow-Origin"), "https://web.example.com");
  assertEquals(read.headers.get("Vary"), "Authorization, Cookie, Origin, Accept-Encoding");

  const other = await call(app, "/api/v1/project", { headers: { Origin: "https://evil.example" } });
  await other.body?.cancel();
  assertEquals(other.headers.get("Access-Control-Allow-Origin"), null);
  // Every API response varies by Origin, so a cache never gives one origin another's copy.
  assertEquals(other.headers.get("Vary"), "Authorization, Cookie, Origin, Accept-Encoding");
  const none = await call(app, "/api/v1/project");
  await none.body?.cancel();
  assertEquals(none.headers.get("Vary"), "Authorization, Cookie, Origin, Accept-Encoding");
  const { app: sameOrigin } = testApp(new FakeService());
  const plain = await call(sameOrigin, "/api/v1/project");
  await plain.body?.cancel();
  assertEquals(plain.headers.get("Vary"), "Authorization, Cookie, Accept-Encoding");
  const otherPreflight = await call(app, "/api/v1/project", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  });
  assertEquals(otherPreflight.status, 405);
  await otherPreflight.body?.cancel();
});
