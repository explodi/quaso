// SPDX-License-Identifier: MIT
/**
 * The session cookie (design §5.8, S6.2): `quaso_session` carries the session's ID and a
 * token signed with `SECRET_KEY`, valid for an hour, that names the user. The server checks
 * the signature itself for public reads; private reads, writes and OAuth flows always check
 * the session with the service. Expired or invalid tokens also need that check before renewal. With
 * Cloudflare storage, most reads need no call to the Durable Object. Revoked sessions
 * cannot write or link sign-in methods immediately; cached reads stop within the hour.
 * Permissions never depend on the token: the service checks the role on every action.
 *
 * The cookie: `<session ID>.<base64url JSON { uid, exp }>.<base64url HMAC-SHA-256>`, where
 * the signature covers the session ID too. Attributes: `HttpOnly; SameSite=Lax; Path=/`,
 * `Max-Age` 30 days, and `Secure` except for plain-http local addresses.
 */
import { Buffer } from "node:buffer";
import { type ServiceApi, SYSTEM } from "@quaso/service";

export const SESSION_COOKIE = "quaso_session";

// node:buffer rather than @std/encoding: the Cloudflare Worker imports this module too.
function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid base64url");
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** How long a signed token is trusted without asking the service. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** The cookie's lifetime: the session's, which slides with use. */
export const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A signed-in request's session. */
export interface Session {
  userId: number;
  sessionId: string;
}

/** What the cookie said, and what to send back. */
export interface CookieSession {
  session: Session | null;
  /** A `Set-Cookie` value to send with the response: a renewed token, or a cleared cookie. */
  setCookie: string | null;
}

export interface SessionCookiesOptions {
  secretKey: string;
  /** Add `Secure`: everything but plain-http local addresses. */
  secure: boolean;
  service: Pick<ServiceApi, "resolveSession">;
  now?: () => number;
}

/** Whether the cookie can go without `Secure`: a plain-http local address. */
export function insecureLocal(publicUrl: string): boolean {
  const url = URL.parse(publicUrl);
  return (
    url !== null &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

/** A cookie's value from a `Cookie` header, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Signs and checks values with an HMAC-SHA-256 key derived from `SECRET_KEY`, per purpose. */
export class Signer {
  readonly #key: Promise<CryptoKey>;

  constructor(secretKey: string, purpose: string) {
    this.#key = crypto.subtle.importKey(
      "raw",
      encoder.encode(`quaso-${purpose}:${secretKey}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async sign(value: string): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(value));
    return encodeBase64Url(new Uint8Array(signature));
  }

  /** Whether `signature` signs `value`; the comparison is Web Crypto's, in constant time. */
  async verify(value: string, signature: string): Promise<boolean> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = decodeBase64Url(signature) as Uint8Array<ArrayBuffer>;
    } catch {
      return false;
    }
    return await crypto.subtle.verify("HMAC", await this.#key, bytes, encoder.encode(value));
  }

  /** `<base64url JSON>.<signature>`. */
  async seal(data: unknown): Promise<string> {
    const payload = encodeBase64Url(encoder.encode(JSON.stringify(data)));
    return `${payload}.${await this.sign(payload)}`;
  }

  /** The data of a sealed value whose signature verifies, or null. */
  async open<T>(sealed: string): Promise<T | null> {
    const [payload, signature, extra] = sealed.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    if (!(await this.verify(payload, signature))) return null;
    try {
      return JSON.parse(decoder.decode(decodeBase64Url(payload))) as T;
    } catch {
      return null;
    }
  }
}

/** Reads, renews, issues and clears the session cookie. */
export class SessionCookies {
  readonly #signer: Signer;
  readonly #secure: boolean;
  readonly #service: Pick<ServiceApi, "resolveSession">;
  readonly #now: () => number;

  constructor(options: SessionCookiesOptions) {
    this.#signer = new Signer(options.secretKey, "session");
    this.#secure = options.secure;
    this.#service = options.service;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Public reads may trust a valid token until it expires. All other requests always
   * ask the service, so password recovery immediately stops old sessions from changing
   * the account or linking another sign-in method.
   */
  async read(request: Request, publicRead = false): Promise<CookieSession> {
    const value = readCookie(request, SESSION_COOKIE);
    if (value === null || value === "") return { session: null, setCookie: null };
    const match = value.match(/^([\w-]{20,100})\.([\w-]+)\.([\w-]+)$/);
    if (!match) return { session: null, setCookie: this.clear() };
    const [, sessionId, payload, signature] = match;
    const cachedRead = publicRead && ["GET", "HEAD"].includes(request.method);
    const token = (await this.#signer.verify(`${sessionId}.${payload}`, signature))
      ? parseToken(payload)
      : null;
    const current = token !== null && token.exp > this.#now();
    if (cachedRead && current) {
      return { session: { userId: token.uid, sessionId }, setCookie: null };
    }
    const resolved = await this.#service.resolveSession(SYSTEM, { sessionId });
    if (resolved === null) return { session: null, setCookie: this.clear() };
    return {
      session: { userId: resolved.userId, sessionId },
      setCookie:
        current && token.uid === resolved.userId
          ? null
          : await this.issue(sessionId, resolved.userId),
    };
  }

  /** The `Set-Cookie` value for a session, with a new one-hour token. */
  async issue(sessionId: string, userId: number): Promise<string> {
    const payload = encodeBase64Url(
      encoder.encode(JSON.stringify({ uid: userId, exp: this.#now() + TOKEN_TTL_MS })),
    );
    const signature = await this.#signer.sign(`${sessionId}.${payload}`);
    return this.#cookie(`${sessionId}.${payload}.${signature}`, COOKIE_MAX_AGE);
  }

  /** The `Set-Cookie` value that removes the cookie. */
  clear(): string {
    return this.#cookie("", 0);
  }

  #cookie(value: string, maxAge: number): string {
    const attributes = [`${SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly"];
    attributes.push("SameSite=Lax");
    if (this.#secure) attributes.push("Secure");
    return attributes.join("; ");
  }
}

function parseToken(payload: string): { uid: number; exp: number } | null {
  try {
    const data = JSON.parse(decoder.decode(decodeBase64Url(payload)));
    if (Number.isSafeInteger(data?.uid) && data.uid > 0 && typeof data.exp === "number") {
      return { uid: data.uid, exp: data.exp };
    }
  } catch {
    // Not a token.
  }
  return null;
}
