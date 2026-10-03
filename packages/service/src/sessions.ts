// SPDX-License-Identifier: MIT
/**
 * Sessions (design §5.8, S6.2): random 256-bit IDs, stored as SHA-256 hashes, valid for 30
 * days after the last use. The server keeps the ID in its cookie, next to a signed token it
 * checks itself, and asks `resolveSession` only when that token expires (hourly).
 */
import { sha256Hex } from "@quaso/core";
import type { Context } from "./context.ts";
import type { Actor } from "./api.ts";
import { forbidden, notFound } from "./errors.ts";
import type { Sql, Statement } from "./ports.ts";
import { withRetries } from "./write.ts";

/** How long a session lasts after its last use. */
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

/** How often a session's last use is written at most, to save writes. */
export const SESSION_TOUCH_INTERVAL = 60 * 60 * 1000;

/** The longest user agent kept with a session. */
const MAX_USER_AGENT = 300;

/** 32 random bytes as base64url, without padding: session IDs and every link's token. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface NewSession {
  sessionId: string;
  expiresAt: number;
}

/** Starts a session for a person, and forgets expired ones. */
export function createSession(ctx: Context, userId: number, userAgent?: string): NewSession {
  const now = ctx.clock();
  const sessionId = randomToken();
  const plan = planSessionCreation(userId, sessionId, now, userAgent);
  for (const statement of plan.statements) ctx.sql.run(statement.sql, ...(statement.params ?? []));
  return plan.result;
}

/** Account creation and authentication can include these statements in their own commit. */
export function planSessionCreation(
  userId: number,
  sessionId: string,
  now: number,
  userAgent?: string,
): { statements: Statement[]; result: NewSession } {
  const expiresAt = now + SESSION_TTL;
  return {
    statements: [
      { sql: "DELETE FROM sessions WHERE expires_at <= ?", params: [now] },
      {
        sql: "INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
        params: [
          sha256Hex(sessionId),
          userId,
          now,
          expiresAt,
          now,
          userAgent ? userAgent.slice(0, MAX_USER_AGENT) : null,
        ],
      },
      { sql: "UPDATE users SET last_seen_at = ? WHERE id = ?", params: [now, userId] },
    ],
    result: { sessionId, expiresAt },
  };
}

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

/** Internal session creation for an already authenticated active account. */
export async function createSessionAsync(
  sql: Sql,
  userId: number,
  now: number,
  userAgent?: string,
): Promise<NewSession> {
  const sessionId = randomToken();
  return withRetries(
    sql,
    async () => {
      const [revision, users] = await sql.read([
        REVISION,
        { sql: "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL", params: [userId] },
      ]);
      return { revision: Number(revision[0].revision), state: { exists: users.length > 0 } };
    },
    ({ exists }) => {
      if (!exists) throw notFound(`User ${userId}`);
      return planSessionCreation(userId, sessionId, now, userAgent);
    },
  );
}

type SessionRow = {
  user_id: number;
  expires_at: number;
  last_seen_at: number;
  deleted_at: number | null;
};

export async function resolveSessionAsync(
  sql: Sql,
  actor: Actor,
  sessionId: string,
  now: number,
): Promise<{ userId: number; expiresAt: number } | null> {
  if (actor.type !== "system") throw forbidden("Only the server may do that.");
  const hash = sha256Hex(sessionId);
  return withRetries(
    sql,
    async () => {
      const [revision, rows] = await sql.read([
        REVISION,
        {
          sql: "SELECT s.user_id, s.expires_at, s.last_seen_at, u.deleted_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?",
          params: [hash],
        },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: { row: rows[0] as SessionRow | undefined },
      };
    },
    ({ row }) => {
      if (!row) return { statements: [], result: null };
      if (row.expires_at <= now || row.deleted_at !== null)
        return {
          statements: [{ sql: "DELETE FROM sessions WHERE id_hash = ?", params: [hash] }],
          result: null,
        };
      if (now - row.last_seen_at < SESSION_TOUCH_INTERVAL)
        return { statements: [], result: { userId: row.user_id, expiresAt: row.expires_at } };
      const expiresAt = now + SESSION_TTL;
      return {
        statements: [
          {
            sql: "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?",
            params: [now, expiresAt, hash],
          },
          { sql: "UPDATE users SET last_seen_at = ? WHERE id = ?", params: [now, row.user_id] },
        ],
        result: { userId: row.user_id, expiresAt },
      };
    },
  );
}

export async function deleteSessionAsync(sql: Sql, sessionId: string): Promise<{ ok: true }> {
  const hash = sha256Hex(sessionId);
  return withRetries(
    sql,
    async () => {
      const [revision, rows] = await sql.read([
        REVISION,
        { sql: "SELECT 1 AS found FROM sessions WHERE id_hash = ?", params: [hash] },
      ]);
      return { revision: Number(revision[0].revision), state: { exists: rows.length > 0 } };
    },
    ({ exists }) => ({
      statements: exists ? [{ sql: "DELETE FROM sessions WHERE id_hash = ?", params: [hash] }] : [],
      result: { ok: true as const },
    }),
  );
}

/**
 * The person a session belongs to, or null when it is unknown, expired or its person is
 * deleted. Using a session moves its expiry 30 days on, written at most once an hour.
 */
export function resolveSession(
  ctx: Context,
  sessionId: string,
): { userId: number; expiresAt: number } | null {
  const hash = sha256Hex(sessionId);
  const [row] = ctx.sql.query<{
    user_id: number;
    expires_at: number;
    last_seen_at: number;
    deleted_at: number | null;
  }>(
    `SELECT s.user_id, s.expires_at, s.last_seen_at, u.deleted_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    hash,
  );
  if (row === undefined) return null;
  const now = ctx.clock();
  if (row.expires_at <= now || row.deleted_at !== null) {
    ctx.sql.run("DELETE FROM sessions WHERE id_hash = ?", hash);
    return null;
  }
  if (now - row.last_seen_at < SESSION_TOUCH_INTERVAL) {
    return { userId: row.user_id, expiresAt: row.expires_at };
  }
  const expiresAt = now + SESSION_TTL;
  ctx.sql.run(
    "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?",
    now,
    expiresAt,
    hash,
  );
  ctx.sql.run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, row.user_id);
  return { userId: row.user_id, expiresAt };
}

/** Ends one session (sign-out). */
export function deleteSession(ctx: Context, sessionId: string): void {
  ctx.sql.run("DELETE FROM sessions WHERE id_hash = ?", sha256Hex(sessionId));
}

/** Ends every session of a person, except `keep` (the one making the change). */
export function deleteUserSessions(ctx: Context, userId: number, keep?: string): void {
  if (keep === undefined) {
    ctx.sql.run("DELETE FROM sessions WHERE user_id = ?", userId);
  } else {
    ctx.sql.run("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?", userId, sha256Hex(keep));
  }
}
