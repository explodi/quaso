// SPDX-License-Identifier: MIT
/**
 * The Worker's cache, in front of a fake server (test/worker.ts): what it stores, what it
 * serves, what bypasses it, and stale entries refreshed in the background.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CACHE_STATUS_HEADER,
  cacheableFreshness,
  cacheKey,
  freshness,
  mayUseCache,
  ORIGIN_KEY_PARAM,
  serveWithCache,
} from "../src/cache.ts";
import worker from "../src/worker.ts";
import { env } from "./env.ts";

interface Answer {
  n: number;
  port?: number;
  seen: Record<string, unknown>;
}

const ALLOW_ORIGIN = "Access-Control-Allow-Origin";

/** Calls the Worker and waits for its background work (the cache writes). */
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://quaso.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    env as unknown as Env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return {
    status: response.status,
    cache: response.headers.get(CACHE_STATUS_HEADER),
    headers: response.headers,
    text,
    body: text ? (JSON.parse(text) as Answer) : null,
  };
}

/** A path no other test uses, so each test starts with an empty cache for it. */
const unique = (path: string) => `${path}?test=${crypto.randomUUID()}`;

describe("the Worker's cache", () => {
  it("stores a public anonymous GET, then answers it without the server", async () => {
    const path = unique("/api/v1/project");
    const first = await call(path);
    expect(first.cache).toBe("miss");
    const second = await call(path);
    expect(second.cache).toBe("hit");
    expect(second.body?.n).toBe(first.body?.n);
    expect(second.headers.get("Cache-Control")).toBe(
      "public, max-age=30, stale-while-revalidate=300",
    );
    expect(second.headers.get("Vary")).toBe("Authorization, Cookie, Accept-Encoding");
    expect(Number(second.headers.get("Age"))).toBeLessThan(30);
    for (const name of second.headers.keys()) expect(name).not.toMatch(/^x-quaso-(stored|origin)/);

    const head = await call(path, { method: "HEAD" });
    expect(head.cache).toBe("hit");
    expect(head.text).toBe("");
  });

  it("lets requests with a cookie or an API key through, every time", async () => {
    const path = unique("/api/v1/project");
    await call(path);
    const credentials: Record<string, string>[] = [
      { Cookie: "session=1" },
      { Authorization: "Bearer qso_x" },
    ];
    for (const headers of credentials) {
      const first = await call(path, { headers });
      const second = await call(path, { headers });
      expect([first.cache, second.cache]).toEqual(["bypass", "bypass"]);
      expect(second.body!.n).toBe(first.body!.n + 1);
    }
    expect((await call(path, { headers: { Cookie: "session=1" } })).body?.seen.cookie).toBe(
      "session=1",
    );
  });

  it("never stores private answers, cookies being set, or errors", async () => {
    for (const base of ["/api/test/private", "/api/test/cookie", "/api/test/missing"]) {
      const path = unique(base);
      const first = await call(path);
      const second = await call(path);
      expect([first.cache, second.cache], base).toEqual(["miss", "miss"]);
      expect(second.body!.n, base).toBe(first.body!.n + 1);
    }
  });

  it("forwards writes and other methods", async () => {
    const response = await call(unique("/api/v1/sources"), { method: "POST", body: "{}" });
    expect(response.cache).toBe("bypass");
    expect(response.body?.seen.method).toBe("POST");
    expect(response.body?.seen.body).toBe("{}");
  });

  it("tells the server who is asking, and asks for an uncompressed answer", async () => {
    const response = await call(unique("/api/v1/sources"), {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.7",
        "X-Forwarded-For": "198.51.100.1",
        "CF-Ray": "8c1a2b3c4d5e6f70-AMS",
        "Accept-Encoding": "gzip, br",
      },
    });
    expect(response.body?.seen).toMatchObject({
      forwardedFor: "203.0.113.7",
      forwardedProto: "https",
      requestId: "8c1a2b3c4d5e6f70-AMS",
      acceptEncoding: null,
    });
    const spoofed = await call(unique("/api/test/x"), {
      method: "POST",
      headers: { "X-Forwarded-For": "198.51.100.1", "X-Request-Id": "made-up" },
    });
    expect(spoofed.body?.seen).toMatchObject({ forwardedFor: null, requestId: null });
  });

  it("answers 503 when the container doesn't start", async () => {
    const response = await call("/api/test/down");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(JSON.parse(response.text).error.code).toBe("unavailable");
  });

  it("answers its own 503 for the container library's plain-text errors", async () => {
    for (const path of [
      "/api/test/no-instance",
      "/api/test/start-failed",
      "/api/test/rate-limited",
    ]) {
      const response = await call(path, { headers: { "CF-Ray": "ray-123" } });
      expect(response.status, path).toBe(503);
      expect(response.headers.get("Content-Type"), path).toMatch(/^application\/json/);
      expect(response.headers.get("Retry-After"), path).toBe("10");
      expect(response.headers.get("Cache-Control"), path).toBe("private, no-store");
      expect(response.headers.get("X-Request-Id"), path).toBe("ray-123");
      expect(JSON.parse(response.text).error, path).toEqual({
        code: "unavailable",
        message: "Quaso is starting up or unavailable. Try again in a moment.",
      });
    }
    // The server's own errors pass as they are.
    const failing = await call(unique("/api/test/failing"));
    expect(failing.status).toBe(500);
    expect(failing.body?.seen.path).toBe("/failing");
  });

  it("never lets a client choose the container's port", async () => {
    const chosen = await call("/api/test/port", {
      headers: { "cf-container-target-port": "9229" },
    });
    expect(chosen.body?.port).toBe(8000);
    const junk = await call("/api/test/port", { headers: { "cf-container-target-port": "abc" } });
    expect([junk.status, junk.body?.port]).toEqual([200, 8000]);
    const posted = await call(unique("/api/v1/sources"), {
      method: "POST",
      headers: { "CF-Container-Target-Port": "9229", "cf-container-anything": "x" },
    });
    expect(posted.body?.seen.containerHeaders).toEqual([]);
  });

  it("gives each response its own request's ID, also from the cache", async () => {
    const path = unique("/api/v1/project");
    const first = await call(path, { headers: { "CF-Ray": "ray-AAA" } });
    expect([first.cache, first.headers.get("X-Request-Id")]).toEqual(["miss", "ray-AAA"]);
    const second = await call(path, { headers: { "CF-Ray": "ray-BBB" } });
    expect([second.cache, second.headers.get("X-Request-Id")]).toEqual(["hit", "ray-BBB"]);
    const third = await call(path, { headers: { "CF-Ray": "not a valid ID!" } });
    expect([third.cache, third.headers.get("X-Request-Id")]).toEqual(["hit", null]);
  });

  it("keeps one copy per Origin when the server varies on it (CORS_ORIGINS)", async () => {
    const path = unique("/api/test/cors");
    const get = (origin: string | null) =>
      call(path, origin ? { headers: { Origin: origin } } : {});
    const expected: [string | null, string | null][] = [
      ["https://a.example", "https://a.example"],
      ["https://b.example", "https://b.example"],
      [null, null],
      ["https://evil.example", null],
    ];
    for (const [origin, allowed] of expected) {
      const first = await get(origin);
      expect([first.cache, first.headers.get(ALLOW_ORIGIN)], String(origin)).toEqual([
        "miss",
        allowed,
      ]);
    }
    for (const [origin, allowed] of expected) {
      const again = await get(origin);
      expect([again.cache, again.headers.get(ALLOW_ORIGIN)], String(origin)).toEqual([
        "hit",
        allowed,
      ]);
      expect(again.headers.get("Vary")).toBe("Authorization, Cookie, Origin, Accept-Encoding");
    }
  });

  it("never lets a URL reach another request's copy through the key's parameter", async () => {
    const path = unique("/api/test/cors");
    const forged = `${path}&${ORIGIN_KEY_PARAM}=${encodeURIComponent("https://a.example")}`;
    // Without an Origin, the forged URL would have the key of path's copy for a.example.
    const first = await call(forged);
    const second = await call(forged);
    expect([first.cache, second.cache]).toEqual(["bypass", "bypass"]);
    const real = await call(path, { headers: { Origin: "https://a.example" } });
    expect([real.cache, real.headers.get(ALLOW_ORIGIN)]).toEqual(["miss", "https://a.example"]);
  });

  it("doesn't store answers that vary on other request headers", async () => {
    const path = unique("/api/test/language");
    const first = await call(path, { headers: { "Accept-Language": "pl" } });
    const second = await call(path, { headers: { "Accept-Language": "de" } });
    expect([first.cache, second.cache]).toEqual(["miss", "miss"]);
    expect(second.body!.n).toBe(first.body!.n + 1);
  });
});

