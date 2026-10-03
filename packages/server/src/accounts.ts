// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * The server's side of accounts (design §5.8, §8; Sprint 6): the session cookie, the
 * `Origin` check, rate limits, the optional human check and email service, the OAuth and
 * development sign-in routes, and the helpers the account routes share. `createApp` builds
 * one per app; nothing about a request is kept in module-level variables.
 */
import type { SessionInfo, UserInfo } from "@quaso/core";
import { type Actor, type Logger, type ServiceApi, SYSTEM } from "@quaso/service";
import type { Config } from "./config.ts";
import { type EmailKind, linkEmail } from "./email.ts";
import type { Handler } from "./http/context.ts";
import { json } from "./http/response.ts";
import { createHumanCheck, type HumanCheck } from "./human_check.ts";
import { oauthRoutes } from "./oauth.ts";
import { RATE_RULES, RateLimiter } from "./rate_limit.ts";
import { insecureLocal, type Session, SessionCookies, Signer } from "./sessions.ts";
import { setupKeyConfigured } from "./setup_key.ts";

export interface AccountsOptions {
  config: Config;
  service: ServiceApi;
  log: Logger;
  /** Signs the session and OAuth cookies. */
  secretKey: string;
  /** For the email service, Turnstile and the OAuth providers. Tests pass a fake one. */
  fetch?: Fetch;
  now?: () => number;
}

/** What a request to an account route knows beyond its input. */
export interface HttpCall {
  request: Request;
  /** The client's address. */
  ip: string | null;
  /** The session from the cookie, if any. */
  session: Session | null;
  accounts: Accounts;
}

/** A new session from the service, as sign-in routes answer it. */
export interface NewSession {
  sessionId: string;
  user: UserInfo;
}

export class Accounts {
  readonly config: Config;
  readonly service: ServiceApi;
  readonly log: Logger;
  readonly sessions: SessionCookies;
  readonly limiter: RateLimiter;
  readonly humanCheck: HumanCheck;
  readonly #options: AccountsOptions;
  readonly #secure: boolean;
  readonly #origins: Set<string>;

  constructor(options: AccountsOptions) {
    const { config, service, log } = options;
    this.#options = options;
    this.config = config;
    this.service = service;
    this.log = log;
    this.#secure = !insecureLocal(config.publicUrl);
    this.sessions = new SessionCookies({
      secretKey: options.secretKey,
      secure: this.#secure,
      service,
      now: options.now,
    });
    this.limiter = new RateLimiter(options.now);
    this.humanCheck = createHumanCheck(config.turnstile, { fetch: options.fetch, log });
    this.#origins = new Set([new URL(config.publicUrl).origin, ...config.corsOrigins]);
  }

