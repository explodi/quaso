// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
/**
 * Sign-in with GitHub and Discord (design §5.8, S6.4): OAuth 2 authorization codes with
 * PKCE (S256) and a state value, both kept in a short-lived signed cookie. Each provider is
 * on when its client ID and secret are set.
 *
 * - `GET /auth/{provider}?next=/path` starts; `?link=1` links the provider to the
 *   signed-in account instead; `?invite=<token>` gives a new account the invite's role.
 * - `GET /auth/{provider}/callback` exchanges the code, reads the account (GitHub: `/user`,
 *   and `/user/emails` for the primary verified address; Discord: `/users/@me`, with the
 *   `email` scope and its `verified` flag), calls the service, sets the session cookie and
 *   goes to `next`. Failures go to `/signin?error=<code>` (`/account?error=` when linking):
 *   `oauth_denied`, `oauth_failed`, `oauth_conflict`, `invite_invalid`, `setup_required`
 *   or `signed_out`.
 */
import { encodeBase64Url } from "@quaso/runtime/encoding";
import { type Logger, type ServiceApi, ServiceError, SYSTEM } from "@quaso/service";
import type { Config } from "./config.ts";
import type { Handler, RequestContext } from "./http/context.ts";
import { readCookie, type SessionCookies, type Signer } from "./sessions.ts";

export const OAUTH_COOKIE = "quaso_oauth";
export const OAUTH_TTL_MS = 10 * 60 * 1000;

export type Provider = "github" | "discord";

/** What a provider tells us about the person. */
export interface Profile {
  subject: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  profile(token: string, fetch: import("@quaso/core").Fetch): Promise<Profile>;
}

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    async profile(token, doFetch) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Quaso",
      };
      const user = await getJson(doFetch, "https://api.github.com/user", headers);
      const emails = await getJson(doFetch, "https://api.github.com/user/emails", headers).catch(
        () => [],
      );
      const primary = Array.isArray(emails)
        ? emails.find((e) => e?.primary === true && e?.verified === true)
        : undefined;
      return {
        subject: String(user.id),
        username: stringOrNull(user.login),
        email: stringOrNull(primary?.email) ?? stringOrNull(user.email),
        emailVerified: primary !== undefined,
        displayName: stringOrNull(user.name),
        avatarUrl: stringOrNull(user.avatar_url),
      };
    },
  },
  discord: {
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scope: "identify email",
    async profile(token, doFetch) {
      const user = await getJson(doFetch, "https://discord.com/api/users/@me", {
        Authorization: `Bearer ${token}`,
      });
      const id = String(user.id);
      return {
        subject: id,
        username: stringOrNull(user.username),
        email: stringOrNull(user.email),
        emailVerified: user.verified === true,
        displayName: stringOrNull(user.global_name) ?? stringOrNull(user.username),
        avatarUrl:
          typeof user.avatar === "string"
            ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(id)}/${encodeURIComponent(
                user.avatar,
              )}.png`
            : null,
      };
    },
  },
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
async function getJson(doFetch: Fetch, url: string, headers: HeadersInit): Promise<any> {
  const response = await doFetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url} answered ${response.status}`);
  }
  return await response.json();
}

/** What the state cookie keeps between the start and the callback. */
interface OAuthState {
  provider: Provider;
  state: string;
  verifier: string;
  next: string;
  /** Link to this person instead of signing in. */
  link: number | null;
  invite: string | null;
  exp: number;
}

/**
 * A path on this site to go to after signing in, or the fallback: it must start with one
 * `/`, so it can't lead to another site.
 */
