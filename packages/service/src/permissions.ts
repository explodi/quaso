// SPDX-License-Identifier: MIT
/**
 * Every permission check goes through `can` (design §4, §5.8): the service decides what an
 * actor may do, next to the data. `permissions_table.test.ts` checks the whole table of
 * design §5.8: every action for every kind of actor, with and without language limits.
 */
import { canonicalLanguageTag, type Role, type TokenScope } from "@quaso/core";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { fromJsonOrNull } from "./db.ts";
import { forbidden, type ServiceError, unauthorized } from "./errors.ts";
import type { Sql, SqlRow, Statement } from "./ports.ts";

export const ACTIONS = [
  /** Browse languages, strings, translations, history and activity. */
  "read",
  /** Export files (the CLI's download). */
  "download",
  /** Upload the English and import translations. */
  "upload",
  /** Run LLM jobs. */
  "translate",
  /** Manage everyone's API keys; people manage their own with `account`. */
  "tokens",
  "settings",
  "team",
  "backup",
  /** Approve or reject pending changes. */
  "review",
  /** Edit translations directly (blue). */
  "edit",
  /** Send pending changes. */
  "suggest",
  /** Ask to become a volunteer. */
  "volunteer",
  /**
   * Manage one's own account: name, email address, password, sign-in methods, deletion, and
   * one's own API keys.
   */
  "account",
  /** See LLM usage. */
  "usage",
  /** Write a file's context for the LLM (managers too). */
  "context",
  /** Maintain terminology; global terms require unrestricted language access. */
  "glossary",
  /** Discuss strings (pending volunteers are allowed as well). */
  "comment",
  /** Ask for a project language, or vote for it. */
  "requestLanguage",
  "issues",
] as const;
export type Action = (typeof ACTIONS)[number];

/** What each API key scope allows (OPS-3). */
const SCOPES: Record<TokenScope, readonly Action[]> = {
  read: ["read", "download"],
  upload: ["read", "download", "upload", "translate", "usage"],
};

/** What each role allows (design §5.8). */
const ROLES: Record<Role, readonly Action[]> = {
  none: ["read", "volunteer", "account", "requestLanguage"],
  contributor: ["read", "suggest", "account", "comment", "requestLanguage"],
  // "Contributor or above" may suggest: a manager can ask for a second opinion.
  manager: [
    "read",
    "edit",
    "review",
    "suggest",
    "translate",
    "usage",
    "context",
    "account",
    "glossary",
    "comment",
    "requestLanguage",
    "issues",
  ],
  administrator: ACTIONS.filter((action) => action !== "volunteer"),
};

/** Actions limited to a person's languages (ROLE-3), when a language is given. */
const LIMITED: ReadonlySet<Action> = new Set(["suggest", "edit", "review", "glossary", "comment"]);

/**
 * Whether `actor` may do `action`, in `language` when it concerns one. The system may do
 * everything; anonymous visitors (and deleted people) may only read; API keys by scope, never
 * once revoked, and never beyond what the person who created them may do now; people by
 * role, limited to their languages for suggesting, editing and reviewing.
 */
export function can(ctx: Context, actor: Actor, action: Action, language?: string): boolean {
  return syncPermissions(ctx, actor).can(action, language);
}

type PermissionUser = { role: Role; languages: string | null; volunteer_status: string | null };
/**
 * A key and the person who created it: `created_by` is null for keys the system created
 * (`quaso token create`), which act by scope alone; `role` is null when that person is gone.
 */
type PermissionToken = {
  scope: TokenScope;
  revoked_at: number | null;
  created_by: number | null;
  role: Role | null;
  languages: string | null;
};

/** Permission decisions use the identity rows captured by the operation's snapshot. */
export class Permissions {
  constructor(
    readonly actor: Actor,
    private readonly state: { user?: PermissionUser; token?: PermissionToken } = {},
  ) {}