  /** The routes outside the API: OAuth for the configured providers, and the dev login. */
  pageRoutes(): [string, string, Handler][] {
    const routes = oauthRoutes({
      config: this.config,
      service: this.service,
      sessions: this.sessions,
      signer: new Signer(this.#options.secretKey, "oauth"),
      secure: this.#secure,
      fetch: this.#options.fetch,
      log: this.log,
      now: this.#options.now,
    });
    if (this.config.dev) {
      routes.push(["GET", "/auth/dev-login", (context) => this.#devLogin(context.request)]);
    }
    return routes;
  }

  /** `GET /auth/dev-login` (QUASO_DEV=1 only): signs in the developer account, then `/`. */
  async #devLogin(request: Request): Promise<Response> {
    await this.service.ensureDevAccount(SYSTEM, {});
    const signedIn = await this.service.devSignIn(SYSTEM, {
      userAgent: request.headers.get("User-Agent")?.slice(0, 1000) ?? undefined,
    });
    const home = `${this.config.publicUrl.replace(/\/+$/, "")}/`;
    const response = new Response(null, { status: 302, headers: { Location: home } });
    response.headers.append(
      "Set-Cookie",
      await this.sessions.issue(signedIn.sessionId, signedIn.user.id),
    );
    return response;
  }

  /**
   * CSRF (design §8): a state-changing request that carries the session cookie must come
   * from the website: its `Origin` (or `Referer`) is `PUBLIC_URL` or in `CORS_ORIGINS`;
   * in development, any local address. A browser's request from another site is refused
   * even without the cookie, so no site can sign a visitor in to an account of its choice;
   * so is `Origin: null` (sandboxed frames, `data:` pages, cross-site redirects), unless
   * the `Referer` is allowed. Requests with an API key, and those with neither `Origin` nor
   * a cookie (the CLI, scripts: browsers send `Origin` with every write), don't need it.
   */
  originAllowed(request: Request): boolean {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    if (request.headers.has("Authorization")) return true;
    let origin = request.headers.get("Origin");
    const hasSession = /(^|;)\s*quaso_session=/.test(request.headers.get("Cookie") ?? "");
    if (origin === null || origin === "null") {
      if (origin === null && !hasSession) return true;
      const referer = request.headers.get("Referer");
      origin = referer ? (URL.parse(referer)?.origin ?? null) : null;
    }
    if (origin === null) return false;
    if (this.#origins.has(origin)) return true;
    return this.config.dev && insecureLocal(origin);
  }

  /** Rate limits for API calls: anonymous reads per IP address, writes per caller. */
  limitRequest(method: string, actor: Actor, ip: string | null): void {
    if (method === "GET" || method === "HEAD") {
      if (actor.type === "anonymous") {
        this.limiter.check([`read:${ip ?? "unknown"}`, RATE_RULES.anonymousReads]);
      }
      return;
    }
    const who =
      actor.type === "user"
        ? `user:${actor.userId}`
        : actor.type === "token"
          ? `token:${actor.tokenId}`
          : `ip:${ip ?? "unknown"}`;
    this.limiter.check([`write:${who}`, RATE_RULES.writes]);
  }

  /** Sign-in attempts: per IP address, and per account when there is an address. */
  limitSignIn(ip: string | null, email?: string): void {
    const buckets: [string, { limit: number; windowMs: number }][] = [
      [`signin-ip:${ip ?? "unknown"}`, RATE_RULES.signInPerIp],
    ];
    if (email !== undefined) {
      buckets.push([`signin-account:${email.trim().toLowerCase()}`, RATE_RULES.signInPerAccount]);
    }
    this.limiter.check(...buckets);
  }

  /**
   * A signed-in person's password, checked to change the account or delete it: per IP
   * address, and per account as sign-ins are (design §5.8), so a stolen session can't guess
   * it faster than a sign-in form.
   */
  limitPasswordCheck(ip: string | null, actor: Actor): void {
    if (actor.type !== "user") return this.limitSignIn(ip);
    this.limiter.check(
      [`signin-ip:${ip ?? "unknown"}`, RATE_RULES.signInPerIp],
      [`signin-account:user:${actor.userId}`, RATE_RULES.signInPerAccount],
    );
  }

  /** Requests that send an email: per IP address and per address. */
  limitEmail(ip: string | null, email: string): void {
    this.limiter.check(
      [`email-ip:${ip ?? "unknown"}`, RATE_RULES.emailPerIp],
      [`email-address:${email.trim().toLowerCase()}`, RATE_RULES.emailPerAddress],
    );
  }

  /** `GET /auth/session`: the service's part, and the server's settings. */
  async sessionInfo(actor: Actor): Promise<SessionInfo> {
    const { user, setupRequired } = await this.service.getSession(actor, {});
    return {
      user,
      setupRequired,
      setupKeyConfigured: setupRequired && setupKeyConfigured(this.config),
      dev: this.config.dev,
      providers: {
        github: this.config.github !== null,
        discord: this.config.discord !== null,
        email: (await this.service.emailStatus(SYSTEM, {})).available,
      },
      humanCheck: this.config.turnstile
        ? { provider: "turnstile", siteKey: this.config.turnstile.siteKey }
        : null,
    };
  }

  /** The answer to a sign-in: the session info, with the new session's cookie. */
  async signedIn(result: NewSession, previous: Session | null): Promise<Response> {
    // A browser that signs in as someone (or again) drops the session it had.
    if (previous !== null && previous.sessionId !== result.sessionId) {
      await this.service.signOut(SYSTEM, { sessionId: previous.sessionId });
    }
    const response = json(await this.sessionInfo({ type: "user", userId: result.user.id }));
    response.headers.append(
      "Set-Cookie",
      await this.sessions.issue(result.sessionId, result.user.id),
    );
    return response;
  }

  /**
   * Emails a link to the account with this address, if there is one (`to` is what the
   * request said), without waiting for the service or the email API: the answer takes as
   * long either way, so it never tells whether an address has an account (S6.4). Failures
   * are logged.
   */
  emailLink(kind: EmailKind, to: string): void {
    (async () => {
      if (!(await this.service.emailStatus(SYSTEM, {})).available) return;
      const token = await this.service.createEmailToken(SYSTEM, { email: to, purpose: kind });
      if (token) await this.#sendLink(kind, token.email, token.token);
    })().catch((error) => this.log.warn("A link email wasn't sent", { kind, error }));
  }

  /** Sends a link by email; failures are logged, not shown. */
  async #sendLink(kind: EmailKind, to: string, token: string): Promise<void> {
    const project = await this.service.getProject(SYSTEM, {}).then(
      (p) => p.name,
      () => "Quaso",
    );
    try {
      await this.service.sendEmail(
        SYSTEM,
        linkEmail(kind, { to, token, publicUrl: this.config.publicUrl, projectName: project }),
      );
    } catch (error) {
      this.log.warn("A link email wasn't sent", { kind, error });
    }
  }
}
