// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { FakeService } from "./testing/fake_service.ts";
import { call, testApp } from "./testing/helpers.ts";

test("app: /healthz reports the service's health, never cached", async () => {
  const service = new FakeService();
  const { app, log } = testApp(service);
  const response = await call(app, "/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    ok: true,
    version: "9.9.9",
    storage: "local",
    schemaVersion: 1,
    revision: 7,
    busy: false,
    nextWakeUp: null,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(log.lines.at(-1)?.level).toBe("debug");

  service.busy = true;
  service.nextWakeUp = 200;
  const active = await (await call(app, "/healthz")).json();
  expect([active.busy, active.nextWakeUp]).toStrictEqual([true, 200]);

  service.healthy = false;
  const failing = await call(app, "/healthz");
  expect(failing.status).toBe(503);
  expect((await failing.json()).ok).toBe(false);
});

test("app: anonymous API reads are JSON, public for 30 seconds, and logged", async () => {
  const service = new FakeService();
  const { app, log } = testApp(service);
  const response = await call(app, "/api/v1/project");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toStrictEqual(
    "public, max-age=30, stale-while-revalidate=300",
  );
  expect(response.headers.get("Vary")).toBe("Authorization, Cookie, Accept-Encoding");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect((await response.json()).name).toBe("Demo");
  expect(service.calls.at(-1)).toStrictEqual({
    method: "getProject",
    actor: { type: "anonymous" },
    input: {},
  });

  const id = response.headers.get("X-Request-Id")!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const line = log.lines.at(-1)!;
  expect(line.msg).toBe("request");
  expect(line.level).toBe("info");
  expect({ ...line, time: undefined, duration: undefined }).toStrictEqual({
    time: undefined,
    level: "info",
    msg: "request",
    method: "GET",
    path: "/api/v1/project",
    status: 200,
    duration: undefined,
    requestId: id,
    ip: "192.0.2.1",
  });
  expect(typeof line.duration).toBe("number");
});

test("app: requests with an API key are private, and the service sees the key", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("read");
  const { app } = testApp(service);
  const response = await call(app, "/api/v1/export?languages=de,fr", { key: secret });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(service.calls.at(-1)).toStrictEqual({
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
  expect(anonymous.status).toBe(401);
  expect((await anonymous.json()).error.code).toBe("unauthorized");
  const wrongScope = await call(app, "/api/v1/sources", { method: "POST", json: body, key: read });
  expect(wrongScope.status).toBe(403);
  await wrongScope.body?.cancel();
  const ok = await call(app, "/api/v1/sources", { method: "POST", json: body, key: upload });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await ok.json()).uploadId).toBe(1);
  expect(service.calls.at(-1)?.input).toStrictEqual(body);

  const badKey = await call(app, "/api/v1/project", { key: "qso_nope" });
  expect(badKey.status).toBe(401);
  expect(badKey.headers.get("Cache-Control")).toBe("private, no-store");
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
    expect(await send(path), path).toStrictEqual([401, false]);
  }
  for (const path of ["/api/v1/sources", "/api/v1/imports"]) {
    expect(await send(path, read), path).toStrictEqual([403, false]);
  }
  expect((await send("/api/v1/sources", upload))[1]).toBe(true);
  // A read key revoked meanwhile is a 401, as always.
  service.tokens.get(read)!.revoked = true;
  expect(await send("/api/v1/sources", read)).toStrictEqual([401, false]);
});

test("app: a long or malformed key is unknown, not a validation error", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  for (const key of [`qso_${"a".repeat(300)}`, "qso_a.b", "qso_"]) {
    const response = await call(app, "/api/v1/project", { key });
    expect(response.status, key).toBe(401);
    expect((await response.json()).error.message).toStrictEqual(
      "This API key is unknown or was revoked.",
    );
  }
  expect(service.count("authenticateToken")).toBe(0);
});

test("app: validation errors are 400 with details, before the service is called", async () => {
  const service = new FakeService();
  const { app } = testApp(service);
  const missing = await call(app, "/api/v1/strings");
  expect(missing.status).toBe(400);
  expect(await missing.json()).toStrictEqual({
    error: {
      code: "validation_failed",
      message: "Invalid request: language: is required.",
      details: [{ path: "language", message: "is required" }],
    },
  });
  const badId = await call(app, "/api/v1/strings/abc?language=de");
  expect((await badId.json()).error.details).toStrictEqual([
    { path: "id", message: "must be an integer, not a string" },
  ]);
  const upload = service.addToken("upload").secret;
  const badBody = await call(app, "/api/v1/imports", {
    method: "POST",
    key: upload,
    json: { language: "xx-invalid-", files: [], as: "purple" },
  });
  expect(badBody.status).toBe(400);
  expect((await badBody.json()).error.details.map((d: { path: string }) => d.path)).toStrictEqual([
    "language",
    "files",
    "as",
  ]);
  const notJson = await call(app, "/api/v1/sources", { method: "POST", key: upload, body: "{" });
  expect(notJson.status).toBe(400);
  expect((await notJson.json()).error.code).toBe("bad_request");
  expect(service.count("upload") + service.count("importTranslations")).toBe(0);
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
  expect(big.status).toBe(200);
  await big.body?.cancel();
  const tooBig = await call(app, "/api/v1/api-tokens", {
    method: "POST",
    key: upload,
    json: { name: content, scope: "read" },
  });
  expect(tooBig.status).toBe(413);
  expect((await tooBig.json()).error.code).toBe("payload_too_large");
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
    expect(response.status, path).toBe(200);
    await response.body?.cancel();
  }
  const calls = service.calls.filter((c) => c.method !== "authenticateToken");
  expect(calls.map((c) => [c.method, c.input])).toStrictEqual([
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
  ]);
  const detail = await call(app, "/api/v1/strings/7?language=de");
  expect(detail.status).toBe(404);
  expect((await detail.json()).error.message).toBe("String 7 was not found.");
});

