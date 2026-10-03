// SPDX-License-Identifier: MIT
/**
 * API keys (OPS-3): random secrets starting with `qso_`, shown once and stored as SHA-256
 * hashes, with the `read` or `upload` scope. The server authenticates a key with
 * `authenticateToken` and passes the key's ID to the service as the actor.
 */
import {
  type ApiTokenInfo,
  type ApiTokensResult,
  type CreateApiTokenRequest,
  type CreatedApiToken,
  sha256Hex,
  type TokenScope,
} from "@quaso/core";
import { ActorDirectory, type ActorRows } from "./actors.ts";
import type { Actor, AuthenticatedToken } from "./api.ts";
import type { Context } from "./context.ts";
import { forbidden, notFound } from "./errors.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Sql } from "./ports.ts";
import { withRetries } from "./write.ts";

/** Every key starts with this. */
export const TOKEN_PREFIX = "qso_";

/** How often `last_used_at` is written at most, in milliseconds, to save writes. */
export const LAST_USED_INTERVAL = 60_000;

type TokenRow = {
  id: number;
  name: string;
  scope: TokenScope;
  prefix: string;
  created_by: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

const TOKEN_COLUMNS = "id, name, scope, prefix, created_by, created_at, last_used_at, revoked_at";
const REVISION_READ = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

/** A new secret: `qso_` and 43 base64url characters (32 random bytes). */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + base64Url(bytes);
}

/** Creates a key. The secret is in the result, and nowhere else afterwards. */
export function createApiToken(
  ctx: Context,
  actor: Actor,
  request: CreateApiTokenRequest,
): CreatedApiToken {
  const secret = newSecret();
  const prefix = secret.slice(0, TOKEN_PREFIX.length + 4);
  const createdBy = actor.type === "user" ? actor.userId : null;
  const [row] = ctx.sql.query<TokenRow>(
    `INSERT INTO api_tokens (name, scope, secret_hash, prefix, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING ${TOKEN_COLUMNS}`,
    request.name,
    request.scope,
    sha256Hex(secret),
    prefix,
    createdBy,
    ctx.clock(),
  );
  return { ...describe(row, new ActorDirectory(ctx.sql, [], [createdBy])), secret };
}

export async function createApiTokenAsync(
  sql: Sql,
  actor: Actor,
  request: CreateApiTokenRequest,
  now: number,
): Promise<CreatedApiToken> {
  const secret = newSecret();
  const hash = sha256Hex(secret);
  const prefix = secret.slice(0, TOKEN_PREFIX.length + 4);
  const createdBy = actor.type === "user" ? actor.userId : null;
  return withRetries(
    sql,
    async () => {
      const [revision, ids, users, ...permissionRows] = await sql.read([
        REVISION_READ,
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM api_tokens" },
        { sql: "SELECT id, display_name, avatar_url FROM users WHERE id = ?", params: [createdBy] },
        ...permissionReadStatements(actor),
      ]);
      permissionsFromRows(actor, permissionRows).require("tokens");
      return {
        revision: Number(revision[0].revision),
        state: { id: Number(ids[0].id), users: users as ActorRows["users"] },
      };
    },
    ({ id, users }) => {
      const row: TokenRow = {
        id,
        name: request.name,
        scope: request.scope,
        prefix,
        created_by: createdBy,
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      };
      return {
        statements: [
          {
            sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params: [id, request.name, request.scope, hash, prefix, createdBy, now],
          },
        ],
        result: { ...describe(row, new ActorDirectory({ users, tokens: [] })), secret },
      };
    },
  );
}

