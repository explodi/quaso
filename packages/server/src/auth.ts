// SPDX-License-Identifier: MIT
/**
 * Who is calling (design §4, §8): the server authenticates API keys, and people by their
 * session cookie (`sessions.ts`), then passes the actor to the service, which decides what
 * it may do. An API key wins over a cookie.
 */
import { sha256Hex, type TokenScope } from "@quaso/core";
import { type Actor, ANONYMOUS, type ServiceApi, SYSTEM, unauthorized } from "@quaso/service";

/** API keys start with this, so secret scanners recognize leaked ones. */
export const API_KEY_PREFIX = "qso_";

/** What an API key can look like: the prefix, then base64url, and not longer than the service takes. */
const API_KEY_FORMAT = /^qso_[\w-]{1,196}$/;

export interface AuthenticatorOptions {
  /** How long a checked key is trusted without asking the service again. Default: 60 s. */
  ttlMs?: number;
  now?: () => number;
  /** The most keys kept in the cache. Default: 1000. */
  maxEntries?: number;
}

export interface Authenticator {
  /**
   * The actor for a request: its API key's, else the session's person, else anonymous; 401
   * for a malformed, unknown or revoked key.
   */
  actorFor(request: Request, session?: { userId: number } | null): Promise<Actor>;
  /**
   * Checks the request's API key again, without the cache: 401 if it was revoked meanwhile.
   * The API calls it when the service refuses a key, so a revoked key is always a 401.
   */
  recheck(request: Request): Promise<void>;
  /** Drops a key from the cache, after it was revoked here. */
  forget(tokenId: number): void;
  /** The scope of a key `actorFor` recently checked, or null. */
  scopeOf(tokenId: number): TokenScope | null;
}

interface Cached {
  tokenId: number;
  scope: TokenScope;
  expires: number;
}

/**
 * Checks `Authorization: Bearer qso_…` with the service, and caches the answer for a
 * minute, by the SHA-256 of the secret (never the secret itself). So a key revoked
 * elsewhere stops working within a minute, and at once when revoked through this server.
 */
export function createAuthenticator(
  service: Pick<ServiceApi, "authenticateToken">,
  options: AuthenticatorOptions = {},
): Authenticator {
  const ttl = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  const cache = new Map<string, Cached>();

  async function tokenActor(secret: string): Promise<Actor> {
    if (!secret.startsWith(API_KEY_PREFIX)) {
      throw unauthorized(`API keys start with ${API_KEY_PREFIX}. Check QUASO_API_KEY.`);
    }
    if (!API_KEY_FORMAT.test(secret)) throw unknownKey();
    const hash = sha256Hex(secret);
    const cached = cache.get(hash);
    if (cached && cached.expires > now()) return { type: "token", tokenId: cached.tokenId };
    cache.delete(hash);
    const token = await service.authenticateToken(SYSTEM, { secret });
    if (!token) throw unknownKey();
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    cache.set(hash, { tokenId: token.tokenId, scope: token.scope, expires: now() + ttl });
    return { type: "token", tokenId: token.tokenId };
  }

  return {
    async actorFor(request, session) {
      const secret = bearer(request);
      if (secret !== null) return await tokenActor(secret);
      return session ? { type: "user", userId: session.userId } : ANONYMOUS;
    },
    async recheck(request) {
      const secret = bearer(request);
      if (secret === null) return;
      cache.delete(sha256Hex(secret));
      await tokenActor(secret);
    },
    forget(tokenId) {
      for (const [hash, cached] of cache) {
        if (cached.tokenId === tokenId) cache.delete(hash);
      }
    },
    scopeOf(tokenId) {
      for (const cached of cache.values()) {
        if (cached.tokenId === tokenId && cached.expires > now()) return cached.scope;
      }
      return null;
    },
  };
}

function unknownKey() {
  return unauthorized("This API key is unknown or was revoked.");
}

/** The secret of `Authorization: Bearer <secret>`, or null without the header. */
function bearer(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) return null;
  const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) throw unauthorized("Send the API key as: Authorization: Bearer qso_…");
  return match[1];
}
