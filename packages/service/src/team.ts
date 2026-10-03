// SPDX-License-Identifier: MIT
/**
 * Volunteers and the team (design §5.8, ROLE-1 to ROLE-3, S6.6): volunteer requests and
 * their review, members and their roles and languages, and invite links.
 */
import {
  type CreateInviteRequest,
  type InviteCheck,
  type InviteInfo,
  type MemberInfo,
  type MembersResult,
  type ReviewVolunteerRequest,
  type Role,
  sha256Hex,
  type UpdateMemberRequest,
  type UserInfo,
  type VolunteerRequest,
  canonicalLanguageTag,
} from "@quaso/core";
import { ActorDirectory, type ActorRows, type Author, SYSTEM_AUTHOR } from "./actors.ts";
import type { Actor } from "./api.ts";
import { type Sql, type Statement, type Logger, silentLogger } from "./ports.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import type { Context } from "./context.ts";
import { fromJsonOrNull, toJson } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { randomToken } from "./sessions.ts";
import { withRetries } from "./write.ts";
import {
  administratorCount,
  memberInfos,
  memberInfosFromRows,
  requireUserRow,
  USER_COLUMNS,
  userInfo,
  type UserRow,
  type MemberRow,
  MEMBER_COLUMNS,
  ACCOUNT_COLUMNS,
  type AccountRow,
  type IdentityRow,
  userInfoFromRows,
  userIdOf,
} from "./users.ts";

/** How long an invite lasts when the request doesn't say. */
export const DEFAULT_INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const VOLUNTEERS_SQL = `SELECT ${USER_COLUMNS} FROM users
  WHERE volunteer_status = 'pending' AND role = 'none' AND deleted_at IS NULL
  ORDER BY volunteer_requested_at, id`;
const MEMBERS_SQL = `SELECT ${USER_COLUMNS} FROM users
  WHERE deleted_at IS NULL AND (role <> 'none' OR volunteer_status = 'pending')
  ORDER BY CASE role WHEN 'administrator' THEN 0 WHEN 'manager' THEN 1
    WHEN 'contributor' THEN 2 ELSE 3 END, display_name, id`;

/**
 * Language tags from a request, canonical, each a project language (`bad_request`
 * otherwise); null stays null (all languages).
 */
export function projectLanguages(ctx: Context, tags: string[] | null): string[] | null {
  if (tags === null) return null;
  const available = new Set(
    ctx.sql.query<{ tag: string }>("SELECT tag FROM languages").map((row) => row.tag),
  );
  return projectLanguagesFromTags(available, tags);
}

