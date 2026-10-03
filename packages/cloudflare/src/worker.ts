// SPDX-License-Identifier: MIT
/** The public Worker caches reads and forwards requests; storage handlers are private outbound bindings. */
import { type Logger } from "@quaso/service";
import { serveWithCache } from "./cache.ts";
import { CONTAINER_NAME, locationHint, QuasoContainer } from "./container.ts";
import { createLogger } from "./log.ts";
import { servePublishedFile } from "./files.ts";
export { QuasoContainer };
export { ContainerProxy } from "@cloudflare/containers";

const REQUEST_ID = /^[\w.:-]{1,128}$/;
const CONTAINER_HEADERS = /^cf-container-/i;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (/^\/(internal|batch|object|objects)(\/|$)/.test(url.pathname))
      return error(404, "not_found", "The internal service API is not available.");
    const maintenance = env as unknown as Record<string, unknown>;
    const paused = maintenance.QUASO_RESTORE_PAUSED === "true";
    const control = /^\/api\/v1\/restore\/(pause|resume)$/.exec(url.pathname);
    if (control) {
      const key = maintenance.QUASO_RESTORE_KEY;
      const resuming = control[1] === "resume" && typeof key === "string";
      if (!paused && !resuming) return error(404, "not_found", "Restore control is not enabled.");
      const provided = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      if (request.method !== "POST" || typeof key !== "string" || !sameKey(key, provided))
        return error(403, "forbidden", "Restore control requires the temporary operator key.");
      const controller = env.QUASO_CONTAINER.get(env.QUASO_CONTAINER.idFromName(CONTAINER_NAME));
      const body = (await request.json()) as { force?: unknown };
      if (control[1] === "pause") await controller.pauseForRestore(key, body.force === true);
      else {
        await controller.resumeAfterRestore(key, body.force === true);
      }
      return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (paused)
      return error(503, "unavailable", "The instance is paused for restoration.", {
        "Retry-After": "60",
      });
    const log = createLogger("worker");
    const requestId = requestIdOf(request);
    if (/^\/files(\/|$)/.test(url.pathname))
      return servePublishedFile(request, env, log, requestId ?? crypto.randomUUID(), (promise) =>
        ctx.waitUntil(promise),
      );
    return serveWithCache(request, {
      cache: caches.default,
      namespace: env.CF_VERSION_METADATA?.id,
      origin: (forward) => toContainer(forward, env, log, requestId),
      waitUntil: (promise) => ctx.waitUntil(promise),
      requestId,
      log,
    });
  },
} satisfies ExportedHandler<Env>;

function sameKey(expected: string, actual: string): boolean {
  if (expected.length !== 64 || actual.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++)
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}

/** The request's ID, for the server and the logs: Cloudflare's `CF-Ray`, when it has one. */
function requestIdOf(request: Request): string | null {
  const ray = request.headers.get("CF-Ray");
  return ray && REQUEST_ID.test(ray) ? ray : null;
}

/**
 * Forwards a request to the server in the container, with the client's address and the
 * request's ID, and asks for an uncompressed answer (Cloudflare compresses what it sends
 * to browsers, and the cache keeps one form). Headers meant for `@cloudflare/containers`
 * are dropped: only the Worker chooses the container's port.
 */
async function toContainer(
  request: Request,
  env: Env,
  log: Logger,
  requestId: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (CONTAINER_HEADERS.test(name)) headers.delete(name);
  }
  const ip = headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Forwarded-For", ip);
  else headers.delete("X-Forwarded-For");
  headers.set("X-Forwarded-Proto", url.protocol.replace(/:$/, ""));
  headers.set("X-Forwarded-Host", url.host);
  if (requestId) headers.set("X-Request-Id", requestId);
  else headers.delete("X-Request-Id");
  headers.delete("Accept-Encoding");

  const namespace = env.QUASO_CONTAINER;
  const hint = locationHint(env.LOCATION_HINT);
  const container = namespace.get(
    namespace.idFromName(CONTAINER_NAME),
    hint ? { locationHint: hint } : undefined,
  );
  const unavailable = () =>
    error(503, "unavailable", "Quaso is starting up or unavailable. Try again in a moment.", {
      "Retry-After": "10",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    });
  let response: Response;
  try {
    response = await container.fetch(new Request(request, { headers }));
  } catch (cause) {
    log.error("The container didn't answer", { path: url.pathname, error: cause });
    return unavailable();
  }
  if (!fromServer(response)) {
    // `@cloudflare/containers` answers in plain text when the container can't start, isn't
    // provisioned yet, or disconnects.
    const detail = await response.text().catch(() => "");
    log.error("The container didn't answer", {
      path: url.pathname,
      status: response.status,
      detail: detail.slice(0, 500),
    });
    return unavailable();
  }
  return response;
}

/**
 * Whether an error response came from the Quaso server, which puts `X-Request-Id` on every
 * response, rather than from `@cloudflare/containers` (a 429, 500 or 503 in plain text).
 */
function fromServer(response: Response): boolean {
  if (response.status < 500 && response.status !== 429) return true;
  return response.headers.has("X-Request-Id");
}

/** A response in the API's error shape. */
function error(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { ...headers, "Cache-Control": "private, no-store" },
    },
  );
}
