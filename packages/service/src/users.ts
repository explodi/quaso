// SPDX-License-Identifier: MIT
/**
 * People (design §5.8): the `users` rows as the account, team and review modules read them,
 * and the `UserInfo` and `MemberInfo` shapes of the API.
 */
import type { MemberInfo, Role, UserInfo, VolunteerRequestInfo } from "@quaso/core";
import type { Actor } from "./api.ts";
import { fromJsonOrNull } from "./db.ts";
import { badRequest, notFound, unauthorized } from "./errors.ts";
import type { Sql, Statement, SyncSql } from "./ports.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";

/** A row of the `users` table. */
export type UserRow = {
  id: number;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role: Role;
  languages: string | null;
  created_at: number;
  deleted_at: number | null;
  password_hash: string | null;
  email_verified: number;
  volunteer_status: VolunteerRequestInfo["status"] | null;
  volunteer_languages: string | null;
  volunteer_message: string | null;
  volunteer_requested_at: number | null;
  last_seen_at: number | null;
};

export const USER_COLUMNS = `id, email, display_name, avatar_url, role, languages, created_at,
  deleted_at, password_hash, email_verified, volunteer_status, volunteer_languages,
  volunteer_message, volunteer_requested_at, last_seen_at`;

export type IdentityRow = { provider: "github" | "discord"; username: string | null };
export type AccountRow = Omit<UserRow, "password_hash"> & { has_password: number };
export const ACCOUNT_COLUMNS = `id, email, display_name, avatar_url, role, languages, created_at,
  deleted_at, email_verified, volunteer_status, volunteer_languages, volunteer_message,
  volunteer_requested_at, last_seen_at, (password_hash IS NOT NULL) AS has_password`;

/** The name that replaces a deleted person's (OPS-3). */
export const DELETED_NAME = "Deleted user";

/** An email address as stored: trimmed, in lower case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A person by ID, deleted or not, or `undefined`. */
export function loadUser(sql: SyncSql, id: number): UserRow | undefined {
  return sql.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id)[0];
}

/** A person who isn't deleted, by ID; `not_found` otherwise. */
export function requireUserRow(sql: SyncSql, id: number): UserRow {
  const row = loadUser(sql, id);
  if (row === undefined || row.deleted_at !== null) throw notFound(`User ${id}`);
  return row;
}

