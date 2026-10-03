// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The server's request handler (design §3, §5.11): routes each request, authenticates and
 * validates it, calls the service, adds the request ID, security, cache and CORS
 * headers, and compresses text for clients that accept gzip. Tests call it with `Request` objects, without a network.
 */
import { API_BASE } from "@quaso/core";
import {
  type Actor,
  forbidden,
  type Logger,
  type ServiceApi,
  ServiceError,
  SYSTEM,
  unauthorized,
  type Store,
} from "@quaso/service";
import { Accounts } from "./accounts.ts";
import { type Authenticator, createAuthenticator } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Handler, RequestContext } from "./http/context.ts";
import { allowedOrigin, preflightResponse, setCorsHeaders } from "./http/cors.ts";
import { compress } from "./http/compress.ts";
import { methodNotAllowedResponse, notFoundResponse, toErrorResponse } from "./http/errors.ts";
import { hasCredentials, mergeVary, setCacheHeaders, setSecurityHeaders } from "./http/headers.ts";
import {
  clientIp,
  type ConnectionInfo,
  MB,
  parseQuery,
  readJson,
  requestId,
  validateInput,
} from "./http/request.ts";
import { json } from "./http/response.ts";
import { Router } from "./http/router.ts";
import type { ServerLogger } from "./log.ts";
import type { RouteHost } from "./routes/admin.ts";
import { API_ROUTES, type ApiRoute } from "./routes/api.ts";
import { siteRoutes } from "./routes/site.ts";
import { publishedFiles } from "./routes/files.ts";
import { SESSION_COOKIE } from "./sessions.ts";
import { createWebHandler } from "./static.ts";
import { VERSION } from "./version.ts";

export interface AppOptions {
  config: Config;
  service: ServiceApi;
  log: Logger;
  version?: string;
  /** Default: API keys checked with the service, cached for a minute. */
  auth?: Authenticator;
  /** Where the data is, for `/healthz`. Default: local. */
  storage?: "local" | "cloudflare";
  /**
   * Local storage: a consistent copy of the database at a path (backup downloads), and the
   * folder for temporary files. Without it, backups are built from the service's rows.
   */
  backups?: { snapshotTo(path: string): Promise<void>; tempDir: string; store?: Store };
  /**
   * Signs the session and OAuth cookies: `SECRET_KEY`, or with local storage the key the
   * server generated. Default: the config's, else a random one for this process only.
   */
  secretKey?: string;
  /** For the email service, Turnstile and the OAuth providers. Tests pass a fake one. */
  fetch?: Fetch;
  /** The clock of session tokens and rate limits. Tests pass one they control. */
  now?: () => number;
}

export type App = (request: Request, info?: ConnectionInfo) => Promise<Response>;

/** Paths the website's single-page fallback never answers: they get JSON 404s. */
const NOT_WEBSITE = /^\/(api|auth|files|healthz|schema)(\/|$)/;

/** Paths that answer other origins, when `CORS_ORIGINS` lists them. */
const CORS_PATHS = /^\/(api|auth|files)\//;

/** Paths that read the session cookie (design §5.8). */
const SESSION_PATHS = /^\/(api|auth|files)\//;