/** Canonicalize grants against the languages captured by a write snapshot. */
export function projectLanguagesFromTags(
  available: Set<string>,
  tags: string[] | null,
): string[] | null {
  if (tags === null) return null;
  const out: string[] = [];
  for (const tag of tags) {
    const canonical = canonicalLanguageTag(tag);
    if (canonical === null || !available.has(canonical)) {
      throw badRequest(`The project has no language ${tag}.`, [{ language: tag }]);
    }
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function recordActivity(ctx: Context, actor: Author, summary: string, detail: object): void {
  ctx.sql.run(
    `INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at)
     VALUES ('review', ?, ?, ?, ?, ?, ?)`,
    actor.type,
    actor.id,
    actor.label,
    summary,
    toJson(detail),
    ctx.clock(),
  );
}

// ---------------------------------------------------------------------------------------
// Volunteers

/** A signed-in person without a role asks to volunteer (one pending request at a time). */
export function requestVolunteer(
  ctx: Context,
  userId: number,
  request: VolunteerRequest,
): UserInfo {
  const user = requireUserRow(ctx.sql, userId);
  if (user.role !== "none") throw badRequest("You are a member of the team already.");
  if (user.volunteer_status === "pending") {
    throw conflict("You have asked already: an administrator will answer your request.");
  }
  const languages = projectLanguages(ctx, request.languages)!;
  ctx.sql.run(
    `UPDATE users SET volunteer_status = 'pending', volunteer_languages = ?,
       volunteer_message = ?, volunteer_requested_at = ?
     WHERE id = ?`,
    toJson(languages),
    request.message.trim(),
    ctx.clock(),
    userId,
  );
  ctx.logger.info("Volunteer request", { userId, languages });
  return userInfo(ctx.sql, requireUserRow(ctx.sql, userId));
}

export async function requestVolunteerAsync(
  sql: Sql,
  actor: Actor,
  request: VolunteerRequest,
  now: number,
  logger: Logger = silentLogger,
): Promise<UserInfo> {
  const id = actor.type === "user" ? actor.userId : null;
  const result = await withRetries(
    sql,
    async () => {
      const [revision, users, identities, languages, ...permissionRows] = await sql.read([
        REVISION_READ,
        {
          sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
          params: [id],
        },
        {
          sql: "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
          params: [id],
        },
        { sql: "SELECT tag FROM languages" },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as AccountRow | undefined,
          identities: identities as IdentityRow[],
          languages: new Set(languages.map((row) => row.tag as string)),
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("volunteer");
      const userId = userIdOf(actor);
      const user = state.user;
      if (user === undefined) throw notFound(`User ${userId}`);
      if (user.role !== "none") throw badRequest("You are a member of the team already.");
      if (user.volunteer_status === "pending")
        throw conflict("You have asked already: an administrator will answer your request.");
      const languages = projectLanguagesFromTags(state.languages, request.languages)!;
      const updated = {
        ...user,
        volunteer_status: "pending" as const,
        volunteer_languages: toJson(languages),
        volunteer_message: request.message.trim(),
        volunteer_requested_at: now,
      };
      return {
        statements: [
          {
            sql: "UPDATE users SET volunteer_status = 'pending', volunteer_languages = ?, volunteer_message = ?, volunteer_requested_at = ? WHERE id = ?",
            params: [updated.volunteer_languages, updated.volunteer_message, now, userId],
          },
        ],
        result: userInfoFromRows(updated, state.identities),
      };
    },
  );
  logger.info("Volunteer request", {
    userId: result.id,
    languages: result.volunteerRequest!.languages,
  });
  return result;
}

/** Pending volunteer requests, oldest first. */
export function listVolunteerRequests(ctx: Context): MembersResult {
  const rows = ctx.sql.query<UserRow>(VOLUNTEERS_SQL);
  return { members: memberInfos(ctx.sql, rows) };
}

export function listVolunteerRequestsAsync(sql: Sql, actor: Actor): Promise<MembersResult> {
  return readTeam(sql, actor, VOLUNTEERS_SQL);
}

export function listMembersAsync(sql: Sql, actor: Actor): Promise<MembersResult> {
  return readTeam(sql, actor, MEMBERS_SQL);
}

/** Member contributions and administrative access are captured together. */
async function readTeam(sql: Sql, actor: Actor, selection: string): Promise<MembersResult> {
  const [rows, counts, ...permissionRows] = await sql.read([
    { sql: selection },
    {
      sql: `SELECT author_id AS id, COUNT(*) AS n FROM suggestions WHERE author_type = 'user'
      AND author_id IN (SELECT id FROM (${selection})) GROUP BY author_id
      UNION ALL SELECT actor_id AS id, COUNT(*) AS n FROM history
      WHERE actor_type = 'user' AND event = 'translation_saved'
      AND actor_id IN (SELECT id FROM (${selection})) GROUP BY actor_id`,
    },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("team");
  return {
    members: memberInfosFromRows(rows as UserRow[], counts as { id: number | null; n: number }[]),
  };
}

/**
 * Approves a volunteer request, as a contributor (by default) or a manager, limited to the
 * languages given (by default those asked for; null for all), or rejects it.
 */
export function reviewVolunteer(
  ctx: Context,
  reviewer: Author,
  userId: number,
  review: ReviewVolunteerRequest,
): MemberInfo {
  const user = requireUserRow(ctx.sql, userId);
  if (user.volunteer_status !== "pending" || user.role !== "none") {
    throw notFound(`A pending volunteer request from user ${userId}`);
  }
  if (review.approve) {
    const role = review.role ?? "contributor";
    const languages =
      review.languages === undefined
        ? projectLanguages(ctx, fromJsonOrNull<string[]>(user.volunteer_languages))
        : projectLanguages(ctx, review.languages);
    ctx.sql.run(
      "UPDATE users SET role = ?, languages = ?, volunteer_status = 'approved' WHERE id = ?",
      role,
      languages === null ? null : toJson(languages),
      userId,
    );
    recordActivity(
      ctx,
      reviewer,
      `${APPROVED}${user.display_name}, as ${role}` +
        (languages === null ? "" : ` (${languages.join(", ")})`),
      { kind: "volunteer", userId, approved: true, role, languages },
    );
  } else {
    // No activity row: the feed is public, and a refusal is nobody else's business (§8).
    ctx.sql.run("UPDATE users SET volunteer_status = 'rejected' WHERE id = ?", userId);
    ctx.logger.info("Volunteer request declined", { userId, by: reviewer.id });
  }
  return memberInfos(ctx.sql, [requireUserRow(ctx.sql, userId)])[0];
}

export async function reviewVolunteerAsync(
  sql: Sql,
  actor: Actor,
  userId: number,
  review: ReviewVolunteerRequest,
  now: number,
  logger: Logger = silentLogger,
): Promise<MemberInfo> {
  const result = await withRetries(
    sql,
    async () => {
      const [revision, users, languages, counts, ...permissionRows] = await sql.read([
        REVISION_READ,
        {
          sql: `SELECT ${MEMBER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
          params: [userId],
        },
        { sql: "SELECT tag FROM languages" },
        {
          sql: "SELECT ? AS id, COUNT(*) AS n FROM suggestions WHERE author_type = 'user' AND author_id = ? UNION ALL SELECT ? AS id, COUNT(*) AS n FROM history WHERE actor_type = 'user' AND event = 'translation_saved' AND actor_id = ?",
          params: [userId, userId, userId, userId],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as MemberRow | undefined,
          languages: new Set(languages.map((row) => row.tag as string)),
          counts: counts as { id: number | null; n: number }[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("team");
      const user = state.user;
      if (user === undefined) throw notFound(`User ${userId}`);
      if (user.volunteer_status !== "pending" || user.role !== "none")
        throw notFound(`A pending volunteer request from user ${userId}`);
      if (!review.approve)
        return {
          statements: [
            {
              sql: "UPDATE users SET volunteer_status = 'rejected' WHERE id = ?",
              params: [userId],
            },
          ],
          result: memberInfosFromRows([{ ...user, volunteer_status: "rejected" }], state.counts)[0],
        };
      const role = review.role ?? "contributor";
      const requestedLanguages =
        review.languages === undefined
          ? fromJsonOrNull<string[]>(user.volunteer_languages)
          : review.languages;
      const languages = projectLanguagesFromTags(state.languages, requestedLanguages);
      const reviewer: Author =
        actor.type === "user" ? { type: "user", id: actor.userId, label: null } : SYSTEM_AUTHOR;
      const summary =
        `${APPROVED}${user.display_name}, as ${role}` +
        (languages === null ? "" : ` (${languages.join(", ")})`);
      return {
        statements: [
          {
            sql: "UPDATE users SET role = ?, languages = ?, volunteer_status = 'approved' WHERE id = ?",
            params: [role, languages === null ? null : toJson(languages), userId],
          },
          {
            sql: "INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES ('review', ?, ?, ?, ?, ?, ?)",
            params: [
              reviewer.type,
              reviewer.id,
              reviewer.label,
              summary,
              toJson({ kind: "volunteer", userId, approved: true, role, languages }),
              now,
            ],
          },
        ],
        result: memberInfosFromRows(
          [
            {
              ...user,
              role,
              languages: languages === null ? null : toJson(languages),
              volunteer_status: "approved",
            },
          ],
          state.counts,
        )[0],
      };
    },
  );
  if (!review.approve)
    logger.info("Volunteer request declined", {
      userId,
      by: actor.type === "user" ? actor.userId : null,
    });
  return result;
}

/** The summaries `reviewVolunteer` writes (and wrote), which name the volunteer. */
const APPROVED = "Volunteer approved: ";
const DECLINED = "Volunteer request declined: ";

/**
 * On account deletion (OPS-3): the volunteer's name leaves the activity feed too, replaced
 * with `name` ("Deleted user") in the approvals of their requests (and the refusals, which
 * earlier versions recorded too).
 */
export function forgetVolunteerName(ctx: Context, userId: number, name: string): void {
  const rows = ctx.sql.query<{ id: number; summary: string; detail: string }>(
    `SELECT id, summary, detail FROM activity
     WHERE type = 'review' AND instr(detail, '"volunteer"') > 0`,
  );
  for (const statement of planForgetVolunteerName(rows, userId, name))
    ctx.sql.run(statement.sql, ...(statement.params ?? []));
}

export function planForgetVolunteerName(
  rows: { id: number; summary: string; detail: string }[],
  userId: number,
  name: string,
): Statement[] {
  const statements: Statement[] = [];
  for (const row of rows) {
    const detail = fromJsonOrNull<{ kind?: string; userId?: number }>(row.detail);
    if (detail?.kind !== "volunteer" || detail.userId !== userId) continue;
    let summary = row.summary;
    if (summary.startsWith(DECLINED)) summary = DECLINED + name;
    else if (summary.startsWith(APPROVED)) {
      const role = summary.lastIndexOf(", as ");
      summary = APPROVED + name + (role > APPROVED.length ? summary.slice(role) : "");
    }
    if (summary !== row.summary) {
      statements.push({
        sql: "UPDATE activity SET summary = ? WHERE id = ?",
        params: [summary, row.id],
      });
    }
  }
  return statements;
}

// ---------------------------------------------------------------------------------------
// Members

/** Everyone with a role, then people waiting for an answer to their request. */
export function listMembers(ctx: Context): MembersResult {
  const rows = ctx.sql.query<UserRow>(MEMBERS_SQL);
  return { members: memberInfos(ctx.sql, rows) };
}

/** Changes a member's role or languages. The last administrator stays one. */
export function updateMember(
  ctx: Context,
  actor: Author,
  userId: number,
  change: UpdateMemberRequest,
): MemberInfo {
  const user = requireUserRow(ctx.sql, userId);
  const role: Role = change.role ?? user.role;
  if (user.role === "administrator" && role !== "administrator") {
    refuseLastAdministrator(ctx);
    // Removing a role takes effect at once (design §5.8): so do the invites they made.
    revokeInvitesBy(ctx, userId);
  }
  const languages =
    change.languages === undefined
      ? fromJsonOrNull<string[]>(user.languages)
      : projectLanguages(ctx, change.languages);
  // A member who loses their role may ask again; a request answered by a role is approved.
  ctx.sql.run(
    `UPDATE users SET role = ?, languages = ?,
       volunteer_status = CASE
         WHEN ? = 'none' AND role <> 'none' THEN NULL
         WHEN ? <> 'none' AND volunteer_status = 'pending' THEN 'approved'
         ELSE volunteer_status END
     WHERE id = ?`,
    role,
    role === "none" || languages === null ? null : toJson(languages),
    role,
    role,
    userId,
  );
  ctx.logger.info("Member changed", { userId, role, languages, by: actor.id });
  return memberInfos(ctx.sql, [requireUserRow(ctx.sql, userId)])[0];
}

/** Takes a member's role away (they keep their account). */
export function removeMember(ctx: Context, actor: Author, userId: number): void {
  updateMember(ctx, actor, userId, { role: "none", languages: null });
}

export async function updateMemberAsync(
  sql: Sql,
  actor: Actor,
  userId: number,
  change: UpdateMemberRequest,
  now: number,
  logger: Logger = silentLogger,
): Promise<MemberInfo> {
  const result = await withRetries(
    sql,
    async () => {
      const [revision, users, administrators, languages, counts, ...permissionRows] =
        await sql.read([
          REVISION_READ,
          {
            sql: `SELECT ${MEMBER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
            params: [userId],
          },
          {
            sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND deleted_at IS NULL",
          },
          { sql: "SELECT tag FROM languages" },
          {
            sql: "SELECT ? AS id, COUNT(*) AS n FROM suggestions WHERE author_type = 'user' AND author_id = ? UNION ALL SELECT ? AS id, COUNT(*) AS n FROM history WHERE actor_type = 'user' AND event = 'translation_saved' AND actor_id = ?",
            params: [userId, userId, userId, userId],
          },
          ...permissionReadStatements(actor),
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as MemberRow | undefined,
          administratorCount: Number(administrators[0].n),
          languages: new Set(languages.map((row) => row.tag as string)),
          counts: counts as { id: number | null; n: number }[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("team");
      const current = state.user;
      if (!current) throw notFound(`User ${userId}`);
      const role = change.role ?? current.role;
      const demotingAdministrator = current.role === "administrator" && role !== "administrator";
      if (demotingAdministrator && state.administratorCount <= 1)
        throw badRequest(
          "This is the last administrator. Make someone else an administrator first.",
        );
      const languages =
        change.languages === undefined
          ? fromJsonOrNull<string[]>(current.languages)
          : projectLanguagesFromTags(state.languages, change.languages);
      const storedLanguages = role === "none" || languages === null ? null : toJson(languages);
      let volunteerStatus = current.volunteer_status;
      if (role === "none" && current.role !== "none") volunteerStatus = null;
      else if (role !== "none" && current.volunteer_status === "pending")
        volunteerStatus = "approved";
      const user = {
        ...current,
        role,
        languages: storedLanguages,
        volunteer_status: volunteerStatus,
      };
      const changed =
        role !== current.role ||
        storedLanguages !== current.languages ||
        volunteerStatus !== current.volunteer_status;
      const statements: Statement[] = [];
      if (changed) {
        if (demotingAdministrator)
          statements.push({
            sql: "UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL",
            params: [now, userId],
          });
        statements.push({
          sql: "UPDATE users SET role = ?, languages = ?, volunteer_status = ? WHERE id = ?",
          params: [role, storedLanguages, volunteerStatus, userId],
        });
      }
      return {
        statements,
        result: { member: memberInfosFromRows([user], state.counts)[0], changed, languages },
      };
    },
  );
  if (result.changed)
    logger.info("Member changed", {
      userId,
      role: result.member.role,
      languages: result.languages,
      by: actor.type === "user" ? actor.userId : null,
    });
  return result.member;
}

export async function removeMemberAsync(
  sql: Sql,
  actor: Actor,
  userId: number,
  now: number,
  logger: Logger = silentLogger,
): Promise<{ ok: true }> {
  await updateMemberAsync(sql, actor, userId, { role: "none", languages: null }, now, logger);
  return { ok: true };
}

function refuseLastAdministrator(ctx: Context): void {
  if (administratorCount(ctx.sql) <= 1) {
    throw badRequest("This is the last administrator. Make someone else an administrator first.");
  }
}

// ---------------------------------------------------------------------------------------
// Invites

export type InviteRow = {
  id: number;
  role: Role;
  languages: string | null;
  created_by: number | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
  revoked_at: number | null;
};

export const INVITE_COLUMNS =
  "id, role, languages, created_by, created_at, expires_at, used_at, used_by, revoked_at";

/** A single-use invite link that gives whoever signs up with it a role (ROLE-1). */
export function createInvite(
  ctx: Context,
  actor: Author,
  request: CreateInviteRequest,
  baseUrl: string,
): InviteInfo {
  const token = randomToken();
  const now = ctx.clock();
  const languages = projectLanguages(ctx, request.languages ?? null);
  const [row] = ctx.sql.query<InviteRow>(
    `INSERT INTO invites (token_hash, role, languages, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING ${INVITE_COLUMNS}`,
    sha256Hex(token),
    request.role,
    languages === null ? null : toJson(languages),
    actor.type === "user" ? actor.id : null,
    now,
    now + DEFAULT_INVITE_DAYS * DAY,
  );
  const url = `${baseUrl.replace(/\/+$/, "")}/signup?invite=${token}`;
  return { ...describeInvites(ctx, [row])[0], url };
}

const REVISION_READ: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export async function createInviteAsync(
  sql: Sql,
  actor: Actor,
  request: CreateInviteRequest,
  baseUrl: string,
  now: number,
): Promise<InviteInfo> {
  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const creatorId = actor.type === "user" ? actor.userId : null;
  return withRetries(
    sql,
    async () => {
      const [revision, ids, languages, users, ...permissionRows] = await sql.read([
        REVISION_READ,
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM invites" },
        { sql: "SELECT tag FROM languages" },
        { sql: "SELECT id, display_name, avatar_url FROM users WHERE id = ?", params: [creatorId] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          id: Number(ids[0].id),
          languages: new Set(languages.map((row) => row.tag as string)),
          actors: new ActorDirectory({ users: users as ActorRows["users"], tokens: [] }),
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("team");
      const languages = projectLanguagesFromTags(state.languages, request.languages ?? null);
      const row: InviteRow = {
        id: state.id,
        role: request.role,
        languages: languages === null ? null : toJson(languages),
        created_by: creatorId,
        created_at: now,
        expires_at: now + DEFAULT_INVITE_DAYS * DAY,
        used_at: null,
        used_by: null,
        revoked_at: null,
      };
      return {
        statements: [
          {
            sql: "INSERT INTO invites (id, token_hash, role, languages, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params: [row.id, tokenHash, row.role, row.languages, creatorId, now, row.expires_at],
          },
        ],
        result: {
          ...inviteInfos([row], state.actors)[0],
          url: `${baseUrl.replace(/\/+$/, "")}/signup?invite=${token}`,
        },
      };
    },
  );
}

export async function revokeInviteAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  now: number,
): Promise<{ ok: true }> {
  return withRetries(
    sql,
    async () => {
      const [revision, rows, ...permissionRows] = await sql.read([
        REVISION_READ,
        { sql: `SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?`, params: [id] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          row: rows[0] as InviteRow | undefined,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ row, permissions }) => {
      permissions.require("team");
      if (!row) throw notFound(`Invite ${id}`);
      const statements: Statement[] =
        row.revoked_at === null
          ? [{ sql: "UPDATE invites SET revoked_at = ? WHERE id = ?", params: [now, id] }]
          : [];
      return { statements, result: { ok: true as const } };
    },
  );
}

/** Every invite, newest first, revoked ones excepted. */
export function listInvites(ctx: Context): { invites: InviteInfo[] } {
  const rows = ctx.sql.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE revoked_at IS NULL ORDER BY id DESC`,
  );
  return { invites: describeInvites(ctx, rows) };
}

export async function listInvitesAsync(sql: Sql, actor: Actor): Promise<{ invites: InviteInfo[] }> {
  const [rows, users, ...permissionRows] = await sql.read([
    { sql: `SELECT ${INVITE_COLUMNS} FROM invites WHERE revoked_at IS NULL ORDER BY id DESC` },
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN
      (SELECT created_by FROM invites WHERE revoked_at IS NULL UNION ALL SELECT used_by FROM invites WHERE revoked_at IS NULL)`,
    },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("team");
  const actors = new ActorDirectory({ users: users as ActorRows["users"], tokens: [] });
  return { invites: inviteInfos(rows as InviteRow[], actors) };
}

export async function checkInviteAsync(sql: Sql, token: string, now: number): Promise<InviteCheck> {
  const [rows] = await sql.read([
    {
      sql: `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ?`,
      params: [sha256Hex(token)],
    },
  ]);
  const row = rows[0] as InviteRow | undefined;
  if (!inviteUsableAt(row, now)) return { valid: false, role: null, languages: null };
  return { valid: true, role: row.role, languages: fromJsonOrNull<string[]>(row.languages) };
}

/** Revokes an unused invite. */
export function revokeInvite(ctx: Context, id: number): void {
  const [row] = ctx.sql.query<InviteRow>(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?`, id);
  if (row === undefined) throw notFound(`Invite ${id}`);
  ctx.sql.run(
    "UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ctx.clock(),
    id,
  );
}

/**
 * Revokes the unused invites a person made: when they stop being an administrator, or
 * delete their account.
 */
export function revokeInvitesBy(ctx: Context, userId: number): void {
  ctx.sql.run(
    `UPDATE invites SET revoked_at = ?
     WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL`,
    ctx.clock(),
    userId,
  );
}

function usableInvite(ctx: Context, token: string): InviteRow | undefined {
  const [row] = ctx.sql.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ?`,
    sha256Hex(token),
  );
  return inviteUsableAt(row, ctx.clock()) ? row : undefined;
}

export function inviteUsableAt(row: InviteRow | undefined, now: number): row is InviteRow {
  if (row === undefined) return false;
  const usedOrRevoked = row.used_at !== null || row.revoked_at !== null;
  if (usedOrRevoked) return false;
  return row.expires_at > now;
}

/** Whether an invite link can still be used, for the sign-up page. */
export function checkInvite(ctx: Context, token: string): InviteCheck {
  const row = usableInvite(ctx, token);
  if (row === undefined) return { valid: false, role: null, languages: null };
  return { valid: true, role: row.role, languages: fromJsonOrNull<string[]>(row.languages) };
}

/** Uses an invite up for a new account: its role and languages, or `bad_request`. */
export function takeInvite(
  ctx: Context,
  token: string,
  userId: number,
): { role: Role; languages: string[] | null } {
  const row = usableInvite(ctx, token);
  if (row === undefined) {
    throw badRequest("This invite link isn't valid any more. Ask for a new one.");
  }
  ctx.sql.run(
    "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?",
    ctx.clock(),
    userId,
    row.id,
  );
  return { role: row.role, languages: fromJsonOrNull<string[]>(row.languages) };
}

function describeInvites(ctx: Context, rows: InviteRow[]): InviteInfo[] {
  const actors = new ActorDirectory(
    ctx.sql,
    [],
    rows.flatMap((row) => [row.created_by, row.used_by]),
  );
  return inviteInfos(rows, actors);
}

function inviteInfos(rows: InviteRow[], actors: ActorDirectory): InviteInfo[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    languages: fromJsonOrNull<string[]>(row.languages),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: actors.user(row.used_by),
    createdBy: actors.user(row.created_by) ?? { type: "system", id: null, name: "System" },
  }));
}