export function safeNext(next: string | null, fallback = "/"): string {
  if (next === null || next.length > 1000) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  try {
    const url = new URL(next, "https://quaso.invalid");
    if (url.origin !== "https://quaso.invalid") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

export interface OAuthOptions {
  config: Config;
  service: ServiceApi;
  sessions: SessionCookies;
  /** Signs the state cookie. */
  signer: Signer;
  secure: boolean;
  fetch?: Fetch;
  log: Logger;
  now?: () => number;
}

/** `[method, path, handler]` for each configured provider's start and callback. */
export function oauthRoutes(options: OAuthOptions): [string, string, Handler][] {
  const routes: [string, string, Handler][] = [];
  for (const provider of ["github", "discord"] as const) {
    const credentials = options.config[provider];
    if (credentials === null) continue;
    const flow = new OAuthFlow(provider, credentials, options);
    routes.push(["GET", `/auth/${provider}`, (context) => flow.start(context)]);
    routes.push(["GET", `/auth/${provider}/callback`, (context) => flow.callback(context)]);
  }
  return routes;
}

class OAuthFlow {
  readonly #spec: ProviderSpec;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #publicUrl: string;

  constructor(
    readonly provider: Provider,
    readonly credentials: { clientId: string; clientSecret: string },
    readonly options: OAuthOptions,
  ) {
    this.#spec = PROVIDERS[provider];
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#publicUrl = options.config.publicUrl.replace(/\/+$/, "");
  }

  get redirectUri(): string {
    return `${this.#publicUrl}/auth/${this.provider}/callback`;
  }

  async start({ url, session }: RequestContext): Promise<Response> {
    const link = url.searchParams.get("link") === "1";
    if (link && !session) return this.#fail("signed_out", true);
    const invite = url.searchParams.get("invite");
    const state: OAuthState = {
      provider: this.provider,
      state: randomString(),
      verifier: randomString(),
      next: safeNext(url.searchParams.get("next"), link ? "/account" : "/"),
      link: link ? session!.userId : null,
      invite: invite && invite.length <= 200 ? invite : null,
      exp: this.#now() + OAUTH_TTL_MS,
    };
    const challenge = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state.verifier)),
      ),
    );
    const target = new URL(this.#spec.authorizeUrl);
    target.searchParams.set("client_id", this.credentials.clientId);
    target.searchParams.set("redirect_uri", this.redirectUri);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", this.#spec.scope);
    target.searchParams.set("state", state.state);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    const response = redirect(target.href);
    response.headers.append(
      "Set-Cookie",
      this.#cookie(await this.options.signer.seal(state), OAUTH_TTL_MS / 1000),
    );
    return response;
  }

  async callback(context: RequestContext): Promise<Response> {
    const { url, request, session } = context;
    const sealed = readCookie(request, OAUTH_COOKIE);
    const saved = sealed ? await this.options.signer.open<OAuthState>(sealed) : null;
    const linking = saved !== null && saved.link !== null;
    if (url.searchParams.get("error")) return this.#fail("oauth_denied", linking);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (
      saved === null ||
      saved.provider !== this.provider ||
      saved.exp <= this.#now() ||
      code === null ||
      state === null ||
      !(await sameText(state, saved.state))
    ) {
      return this.#fail("oauth_failed", linking);
    }
    if (linking && session?.userId !== saved.link) return this.#fail("signed_out", true);

    let profile: Profile;
    try {
      const token = await this.#exchange(code, saved.verifier);
      profile = await this.#spec.profile(token, this.#fetch);
    } catch (error) {
      this.options.log.warn("OAuth sign-in failed", { provider: this.provider, error });
      return this.#fail("oauth_failed", linking);
    }

    let result;
    try {
      result = await this.options.service.signInWithIdentity(SYSTEM, {
        provider: this.provider,
        subject: profile.subject,
        username: profile.username?.slice(0, 200) ?? null,
        email: profile.email && profile.email.length <= 254 ? profile.email : null,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName?.slice(0, 200) ?? null,
        avatarUrl: profile.avatarUrl && profile.avatarUrl.length <= 2000 ? profile.avatarUrl : null,
        ...(saved.link !== null
          ? { linkToUserId: saved.link, linkSessionId: session!.sessionId }
          : {}),
        ...(saved.invite !== null ? { invite: saved.invite } : {}),
        userAgent: request.headers.get("User-Agent")?.slice(0, 1000) ?? undefined,
      });
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      const code =
        error.code === "unauthorized" && linking
          ? "signed_out"
          : error.code === "conflict"
            ? "oauth_conflict"
            : error.code === "setup_required"
              ? "setup_required"
              : error.code === "bad_request"
                ? "invite_invalid"
                : "oauth_failed";
      this.options.log.info("OAuth sign-in refused", { provider: this.provider, code });
      return this.#fail(code, linking);
    }
    const response = redirect(`${this.#publicUrl}${saved.next}`);
    response.headers.append("Set-Cookie", this.#cookie("", 0));
    if (result.sessionId !== null) {
      // Signing in as someone else ends the session the browser had.
      if (session) await this.options.service.signOut(SYSTEM, { sessionId: session.sessionId });
      response.headers.append(
        "Set-Cookie",
        await this.options.sessions.issue(result.sessionId, result.user.id),
      );
    }
    this.options.log.info("OAuth sign-in", {
      provider: this.provider,
      userId: result.user.id,
      created: result.created || undefined,
      linked: linking || undefined,
    });
    return response;
  }

  async #exchange(code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });
    const response = await this.#fetch(this.#spec.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.access_token !== "string") {
      throw new Error(`The token exchange failed: ${response.status} ${data?.error ?? ""}`);
    }
    return data.access_token;
  }

  #fail(code: string, linking: boolean): Response {
    const response = redirect(
      `${this.#publicUrl}${linking ? "/account" : "/signin"}?error=${code}`,
    );
    response.headers.append("Set-Cookie", this.#cookie("", 0));
    return response;
  }

  #cookie(value: string, maxAge: number): string {
    const parts = [`${OAUTH_COOKIE}=${value}`, "Path=/auth/", `Max-Age=${maxAge}`, "HttpOnly"];
    parts.push("SameSite=Lax");
    if (this.options.secure) parts.push("Secure");
    return parts.join("; ");
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function randomString(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Compares two strings in constant time, through their SHA-256 hashes. */
async function sameText(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