/** The person with this email address (any case), unless deleted. */
export function findUserByEmail(sql: SyncSql, email: string): UserRow | undefined {
  return sql.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = ? AND deleted_at IS NULL`,
    normalizeEmail(email),
  )[0];
}

/** The signed-in person's ID: `unauthorized` for anonymous callers, `bad_request` for keys. */
export function userIdOf(actor: Actor): number {
  if (actor.type === "user") return actor.userId;
  if (actor.type === "anonymous") throw unauthorized("Sign in first.");
  throw badRequest("Only a signed-in person can do that.");
}

/** Administrators who aren't deleted. */
export function administratorCount(sql: SyncSql): number {
  return sql.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND deleted_at IS NULL",
  )[0].n;
}

export const SETUP_STATE: Statement = {
  sql: `SELECT (EXISTS (SELECT 1 FROM meta WHERE key = 'setup_completed_at')
    OR EXISTS (SELECT 1 FROM users WHERE role = 'administrator' AND deleted_at IS NULL)) AS n`,
};

/** Losing an administrator must not reopen initial setup. */
export function setupRequired(sql: SyncSql): boolean {
  return Number(sql.query(SETUP_STATE.sql)[0].n) === 0;
}

/** The volunteer request of a row, if any. */
export function volunteerRequestOf(
  row: Pick<
    UserRow,
    | "volunteer_status"
    | "volunteer_languages"
    | "volunteer_message"
    | "volunteer_requested_at"
    | "created_at"
  >,
): VolunteerRequestInfo | null {
  if (row.volunteer_status === null) return null;
  return {
    status: row.volunteer_status,
    languages: fromJsonOrNull<string[]>(row.volunteer_languages) ?? [],
    message: row.volunteer_message ?? "",
    createdAt: row.volunteer_requested_at ?? row.created_at,
  };
}

/** The account as its owner sees it. */
export function userInfo(sql: SyncSql, row: UserRow): UserInfo {
  const identities = sql.query<IdentityRow>(
    "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
    row.id,
  );
  return userInfoFromRows({ ...row, has_password: row.password_hash === null ? 0 : 1 }, identities);
}

export function userInfoFromRows(row: AccountRow, identities: IdentityRow[]): UserInfo {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    languages: fromJsonOrNull<string[]>(row.languages),
    emailVerified: row.email_verified === 1,
    hasPassword: row.has_password === 1,
    identities: identities.map((identity) => ({
      provider: identity.provider,
      username: identity.username,
    })),
    volunteerRequest: volunteerRequestOf(row),
    createdAt: row.created_at,
  };
}

function accountReadStatements(actor: Actor): Statement[] {
  const id = actor.type === "user" ? actor.userId : null;
  return [
    {
      sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
      params: [id],
    },
    {
      sql: "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
      params: [id],
    },
  ];
}

/** The caller's account and linked identities, without loading its password hash. */
export async function getAccountAsync(sql: Sql, actor: Actor): Promise<UserInfo> {
  const [users, identities, ...permissionRows] = await sql.read([
    ...accountReadStatements(actor),
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("account");
  const id = userIdOf(actor);
  const row = users[0] as AccountRow | undefined;
  if (row === undefined) throw notFound(`User ${id}`);
  return userInfoFromRows(row, identities as IdentityRow[]);
}

/** The current user and setup state are captured in one snapshot. */
export async function getSessionAsync(
  sql: Sql,
  actor: Actor,
): Promise<{ user: UserInfo | null; setupRequired: boolean }> {
  const [users, identities, administrators] = await sql.read([
    ...accountReadStatements(actor),
    SETUP_STATE,
  ]);
  const row = users[0] as AccountRow | undefined;
  return {
    user: row === undefined ? null : userInfoFromRows(row, identities as IdentityRow[]),
    setupRequired: Number(administrators[0].n) === 0,
  };
}

/** `UserInfo` for a person by ID. */
export function userInfoById(sql: SyncSql, id: number): UserInfo {
  return userInfo(sql, requireUserRow(sql, id));
}

/** Members as the Team page lists them, with their contributions. */
export function memberInfos(sql: SyncSql, rows: UserRow[]): MemberInfo[] {
  if (rows.length === 0) return [];
  const suggestions = sql.query<{ id: number | null; n: number }>(
    `SELECT author_id AS id, COUNT(*) AS n FROM suggestions WHERE author_type = 'user' GROUP BY author_id`,
  );
  const history = sql.query<{ id: number | null; n: number }>(
    `SELECT actor_id AS id, COUNT(*) AS n FROM history WHERE actor_type = 'user' AND event = 'translation_saved' GROUP BY actor_id`,
  );
  return memberInfosFromRows(rows, [...suggestions, ...history]);
}

export type MemberRow = Pick<
  UserRow,
  | "id"
  | "display_name"
  | "email"
  | "avatar_url"
  | "role"
  | "languages"
  | "created_at"
  | "volunteer_status"
  | "volunteer_languages"
  | "volunteer_message"
  | "volunteer_requested_at"
>;

export const MEMBER_COLUMNS =
  "id, display_name, email, avatar_url, role, languages, created_at, volunteer_status, volunteer_languages, volunteer_message, volunteer_requested_at";

export function memberInfosFromRows(
  rows: MemberRow[],
  counts: { id: number | null; n: number }[],
): MemberInfo[] {
  const contributions = new Map<number, number>();
  for (const { id, n } of counts) {
    if (id !== null) contributions.set(id, (contributions.get(id) ?? 0) + n);
  }
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    role: row.role,
    languages: fromJsonOrNull<string[]>(row.languages),
    createdAt: row.created_at,
    contributions: contributions.get(row.id) ?? 0,
    volunteerRequest: volunteerRequestOf(row),
  }));
}
