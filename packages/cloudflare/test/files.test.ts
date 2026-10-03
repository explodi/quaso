// SPDX-License-Identifier: MIT
/** The real Worker serves immutable published bytes without any container requests. */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@quaso/core";
import { createD1Sql, silentLogger, SYSTEM } from "@quaso/service";
import { startCloudflareService } from "../../server/src/cloudflare_service.ts";
import { SessionCookies } from "../../server/src/sessions.ts";
import { createSessionAsync } from "../../service/src/sessions.ts";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { handleD1 } from "../src/d1_handler.ts";
import { handleR2 } from "../src/r2_handler.ts";
import worker from "../src/worker.ts";
import { PUBLISHED_OBJECT_CACHE, publishedObjectCacheKey } from "../src/files.ts";
import { env } from "./env.ts";

const NOW = Date.UTC(2026, 9, 3);
const FILE = "menus/main.json";
const CONTENT = '{"hello":"Hello"}\n';
const bindings = env as unknown as Env;
const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), env.DB) });
async function privateFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  if (new URL(request.url).hostname === "d1.quaso.internal") return handleD1(request, env.DB);
  return handleR2(request, env.BACKUPS);
}
async function host() {
  let now = NOW;
  const opened = await startCloudflareService({
    secretKey: env.SECRET_KEY,
    logger: silentLogger,
    fetch: privateFetch,
    clock: () => now,
  });
  await opened.service.upload(SYSTEM, {
    files: [{ path: FILE, repoPath: FILE, content: CONTENT }],
    languages: ["de"],
  });
  now += 5000;
  await opened.alarm();
  return opened;
}
async function call(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://quaso.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    { ...bindings, ...overrides },
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, text };
}
const path = () => `/files/de/${FILE}?test=${crypto.randomUUID()}`;
const container = env.QUASO_CONTAINER.get(env.QUASO_CONTAINER.idFromName("main"));