describe("stale entries", () => {
  it("serves a stale copy and refreshes it in the background, then expires it", async () => {
    const cache = await caches.open(`test-${crypto.randomUUID()}`);
    let now = Date.UTC(2026, 8, 24, 12);
    let served = 0;
    const pending: Promise<unknown>[] = [];
    const options = {
      cache,
      now: () => now,
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      origin: () =>
        Promise.resolve(
          new Response(String(++served), {
            headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" },
          }),
        ),
    };
    const get = async () => {
      const response = await serveWithCache(new Request("https://quaso.test/a"), options);
      const text = await response.text();
      await Promise.all(pending.splice(0));
      return [response.headers.get(CACHE_STATUS_HEADER), text, response.headers.get("Age")];
    };
    expect(await get()).toEqual(["miss", "1", null]);
    now += 10_000;
    expect(await get()).toEqual(["hit", "1", "10"]);
    now += 25_000;
    expect(await get()).toEqual(["stale", "1", "35"]);
    // The refresh stored the server's new answer.
    expect(await get()).toEqual(["hit", "2", "0"]);
    now += 400_000;
    expect(await get()).toEqual(["miss", "3", null]);
    expect(served).toBe(3);
  });

  it("refreshes a copy for an Origin with that Origin", async () => {
    const cache = await caches.open(`test-${crypto.randomUUID()}`);
    let now = 0;
    const origins: (string | null)[] = [];
    const pending: Promise<unknown>[] = [];
    const options = {
      cache,
      now: () => now,
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      origin: (request: Request) => {
        const origin = request.headers.get("Origin");
        origins.push(origin);
        return Promise.resolve(
          new Response(String(origin), {
            headers: {
              "Cache-Control": "public, max-age=1, stale-while-revalidate=60",
              Vary: "Origin",
            },
          }),
        );
      },
    };
    const get = async (origin: string) => {
      const request = new Request("https://quaso.test/c", { headers: { Origin: origin } });
      const response = await serveWithCache(request, options);
      const text = await response.text();
      await Promise.all(pending.splice(0));
      return [response.headers.get(CACHE_STATUS_HEADER), text];
    };
    expect(await get("https://a.example")).toEqual(["miss", "https://a.example"]);
    now = 5_000;
    expect(await get("https://a.example")).toEqual(["stale", "https://a.example"]);
    expect(origins).toEqual(["https://a.example", "https://a.example"]);
    expect(await get("https://a.example")).toEqual(["hit", "https://a.example"]);
  });

  it("keeps the stale copy when the refresh fails", async () => {
    const cache = await caches.open(`test-${crypto.randomUUID()}`);
    let now = 0;
    let fail = false;
    const pending: Promise<unknown>[] = [];
    const options = {
      cache,
      now: () => now,
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      origin: () =>
        fail
          ? Promise.reject(new Error("asleep"))
          : Promise.resolve(
              new Response("ok", {
                headers: { "Cache-Control": "public, max-age=1, stale-while-revalidate=60" },
              }),
            ),
    };
    await (await serveWithCache(new Request("https://quaso.test/b"), options)).text();
    await Promise.all(pending.splice(0));
    fail = true;
    now = 5_000;
    const response = await serveWithCache(new Request("https://quaso.test/b"), options);
    expect(response.headers.get(CACHE_STATUS_HEADER)).toBe("stale");
    await Promise.all(pending.splice(0));
    const again = await serveWithCache(new Request("https://quaso.test/b"), options);
    expect([again.headers.get(CACHE_STATUS_HEADER), await again.text()]).toEqual(["stale", "ok"]);
  });
});

