// SPDX-License-Identifier: MIT
/**
 * The Worker under test: the real one (`src/worker.ts`), plus a fake server in place of the
 * container, and a bare Durable Object for the adapters' tests.
 */
import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import { CONTAINER_PORT, type StartupStatus } from "../src/container.ts";

// Everything the real Worker exports, so that the runtime refuses the same mistakes.
export * from "../src/worker.ts";
export { default } from "../src/worker.ts";
export { QuasoData } from "../src/data_object.ts";

/** A bare Durable Object: tests use its storage through `runInDurableObject`. */
export class TestObject extends DurableObject {
  /** Tests that set alarms don't run anything when they fire. */
  override alarm(): void {}
}

/**
 * Stands in for the server in the container. Each answer carries how many requests the
 * fake has served (`n`), so the tests can tell a cached answer from a fresh one, and the
 * request it saw. Like the server behind the Worker (TRUST_PROXY), it answers with the
 * request's `X-Request-Id`, or a new one. The path, after `/api/test`, chooses the answer:
 * - `/private` answers `private, no-store`, as the server does for signed-in requests;
 * - `/cookie` sets a cookie on an otherwise public answer;
 * - `/missing` is a 404;
 * - `/cors` allows the origins https://a.example and https://b.example, with
 *   `Vary: Origin`, as the server does with `CORS_ORIGINS`;
 * - `/language` varies on `Accept-Language`;
 * - `/failing` is the server's own 500, with its request ID;
 * - `/port` answers the port `@cloudflare/containers` would connect to, from its own
 *   `Container.fetch` (`{ port }`);
 * - `/down` throws, like a container that doesn't start;
 * - `/no-instance` (503), `/start-failed` (500) and `/rate-limited` (429) answer in plain
 *   text without a request ID, as `@cloudflare/containers` does;
 * - anything else is public for 30 seconds, then stale for 300, like the API's reads.
 */
export class FakeContainer extends DurableObject {
  #served = 0;
  async pauseForRestore(key: string, force: boolean) {
    await this.ctx.storage.put("restoreControl", ["pause", key, force]);
  }
  async resumeAfterRestore(key: string, force: boolean) {
    await this.ctx.storage.put("restoreControl", ["resume", key, force]);
  }
  async restoreControl() {
    return this.ctx.storage.get("restoreControl");
  }
  /** Ready, unless a test set another status with `setStartupStatus`. */
  async startupStatus(): Promise<StartupStatus> {
    return (await this.ctx.storage.get<StartupStatus>("startupStatus")) ?? { state: "ready" };
  }
  async setStartupStatus(status: StartupStatus) {
    await this.ctx.storage.put("startupStatus", status);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The tests' paths are under /api/test/, which the Worker sends to the server.
    url.pathname = url.pathname.replace(/^\/api\/test(?=\/)/, "");
    if (url.pathname === "/down") throw new Error("The container didn't start");
    if (url.pathname === "/port") return await portFor(request);
    const library = LIBRARY_ANSWERS[url.pathname];
    if (library) return new Response(library.text, { status: library.status });
    const n = ++this.#served;
    const seen = {
      method: request.method,
      path: url.pathname,
      forwardedFor: request.headers.get("X-Forwarded-For"),
      forwardedProto: request.headers.get("X-Forwarded-Proto"),
      requestId: request.headers.get("X-Request-Id"),
      acceptEncoding: request.headers.get("Accept-Encoding"),
      cookie: request.headers.get("Cookie"),
      origin: request.headers.get("Origin"),
      containerHeaders: [...request.headers.keys()].filter((name) =>
        name.startsWith("cf-container-"),
      ),
      body: request.method === "POST" ? await request.text() : null,
    };
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      Vary: "Authorization, Cookie, Accept-Encoding",
      Date: new Date().toUTCString(),
    });
    let status = 200;
    if (url.pathname === "/private") headers.set("Cache-Control", "private, no-store");
    if (url.pathname === "/cookie") headers.set("Set-Cookie", "session=abc; HttpOnly");
    if (url.pathname === "/missing") {
      status = 404;
      headers.set("Cache-Control", "private, no-store");
    }
    if (url.pathname === "/cors") {
      headers.set("Vary", "Authorization, Cookie, Origin, Accept-Encoding");
      const origin = request.headers.get("Origin");
      if (origin === "https://a.example" || origin === "https://b.example") {
        headers.set("Access-Control-Allow-Origin", origin);
      }
    }
    if (url.pathname === "/language") headers.set("Vary", "Accept-Language");
    if (url.pathname === "/failing") {
      status = 500;
      headers.set("Cache-Control", "private, no-store");
    }
    headers.set("X-Request-Id", request.headers.get("X-Request-Id") ?? crypto.randomUUID());
    return new Response(JSON.stringify({ n, seen }), { status, headers });
  }

  served(): number {
    return this.#served;
  }
}

/**
 * The port the library's `Container.fetch` picks for a request, with the Worker's default
 * port (a real container can't run here, so `containerFetch` only reports the port).
 */
function portFor(request: Request): Promise<Response> {
  const container = {
    defaultPort: CONTAINER_PORT,
    containerFetch: (_request: Request, port: number) =>
      Response.json({ port }, { headers: { "X-Request-Id": "port" } }),
  };
  return Container.prototype.fetch.call(container as unknown as Container, request);
}

/** What `@cloudflare/containers` answers itself, in plain text, when it can't proxy. */
const LIBRARY_ANSWERS: Record<string, { status: number; text: string }> = {
  "/no-instance": { status: 503, text: "There is no Container instance available at this time." },
  "/start-failed": {
    status: 500,
    text: "Failed to start container: container port not found. Make sure you exposed the port.",
  },
  "/rate-limited": { status: 429, text: "Too many requests to start the container." },
};