describe("published downloads through the Worker", () => {
  beforeEach(async () => {
    await resetUploadSql(sql);
    const objects = await env.BACKUPS.list();
    const cache = await caches.open(PUBLISHED_OBJECT_CACHE);
    await Promise.all(
      objects.objects.map((object) =>
        cache.delete(publishedObjectCacheKey(env.PUBLIC_URL, object.key)),
      ),
    );
    await env.BACKUPS.delete(objects.objects.map((object) => object.key));
    const opened = await host();
    opened.close();
  });
  it("serves R2 and cache hits with full SHA validators, HEAD and conditional GET without waking", async () => {
    const before = await container.served();
    const url = path();
    const first = await call(url);
    expect(first.status).toBe(200);
    expect(first.text).toBe(CONTENT);
    const etag = `"${sha256Hex(CONTENT)}"`;
    expect(first.headers.get("ETag")).toBe(etag);
    expect(first.headers.get("Last-Modified")).toBe(new Date(NOW + 5000).toUTCString());
    expect(first.headers.get("X-Quaso-Cache")).toBe("miss");
    expect(first.headers.get("Cache-Control")).toBe(
      "public, max-age=30, stale-while-revalidate=300",
    );
    expect((await call(url)).headers.get("X-Quaso-Cache")).toBe("hit");
    const unchanged = await call(url, { headers: { "If-None-Match": `"other", W/${etag}` } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");
    expect(unchanged.headers.get("X-Quaso-Cache")).toBe("hit");
    expect((await call(url, { headers: { "If-None-Match": "*" } })).status).toBe(304);
    const head = await call(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("ETag")).toBe(etag);
    expect(await container.served()).toBe(before);
  });
  it("checks API keys directly, keeps credentialed reads private and refuses revocation", async () => {
    const opened = await host();
    try {
      const key = await opened.service.createApiToken(SYSTEM, { name: "CI", scope: "read" });
      const before = await container.served();
      const url = path();
      await call(url);
      const headers = { Authorization: `Bearer ${key.secret}` };
      const read = await call(url, { headers });
      expect(read.status).toBe(200);
      expect(read.text).toBe(CONTENT);
      expect(read.headers.get("Cache-Control")).toBe("private, no-store");
      expect(read.headers.get("X-Quaso-Cache")).toBe("bypass");
      await opened.service.revokeApiToken(SYSTEM, { id: key.id });
      expect((await call(url, { headers })).status).toBe(401);
      expect((await call(url, { headers: { Authorization: "invalid" } })).status).toBe(401);
      expect(await container.served()).toBe(before);
    } finally {
      opened.close();
    }
  });
  it("reads signed sessions, renews an expired token, and clears invalid cookies without waking", async () => {
    await sql.migrate([
      {
        sql: "INSERT INTO users (id, email, display_name, role, created_at) VALUES (1, 'admin@quaso.test', 'Admin', 'administrator', 1)",
      },
    ]);
    const session = await createSessionAsync(sql, 1, Date.now());
    const cookies = new SessionCookies({
      secretKey: env.SECRET_KEY,
      secure: true,
      service: { resolveSession: async () => null },
    });
    const value = (await cookies.issue(session.sessionId, 1)).split(";")[0];
    const before = await container.served();
    const url = path();
    const read = await call(url, { headers: { Cookie: value } });
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    const oldCookies = new SessionCookies({
      secretKey: env.SECRET_KEY,
      secure: true,
      service: { resolveSession: async () => null },
      now: () => Date.now() - 7_200_000,
    });
    const old = (await oldCookies.issue(session.sessionId, 1)).split(";")[0];
    const renewed = await call(url, { headers: { Cookie: old } });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("Set-Cookie")).toContain("quaso_session=");
    expect(renewed.headers.get("Set-Cookie")).not.toContain("Max-Age=0");
    const cleared = await call(url, { headers: { Cookie: "quaso_session=invalid" } });
    expect(cleared.status).toBe(200);
    expect(cleared.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(cleared.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await container.served()).toBe(before);
  });
  it("preserves CORS, preflight, security headers and method/path validation", async () => {
    const options = { CORS_ORIGINS: "https://allowed.example" } as Partial<Env>;
    const url = path();
    const read = await call(url, { headers: { Origin: "https://allowed.example" } }, options);
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
    expect(read.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(read.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(read.headers.get("X-Request-Id")).not.toBeNull();
    expect(
      (
        await call(
          url,
          { method: "OPTIONS", headers: { Origin: "https://allowed.example" } },
          options,
        )
      ).status,
    ).toBe(204);
    expect((await call(url, { method: "POST" })).status).toBe(405);
    expect((await call("/files")).status).toBe(404);
    expect((await call("/files/de/%2Fbackups%2Fprivate.json")).status).toBe(400);
    expect((await call("/files/de/menus%2F..%2Fprivate.json")).status).toBe(400);
    expect((await call("/files/de/menus%FF.json")).status).toBe(400);
  });
  it("reads the current immutable version even when the latest alias was not repaired", async () => {
    const url = path();
    await env.BACKUPS.put(`published/de/${FILE}`, "wrong alias");
    expect((await call(url)).text).toBe(CONTENT);
    expect((await call(url)).headers.get("X-Quaso-Cache")).toBe("hit");
    await sql.migrate([{ sql: "UPDATE file_versions SET replaced_at = 10 WHERE language = 'de'" }]);
    const missing = await call(url);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("refuses corrupt and missing published objects without waking the container", async () => {
    const [rows] = await sql.read([
      { sql: "SELECT store_key FROM file_versions WHERE language = 'de' AND replaced_at IS NULL" },
    ]);
    const key = String(rows[0].store_key);
    const before = await container.served();
    await env.BACKUPS.put(key, "corrupt");
    expect((await call(path())).status).toBe(503);
    await env.BACKUPS.delete(key);
    expect((await call(path())).status).toBe(410);
    expect(await container.served()).toBe(before);
  });
  it("uses a restored D1 pointer even when the download URL already has cached bytes", async () => {
    const url = path();
    expect((await call(url)).text).toBe(CONTENT);
    expect((await call(url)).headers.get("X-Quaso-Cache")).toBe("hit");
    const restored = '{"hello":"Earlier publication"}\n';
    const hash = sha256Hex(restored);
    const key = `versions/de/${FILE}/restored-${hash.slice(0, 8)}`;
    await env.BACKUPS.put(key, restored);
    await sql.migrate([
      {
        sql: "UPDATE file_versions SET store_key = ?, sha256 = ?, size = ? WHERE language = 'de' AND replaced_at IS NULL",
        params: [key, hash, new TextEncoder().encode(restored).length],
      },
    ]);
    const response = await call(url);
    expect(response.status).toBe(200);
    expect(response.text).toBe(restored);
    expect(response.headers.get("ETag")).toBe(`"${hash}"`);
    expect(response.headers.get("X-Quaso-Cache")).toBe("miss");
    expect((await call(url)).headers.get("X-Quaso-Cache")).toBe("hit");
  });
  it("rechecks key revocation after object I/O", async () => {
    const opened = await host();
    try {
      const key = await opened.service.createApiToken(SYSTEM, {
        name: "Concurrent",
        scope: "read",
      });
      const bucket = {
        async get(...args: Parameters<R2Bucket["get"]>) {
          const object = await env.BACKUPS.get(...args);
          await opened.service.revokeApiToken(SYSTEM, { id: key.id });
          return object;
        },
      } as unknown as R2Bucket;
      const revoked = await call(
        path(),
        { headers: { Authorization: `Bearer ${key.secret}` } },
        { BACKUPS: bucket },
      );
      expect(revoked.status).toBe(401);
      expect(JSON.parse(revoked.text).error.code).toBe("unauthorized");
    } finally {
      opened.close();
    }
  });
});