describe("cache rules", () => {
  it("reads Cache-Control", () => {
    expect(freshness("public, max-age=30, stale-while-revalidate=300")).toEqual({
      maxAge: 30,
      staleWhileRevalidate: 300,
    });
    expect(freshness("public, max-age=31536000, immutable")).toEqual({
      maxAge: 31536000,
      staleWhileRevalidate: 0,
    });
    expect(freshness("public, s-maxage=60, max-age=5")).toEqual({
      maxAge: 60,
      staleWhileRevalidate: 0,
    });
    for (const refused of [
      "private, no-store",
      "public, no-store, max-age=30",
      "public, no-cache, max-age=30",
      "max-age=30",
      "public",
      "public, max-age=0",
      "public, max-age=abc",
      null,
    ]) {
      expect(freshness(refused), String(refused)).toBeNull();
    }
  });

  it("stores only 200s without cookies, and with the Vary names it can honour", () => {
    const headers = { "Cache-Control": "public, max-age=30" };
    expect(cacheableFreshness(new Response("", { headers }))).not.toBeNull();
    const vary = (value: string) =>
      cacheableFreshness(new Response("", { headers: { ...headers, Vary: value } }));
    expect(vary("Authorization, cookie, Accept-Encoding, Origin")).not.toBeNull();
    for (const refused of ["Accept-Language", "Origin, User-Agent", "accept"]) {
      expect(vary(refused), refused).toBeNull();
    }
    expect(cacheableFreshness(new Response("", { status: 404, headers }))).toBeNull();
    expect(cacheableFreshness(new Response("", { status: 206, headers }))).toBeNull();
    expect(
      cacheableFreshness(new Response("", { headers: { ...headers, "Set-Cookie": "a=b" } })),
    ).toBeNull();
    expect(cacheableFreshness(new Response("", { headers: { ...headers, Vary: "*" } }))).toBeNull();
  });

  it("keys by the URL, and the Origin when there is one", () => {
    const key = (url: string, headers: Record<string, string> = {}) =>
      cacheKey(new Request(url, { headers }))?.url ?? null;
    expect(key("https://quaso.test/api/v1/project?x=%2B+y")).toBe(
      "https://quaso.test/api/v1/project?x=%2B+y",
    );
    expect(key("https://quaso.test/a", { Origin: "https://a.example" })).toBe(
      `https://quaso.test/a?${ORIGIN_KEY_PARAM}=https%3A%2F%2Fa.example`,
    );
    expect(key("https://quaso.test/a?x=1", { Origin: "null" })).toBe(
      `https://quaso.test/a?x=1&${ORIGIN_KEY_PARAM}=null`,
    );
    expect(key(`https://quaso.test/a?${ORIGIN_KEY_PARAM}=x`)).toBeNull();
    expect(key(`https://quaso.test/a?%71uaso-cache-origin=x`)).toBeNull();
    expect(cacheKey(new Request("https://quaso.test/a"), "new-version")?.url).toBe(
      "https://quaso.test/a?__quaso_version=new-version",
    );
    expect(
      cacheKey(new Request("https://quaso.test/a?__quaso_version=old-version"), "new-version"),
    ).toBeNull();
  });

  it("uses the cache only for whole anonymous reads", () => {
    const request = (init: RequestInit) => new Request("https://quaso.test/", init);
    expect(mayUseCache(request({}))).toBe(true);
    expect(mayUseCache(request({ method: "HEAD" }))).toBe(true);
    expect(mayUseCache(request({ method: "POST" }))).toBe(false);
    expect(mayUseCache(request({ headers: { Cookie: "a=b" } }))).toBe(false);
    expect(mayUseCache(request({ headers: { Authorization: "Bearer x" } }))).toBe(false);
    expect(mayUseCache(request({ headers: { Range: "bytes=0-10" } }))).toBe(false);
  });
});
