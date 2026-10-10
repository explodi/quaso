// SPDX-License-Identifier: MIT
/**
 * What the signed-in person may do, mirroring the service's permission table (design §5.8),
 * to show or hide actions. The service has the last word: it checks every request again.
 */
import { canonicalLanguageTag, type Role, type UserInfo } from "@quaso/core";

export const ACTIONS = [
  /** Browse languages, strings, translations, history and activity. */
  "read",
  /** Export files (the CLI's download). */
  "download",
  /** Upload the English and import translations (the CLI's upload). */
  "upload",
  /** Ask to become a volunteer. */
  "volunteer",
  /** Send pending changes: translations, corrections and "looks good". */
  "suggest",
  /** Edit translations directly (blue), approve, unapprove and delete them. */
  "edit",
  /** Approve or reject pending changes. */
  "review",
  /** Run the LLM. */
  "translate",
  /** See LLM usage. */
  "usage",
  /** Approve volunteers, invite, remove, change roles. */
  "team",
  "settings",
  /** Manage API keys. */
  "tokens",
  /** Download backups. */
  "backup",
  "glossary",
  "comment",
  "issues",
  "requestLanguage",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * What each role allows, as in the service (a unit test compares the two). Managers may also
 * suggest, to ask for a second opinion; the editor offers them Save.
 */
const ROLES: Record<Role, readonly Action[]> = {
  none: ["read", "volunteer", "requestLanguage"],
  contributor: ["read", "suggest", "comment", "requestLanguage"],
  manager: [
    "read",
    "edit",
    "review",
    "suggest",
    "translate",
    "usage",
    "glossary",
    "comment",
    "issues",
    "requestLanguage",
  ],
  administrator: ACTIONS.filter((action) => action !== "volunteer"),
};

/** Actions limited to a person's languages (ROLE-3), when a language is given. */
const LIMITED: ReadonlySet<Action> = new Set(["suggest", "edit", "review", "glossary", "comment"]);

/** The part of the user that permissions depend on. */
export type PermissionUser = Pick<UserInfo, "role" | "languages"> &
  Partial<Pick<UserInfo, "volunteerRequest">>;

/**
 * Whether `user` (null: signed out) may do `action`, in `language` when it concerns one.
 * Anyone may read; people by role, limited to their languages for suggesting, editing and
 * reviewing, except administrators, whom no language list limits. Tags compare in their
 * canonical form (`pt-br` is `pt-BR`, `iw` is `he`), as in the service.
 */
export function can(user: PermissionUser | null, action: Action, language?: string): boolean {
  if (user === null) return action === "read";
  if (action === "comment" && user.role === "none" && user.volunteerRequest?.status === "pending") {
    return true;
  }
  if (!(ROLES[user.role] ?? []).includes(action)) return false;
  if (
    language === undefined ||
    user.role === "administrator" ||
    !LIMITED.has(action) ||
    user.languages === null
  ) {
    return true;
  }
  const wanted = canonicalLanguageTag(language) ?? language;
  return user.languages.some((tag) => (canonicalLanguageTag(tag) ?? tag) === wanted);
}

/** The role's name for people. */
export function roleLabel(role: Role): string {
  switch (role) {
    case "none":
      return "Signed in";
    case "contributor":
      return "Contributor";
    case "manager":
      return "Manager";
    case "administrator":
      return "Administrator";
  }
}