/** Builds the handler for `serveHttp`. */
export function createApp(options: AppOptions): App {
  const { config, service, log } = options;
  const version = options.version ?? VERSION;
  const auth = options.auth ?? createAuthenticator(service);
  const web = createWebHandler(config.webDir);
  const accounts = new Accounts({
    config,
    service,
    log,
    secretKey: options.secretKey ?? config.secretKey ?? randomSecret(),
    fetch: options.fetch,
    now: options.now,
  });
  const host: RouteHost = {
    version,
    setup: options.storage ?? "local",
    log,
    recentErrors: () => ("recentErrors" in log ? (log as ServerLogger).recentErrors() : []),
    snapshotTo: options.backups?.snapshotTo,
    tempDir: options.backups?.tempDir,
    store: options.backups?.store,
  };

  const router = new Router<Handler>();
  const publicReads = new Router<true>();
  router.add("GET", "/files/:language/:file(.+)", publishedFiles(service, auth));
  publicReads.add("GET", "/files/:language/:file(.+)", true);
  const site = siteRoutes({
    service,
    log,
    version,
    publicUrl: config.publicUrl,
    apiRoutes: API_ROUTES,
    storage: options.storage ?? "local",
  });
  for (const [method, path, handler] of site) router.add(method, path, handler);
  for (const route of API_ROUTES) {
    // The session response contains private account data despite being available to
    // anonymous visitors. Every other private read and every write rechecks revocation.
    if (route.method === "GET" && route.access === "anyone" && route.operationId !== "getSession") {
      publicReads.add("GET", API_BASE + route.path, true);
    }
    router.add(
      route.method,
      API_BASE + route.path,
      apiHandler(route, service, auth, host, accounts),
    );
  }
  // OAuth sign-in and, in development, the one-click sign-in.
  for (const [method, path, handler] of accounts.pageRoutes()) router.add(method, path, handler);

  async function dispatch(context: RequestContext, cors: string | null): Promise<Response> {
    const { request, url } = context;
    if (request.method === "OPTIONS" && cors) return preflightResponse(cors);
    const match = router.match(request.method, url.pathname);
    if (match?.found) return await match.handler({ ...context, params: match.params });
    if (match) return methodNotAllowedResponse(request.method, url.pathname, match.allowed);
    if (NOT_WEBSITE.test(url.pathname)) return notFoundResponse(url.pathname);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowedResponse(request.method, url.pathname, ["GET", "HEAD"]);
    }
    if (url.pathname === "/setup" && !(await service.getSession(SYSTEM, {})).setupRequired)
      return notFoundResponse(url.pathname);
    return await web(request);
  }

  return async (request, info) => {
    const started = performance.now();
    const url = new URL(request.url);
    const id = requestId(request, config.trustProxy);
    const cors = allowedOrigin(request, url.pathname, config.corsOrigins);
    const ip = clientIp(request, info, config.trustProxy);
    let response: Response;
    /** A renewed session token, or a cleared cookie, to send back. */
    let sessionCookie: string | null = null;
    try {
      if (!accounts.originAllowed(request)) {
        throw forbidden("Refused: this request with the session cookie comes from another site.");
      }
      const cookie = SESSION_PATHS.test(url.pathname)
        ? await accounts.sessions.read(
            request,
            publicReads.match(request.method, url.pathname)?.found,
          )
        : { session: null, setCookie: null };
      sessionCookie = cookie.setCookie;
      response = await dispatch(
        { request, url, params: {}, requestId: id, ip, session: cookie.session },
        cors,
      );
    } catch (error) {
      response = toErrorResponse(error, {
        requestId: id,
        log,
        method: request.method,
        path: url.pathname,
      });
    }

    const headers = new Headers(response.headers);
    if (
      sessionCookie !== null &&
      !headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
    ) {
      headers.append("Set-Cookie", sessionCookie);
    }
    setSecurityHeaders(headers, {
      hsts: config.publicUrl.startsWith("https:"),
      turnstile: config.turnstile !== null,
    });
    setCacheHeaders(headers, {
      method: request.method,
      pathname: url.pathname,
      status: response.status,
      credentials: hasCredentials(request),
    });
    if (cors) setCorsHeaders(headers, cors);
    else if (config.corsOrigins.length > 0 && CORS_PATHS.test(url.pathname)) {
      // Without it, a cache could give the website a copy made for another origin.
      headers.set("Vary", mergeVary(headers.get("Vary"), ["Origin"]));
    }
    headers.set("X-Request-Id", id);

    const fields = {
      method: request.method,
      path: url.pathname,
      status: response.status,
      duration: Math.round(performance.now() - started),
      requestId: id,
      ip,
    };
    if (url.pathname === "/healthz") log.debug("request", fields);
    else log.info("request", fields);

    const body = request.method === "HEAD" ? null : response.body;
    if (body === null) await response.body?.cancel();
    return new Response(compress(request, response.status, headers, body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Authenticates, checks the input against the route's schemas and calls the service. */
function apiHandler(
  route: ApiRoute,
  service: ServiceApi,
  auth: Authenticator,
  host: RouteHost,
  accounts: Accounts,
): Handler {
  return async ({ request, url, params, ip = null, session = null }) => {
    const actor = await auth.actorFor(request, session);
    accounts.limitRequest(request.method, actor, ip);
    await refuseEarly(route, actor, auth, request);
    const call = {
      service,
      actor,
      auth,
      request,
      host,
      http: { request, ip, session, accounts },
      params: route.params ? parseQuery(route.params, new URLSearchParams(params)) : undefined,
      query: route.query ? parseQuery(route.query, url.searchParams) : undefined,
      body: route.body ? validateInput(route.body, await bodyOf(route, request)) : undefined,
    };
    try {
      const result = await route.handle(call);
      // A file (a backup download) goes as it is.
      if (result instanceof Response) return result;
      return json(result, { status: route.status ?? 200 });
    } catch (error) {
      // A key revoked since it was cached: 401, like any revoked key.
      if (actor.type === "token" && error instanceof ServiceError && error.code === "forbidden") {
        await auth.recheck(request);
      }
      throw error;
    }
  };
}

/** The JSON body; `{}` when the route's body is optional and the request has none. */
async function bodyOf(route: ApiRoute, request: Request): Promise<unknown> {
  if (
    route.optionalBody &&
    (request.body === null || request.headers.get("Content-Length") === "0")
  ) {
    return {};
  }
  return await readJson(request, route.bodyLimit ?? MB);
}

/** A key for this process only, when there is no `SECRET_KEY` (tests): sessions end with it. */
function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Refuses callers who surely can't use the route before its body is read, so that no one
 * without the right key makes the server read a large body (design §8): anonymous callers
 * on routes that need credentials, and keys without the `upload` scope on upload and LLM
 * routes.
 * The service still decides everything else.
 */
async function refuseEarly(
  route: ApiRoute,
  actor: Actor,
  auth: Authenticator,
  request: Request,
): Promise<void> {
  // `setup` routes check their own token (POST /restore, with the setup token).
  if (route.access === "anyone" || route.access === "setup") return;
  if (actor.type === "anonymous") throw unauthorized();
  if ((route.access === "upload" || route.access === "translate") && actor.type === "token") {
    if (auth.scopeOf(actor.tokenId) !== "read") return;
    // A key revoked meanwhile is a 401, as always.
    await auth.recheck(request);
    throw forbidden();
  }
}