test("app: unknown paths and methods get the API's error shape", async () => {
  const { app } = testApp(new FakeService());
  for (const path of ["/api/v1/nothing", "/api/v2/project", "/auth/session", "/schema/v9.json"]) {
    const response = await call(app, path);
    expect(response.status, path).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  }
  const wrong = await call(app, "/api/v1/project", { method: "PUT" });
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("Allow")).toBe("GET, HEAD");
  expect((await wrong.json()).error.code).toBe("bad_request");
});

test("app: a crash is a 500 with the request ID, logged", async () => {
  const service = new FakeService();
  service.projectError = new Error("disk on fire");
  const { app, log } = testApp(service);
  const response = await call(app, "/api/v1/project");
  expect(response.status).toBe(500);
  const id = response.headers.get("X-Request-Id")!;
  expect((await response.json()).error).toStrictEqual({
    code: "internal",
    message: `Something went wrong on the server. The request ID is ${id}.`,
  });
  const error = log.lines.find((line) => line.level === "error")!;
  expect(error.requestId).toStrictEqual(id);
  expect(log.recentErrors().length).toBe(1);
});

test("app: behind a trusted proxy, its request ID and client address are used", async () => {
  const headers = { "X-Request-Id": "caddy-42", "X-Forwarded-For": "203.0.113.9" };
  const trusted = testApp(new FakeService(), { TRUST_PROXY: "true" });
  const response = await call(trusted.app, "/api/v1/project", { headers });
  await response.body?.cancel();
  expect(response.headers.get("X-Request-Id")).toBe("caddy-42");
  expect(trusted.log.lines.at(-1)?.ip).toBe("203.0.113.9");

  const direct = testApp(new FakeService());
  const other = await call(direct.app, "/api/v1/project", { headers });
  await other.body?.cancel();
  assert(other.headers.get("X-Request-Id") !== "caddy-42");
  expect(direct.log.lines.at(-1)?.ip).toBe("192.0.2.1");
});

test("app: HEAD answers like GET, without a body", async () => {
  const { app } = testApp(new FakeService());
  const response = await call(app, "/api/v1/project", { method: "HEAD" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.body).toBe(null);
});

test("app: revoking a key through the API stops it at once", async () => {
  const service = new FakeService();
  const { secret, id } = service.addToken("upload");
  const { app } = testApp(service);
  expect((await call(app, "/api/v1/status", { key: secret })).status).toBe(200);
  const revoke = await call(app, `/api/v1/api-tokens/${id}`, { method: "DELETE", key: secret });
  expect(await revoke.json()).toStrictEqual({ ok: true });
  const after = await call(app, "/api/v1/status", { key: secret });
  expect(after.status).toBe(401);
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
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const created = await response.json();
  expect([created.name, created.scope]).toStrictEqual(["CI", "upload"]);
  expect(created.secret).toMatch(/^qso_/);
  expect(service.calls.at(-1)?.input).toStrictEqual({ name: "CI", scope: "upload" });
});

test("app: the config schema and the OpenAPI document", async () => {
  const { app } = testApp(new FakeService(), { PUBLIC_URL: "https://translate.example.com" });
  const schema = await (await call(app, "/schema/config-v1.json")).json();
  expect(schema.$id).toBe("https://translate.example.com/schema/config-v1.json");
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(schema.required).toStrictEqual(["sourceLanguage", "languages", "files"]);

  const openApi = await call(app, "/api/v1/openapi.json");
  expect((await openApi.json()).servers).toStrictEqual([
    { url: "https://translate.example.com/api/v1" },
  ]);
});

test("app: CORS only for the configured origins, with credentials", async () => {
  const { app } = testApp(new FakeService(), { CORS_ORIGINS: "https://web.example.com" });
  const preflight = await call(app, "/api/v1/sources", {
    method: "OPTIONS",
    headers: { Origin: "https://web.example.com", "Access-Control-Request-Method": "POST" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toStrictEqual(
    "https://web.example.com",
  );
  expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(preflight.headers.get("Access-Control-Allow-Headers")!).toMatch(/Authorization/);

  const read = await call(app, "/api/v1/project", {
    headers: { Origin: "https://web.example.com" },
  });
  await read.body?.cancel();
  expect(read.headers.get("Access-Control-Allow-Origin")).toBe("https://web.example.com");
  expect(read.headers.get("Vary")).toBe("Authorization, Cookie, Origin, Accept-Encoding");

  const other = await call(app, "/api/v1/project", { headers: { Origin: "https://evil.example" } });
  await other.body?.cancel();
  expect(other.headers.get("Access-Control-Allow-Origin")).toBe(null);
  // Every API response varies by Origin, so a cache never gives one origin another's copy.
  expect(other.headers.get("Vary")).toBe("Authorization, Cookie, Origin, Accept-Encoding");
  const none = await call(app, "/api/v1/project");
  await none.body?.cancel();
  expect(none.headers.get("Vary")).toBe("Authorization, Cookie, Origin, Accept-Encoding");
  const { app: sameOrigin } = testApp(new FakeService());
  const plain = await call(sameOrigin, "/api/v1/project");
  await plain.body?.cancel();
  expect(plain.headers.get("Vary")).toBe("Authorization, Cookie, Accept-Encoding");
  const otherPreflight = await call(app, "/api/v1/project", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  });
  expect(otherPreflight.status).toBe(405);
  await otherPreflight.body?.cancel();
});