  can(action: Action, language?: string): boolean {
    const actor = this.actor;
    switch (actor.type) {
      case "system":
        return true;
      case "anonymous":
        return action === "read";
      case "token": {
        const token = this.state.token;
        if (token === undefined || token.revoked_at !== null) return false;
        const scopeAllows = SCOPES[token.scope]?.includes(action) ?? false;
        if (token.created_by === null) return scopeAllows;
        const creatorAllows = token.role !== null && (ROLES[token.role]?.includes(action) ?? false);
        return scopeAllows && creatorAllows;
      }
      case "user": {
        const user = this.state.user;
        // A deleted (or unknown) person's session may outlive them by a signed token's hour:
        // it browses like a visitor's, and may do nothing else.
        if (user === undefined) return action === "read";
        if (action === "comment" && user.role === "none" && user.volunteer_status === "pending") {
          return true;
        }
        if (!(ROLES[user.role]?.includes(action) ?? false)) return false;
        if (language === undefined || user.role === "administrator" || !LIMITED.has(action)) {
          return true;
        }
        const allowed = fromJsonOrNull<string[]>(user.languages);
        if (allowed === null) return true;
        const tag = canonicalLanguageTag(language) ?? language;
        return allowed.some((entry) => (canonicalLanguageTag(entry) ?? entry) === tag);
      }
    }
  }

  languageLimit(): string[] | null {
    // A key works in the languages of the person who created it.
    const person = this.actor.type === "user" ? this.state.user : this.state.token;
    if (person === undefined || person.role === null || person.role === "administrator") {
      return null;
    }
    const allowed = fromJsonOrNull<string[]>(person.languages);
    return allowed?.map((entry) => canonicalLanguageTag(entry) ?? entry) ?? null;
  }

  require(action: Action, language?: string): void {
    if (this.can(action, language)) return;
    throw denied(this.actor);
  }
}

/** Include these statements in a protected operation's read batch. */
export function permissionReadStatements(actor: Actor): Statement[] {
  if (actor.type === "user")
    return [
      {
        sql: "SELECT role, languages, volunteer_status FROM users WHERE id = ? AND deleted_at IS NULL",
        params: [actor.userId],
      },
    ];
  if (actor.type === "token")
    return [
      {
        sql: `SELECT t.scope, t.revoked_at, t.created_by, u.role, u.languages
              FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by AND u.deleted_at IS NULL
              WHERE t.id = ?`,
        params: [actor.tokenId],
      },
    ];
  return [];
}

export function permissionsFromRows(actor: Actor, rows: SqlRow[][]): Permissions {
  const user = actor.type === "user" ? (rows[0]?.[0] as PermissionUser | undefined) : undefined;
  const token = actor.type === "token" ? (rows[0]?.[0] as PermissionToken | undefined) : undefined;
  return new Permissions(actor, { user, token });
}

export async function readPermissions(sql: Sql, actor: Actor): Promise<Permissions> {
  const statements = permissionReadStatements(actor);
  const rows = statements.length === 0 ? [] : await sql.read(statements);
  return permissionsFromRows(actor, rows);
}

export function syncPermissions(ctx: Context, actor: Actor): Permissions {
  const rows = permissionReadStatements(actor).map((statement) =>
    ctx.sql.query(statement.sql, ...(statement.params ?? [])),
  );
  return permissionsFromRows(actor, rows);
}

/**
 * The languages a person, or the person who created a key, is limited to (ROLE-3), canonical;
 * null when nothing limits them: administrators, people without a list, the system's keys and
 * the system. For work that spans
 * languages, such as LLM jobs, which `can` doesn't limit (a job names many at once).
 */
export function languageLimit(ctx: Context, actor: Actor): string[] | null {
  return syncPermissions(ctx, actor).languageLimit();
}

/**
 * Throws unless `actor` may do `action`: `unauthorized` for anonymous visitors (they should
 * sign in or send a key), `forbidden` for everyone else.
 */
export function requirePermission(
  ctx: Context,
  actor: Actor,
  action: Action,
  language?: string,
): void {
  syncPermissions(ctx, actor).require(action, language);
}

/** The error for an actor who may not do something. */
export function denied(actor: Actor): ServiceError {
  return actor.type === "anonymous" ? unauthorized() : forbidden();
}