/** Every key, newest first, revoked ones included. */
export function listApiTokens(ctx: Context): ApiTokensResult {
  const rows = ctx.sql.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY id DESC`);
  const actors = new ActorDirectory(
    ctx.sql,
    [],
    rows.map((row) => row.created_by),
  );
  return { tokens: rows.map((row) => describe(row, actors)) };
}

/** Administrative metadata and permission rows share a snapshot; secrets are never read. */
export async function listApiTokensAsync(sql: Sql, actor: Actor): Promise<ApiTokensResult> {
  const [rows, users, ...permissionRows] = await sql.read([
    { sql: `SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY id DESC` },
    {
      sql: "SELECT id, display_name, avatar_url FROM users WHERE id IN (SELECT created_by FROM api_tokens)",
    },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("tokens");
  const actors = new ActorDirectory({ users: users as ActorRows["users"], tokens: [] });
  return { tokens: (rows as TokenRow[]).map((row) => describe(row, actors)) };
}

/** Revokes a key for good. Revoking it again changes nothing. */
export function revokeApiToken(ctx: Context, id: number): void {
  const rows = ctx.sql.query("SELECT id FROM api_tokens WHERE id = ?", id);
  if (rows.length === 0) throw notFound(`API key ${id}`);
  ctx.sql.run(
    "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ctx.clock(),
    id,
  );
}

export async function revokeApiTokenAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
): Promise<void> {
  return withRetries(
    sql,
    async () => {
      const [revision, rows, ...permissionRows] = await sql.read([
        REVISION_READ,
        { sql: "SELECT revoked_at FROM api_tokens WHERE id = ?", params: [id] },
        ...permissionReadStatements(actor),
      ]);
      permissionsFromRows(actor, permissionRows).require("tokens");
      if (rows.length === 0) throw notFound(`API key ${id}`);
      return { revision: Number(revision[0].revision), state: rows[0].revoked_at };
    },
    (revokedAt) => ({
      statements:
        revokedAt === null
          ? [{ sql: "UPDATE api_tokens SET revoked_at = ? WHERE id = ?", params: [now, id] }]
          : [],
      result: undefined,
    }),
  );
}

/**
 * The key for a secret, found by its hash, unless it is revoked; `null` otherwise. Records
 * when it was last used, at most once a minute.
 */
export function authenticateToken(ctx: Context, secret: string): AuthenticatedToken | null {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const [row] = ctx.sql.query<{
    id: number;
    name: string;
    scope: TokenScope;
    last_used_at: number | null;
  }>(
    `SELECT id, name, scope, last_used_at FROM api_tokens
     WHERE secret_hash = ? AND revoked_at IS NULL`,
    sha256Hex(secret),
  );
  if (row === undefined) return null;
  const now = ctx.clock();
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_INTERVAL) {
    ctx.sql.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now, row.id);
  }
  return { tokenId: row.id, scope: row.scope, name: row.name };
}

/** A revocation or competing touch forces a fresh authentication decision before writing. */
export async function authenticateTokenAsync(
  sql: Sql,
  actor: Actor,
  secret: string,
  now: number,
): Promise<AuthenticatedToken | null> {
  if (actor.type !== "system") throw forbidden("Only the server may authenticate API keys.");
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  return withRetries(
    sql,
    async () => {
      const [revision, rows] = await sql.read([
        REVISION_READ,
        {
          sql: "SELECT id, name, scope, last_used_at FROM api_tokens WHERE secret_hash = ? AND revoked_at IS NULL",
          params: [sha256Hex(secret)],
        },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: rows[0] as
          | { id: number; name: string; scope: TokenScope; last_used_at: number | null }
          | undefined,
      };
    },
    (row) => {
      if (row === undefined) return { statements: [], result: null };
      const touch = row.last_used_at === null || now - row.last_used_at >= LAST_USED_INTERVAL;
      return {
        statements: touch
          ? [{ sql: "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", params: [now, row.id] }]
          : [],
        result: { tokenId: row.id, scope: row.scope, name: row.name },
      };
    },
  );
}

function describe(row: TokenRow, actors: ActorDirectory): ApiTokenInfo {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    prefix: row.prefix,
    createdAt: row.created_at,
    createdBy: actors.user(row.created_by),
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Bytes as base64url, without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
