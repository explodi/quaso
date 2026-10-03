// SPDX-License-Identifier: MIT
/** Published downloads read D1 metadata and immutable R2 bytes without starting the container. */
import {
  authenticateTokenAsync,
  createD1Sql,
  createR2Store,
  type Logger,
  ServiceError,
} from "@quaso/service";
import { readPublishedFile } from "../../service/src/file_reads.ts";
import { resolveSessionAsync } from "../../service/src/sessions.ts";
import { createAuthenticator } from "../../server/src/auth.ts";
import { conditionalResponse } from "../../server/src/http/conditional.ts";
import { allowedOrigin, preflightResponse, setCorsHeaders } from "../../server/src/http/cors.ts";
import {
  methodNotAllowedResponse,
  notFoundResponse,
  toErrorResponse,
} from "../../server/src/http/errors.ts";
import {
  hasCredentials,
  setCacheHeaders,
  setSecurityHeaders,
} from "../../server/src/http/headers.ts";
import { publishedFiles } from "../../server/src/routes/files.ts";
import { insecureLocal, SessionCookies } from "../../server/src/sessions.ts";
import { handleD1 } from "./d1_handler.ts";
import { handleR2 } from "./r2_handler.ts";

export const PUBLISHED_OBJECT_CACHE = "quaso-published-objects";

export function publishedObjectCacheKey(publicUrl: string, key: string): Request {
  const url = new URL("/.quaso-published-object", publicUrl);
  url.searchParams.set("key", key);
  return new Request(url);
}

export async function servePublishedFile(
  request: Request,
  env: Env,
  log: Logger,
  requestId: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const sql = createD1Sql({ fetch: (input, init) => handleD1(new Request(input, init), env.DB) });
  const store = createR2Store({
    fetch: (input, init) => handleR2(new Request(input, init), env.BACKUPS),
  });
  let cacheStatus = "bypass";
  let pending: { key: Request; bytes: Uint8Array } | undefined;
  const objectCache = hasCredentials(request)
    ? null
    : await caches.open(PUBLISHED_OBJECT_CACHE).catch((error) => {
        log.warn("Couldn't open the published object cache", { error });
        return null;
      });
  const cachedStore = {
    ...store,
    async read(key: string) {
      if (objectCache === null) return store.read(key);
      const cacheKey = publishedObjectCacheKey(env.PUBLIC_URL, key);
      const cached = await objectCache.match(cacheKey).catch((error) => {
        log.warn("Couldn't read cached published bytes", { error });
        return undefined;
      });
      if (cached !== undefined) {
        cacheStatus = "hit";
        return new Uint8Array(await cached.arrayBuffer());
      }
      cacheStatus = "miss";
      const bytes = await store.read(key);
      if (bytes !== null) pending = { key: cacheKey, bytes };
      return bytes;
    },
  };
  const service = {
    async getPublishedFile(actor: Parameters<typeof readPublishedFile>[2], input: unknown) {
      // Cache only verified immutable bytes; D1 permissions and the current pointer stay live.
      const result = await readPublishedFile(sql, cachedStore, actor, input);
      if (pending && objectCache) {
        const response = new Response(pending.bytes as BodyInit, {
          headers: { "Cache-Control": "public, max-age=2592000" },
        });
        waitUntil(
          objectCache.put(pending.key, response).catch((error) => {
            log.warn("Couldn't cache published bytes", { error });
          }),
        );
      }
      return result;
    },
    authenticateToken: (
      actor: Parameters<typeof authenticateTokenAsync>[1],
      input: { secret: string },
    ) => authenticateTokenAsync(sql, actor, input.secret, Date.now()),
    resolveSession: (
      actor: Parameters<typeof resolveSessionAsync>[1],
      input: { sessionId: string },
    ) => resolveSessionAsync(sql, actor, input.sessionId, Date.now()),
  };
  const auth = createAuthenticator(service);
  const cookies = new SessionCookies({
    service,
    secretKey: env.SECRET_KEY,
    secure: !insecureLocal(env.PUBLIC_URL),
  });
  const url = new URL(request.url);
  const all = env as unknown as Record<string, unknown>;
  const origins =
    typeof all.CORS_ORIGINS === "string"
      ? all.CORS_ORIGINS.split(",").map((origin) => origin.trim().replace(/\/$/, ""))
      : [];
  const cors = allowedOrigin(request, url.pathname, origins);
  let setCookie: string | null = null;
  let response: Response;
  try {
    const params = /^\/files\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (request.method === "OPTIONS" && cors !== null) response = preflightResponse(cors);
    else if (params === null) response = notFoundResponse(url.pathname);
    else if (!["GET", "HEAD"].includes(request.method))
      response = methodNotAllowedResponse(request.method, url.pathname, ["GET", "HEAD"]);
    else {
      const session = await cookies.read(request, true);
      setCookie = session.setCookie;
      response = await publishedFiles(
        service,
        auth,
      )({
        request,
        url,
        requestId,
        session: session.session,
        params: { language: decodePath(params[1]), file: decodePath(params[2]) },
      });
    }
  } catch (error) {
    response = toErrorResponse(error, {
      requestId,
      log,
      method: request.method,
      path: url.pathname,
    });
  }
  const headers = new Headers(response.headers);
  if (setCookie !== null) headers.set("Set-Cookie", setCookie);
  if (cors !== null) setCorsHeaders(headers, cors);
  setSecurityHeaders(headers, { hsts: env.PUBLIC_URL.startsWith("https:") });
  setCacheHeaders(headers, {
    method: request.method,
    pathname: url.pathname,
    status: response.status,
    credentials: hasCredentials(request),
  });
  headers.set("X-Request-Id", requestId);
  headers.set("X-Quaso-Cache", cacheStatus);
  return conditionalResponse(
    request,
    new Response(response.body, { status: response.status, headers }),
  );
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ServiceError("bad_request", "The file path has invalid URL encoding.");
  }
}
