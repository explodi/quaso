// SPDX-License-Identifier: MIT
/**
 * The service's methods for people (Sprint 6, design §5.8): sign-in and sessions, the
 * first start, accounts, volunteers and the team, suggestions and review, and direct
 * edits. `ServiceApi` extends this interface, so they cross the internal HTTP API like
 * every other method.
 *
 * The server authenticates, checks the optional human check and sends email; the service
 * decides everything else. Session IDs and link tokens appear in results once, for the
 * server to put in a cookie or a link: the database only keeps their hashes.
 */
import type {
  CreateInviteRequest,
  DeleteAccountRequest,
  InviteCheck,
  InviteInfo,
  MemberInfo,
  MembersResult,
  ResetLink,
  ReviewRequest,
  ReviewResult,
  ReviewVolunteerRequest,
  SetupRequest,
  SignInRequest,
  SignUpRequest,
  SuggestionInfo,
  SuggestionsPage,
  SuggestionsQuery,
  TextValue,
  TranslationInfo,
  UpdateAccountRequest,
  UpdateMemberRequest,
  UserInfo,
  VolunteerRequest,
} from "@quaso/core";
import type { Actor } from "./api.ts";

/** A new session: its ID for the server's cookie, and the account. */
export interface SignedIn {
  sessionId: string;
  expiresAt: number;
  user: UserInfo;
}

/** The browser's user agent, kept with a new session (for "your sessions", later). */
export interface WithUserAgent {
  userAgent?: string;
}

export type IdentityProvider = "github" | "discord";

/** What the server learned from GitHub or Discord. */
export interface IdentityInput extends WithUserAgent {
  provider: IdentityProvider;
  /** The provider's account ID. */
  subject: string;
  username?: string | null;
  email?: string | null;
  /** The provider verified the email address. */
  emailVerified?: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Link to this signed-in person instead of signing in. */
  linkToUserId?: number;
  /** Browser linking: recheck this session atomically, after the provider exchange. */
  linkSessionId?: string;
  /** An invite link's token, for a new account. */
  invite?: string;
}

export interface IdentityResult {
  /** Null when linking: the person keeps their session. */
  sessionId: string | null;
  expiresAt: number | null;
  user: UserInfo;
  /** A new account was created. */
  created: boolean;
}

export type EmailPurpose = "verify" | "reset" | "signin";

/** A link's token for an email: shown once. */
export interface EmailTokenResult {
  token: string;
  userId: number;
  email: string;
  expiresAt: number;
}

/** The direct edits' result: the translation after the change (null: red). */
export interface TranslationResult {
  translation: TranslationInfo | null;
}

/** A string and a language, with the revision a change is based on. */
export interface TranslationTarget {
  /** The string. */
  id: number;
  language: string;
  baseRevision: number;
}

export interface AccountsApi {
  // --- Sessions (S6.1, S6.2).
  /** Anyone: the signed-in person (null for others), and whether setup is still needed. */
  getSession(
    actor: Actor,
    input: Record<string, never>,
  ): Promise<{ user: UserInfo | null; setupRequired: boolean }>;
  /** System only: the person a session belongs to; slides its expiry. */
  resolveSession(
    actor: Actor,
    input: { sessionId: string },
  ): Promise<{ userId: number; expiresAt: number } | null>;
  /** Anyone: a new account (with an invite's role), signed in. The server checks `humanCheck`. */
  signUp(actor: Actor, input: SignUpRequest & WithUserAgent): Promise<SignedIn>;
  /** Anyone: `unauthorized` for any wrong email address or password. */
  signIn(actor: Actor, input: SignInRequest & WithUserAgent): Promise<SignedIn>;
  /** Anyone holding the session's ID. */
  signOut(actor: Actor, input: { sessionId: string }): Promise<{ ok: true }>;

  // --- First start (S6.3).
  /**
   * System only: while there is no administrator, the setup credential (`token`, supplied by
   * the operator, or one generated for internal tooling); null afterwards.
   */
  ensureSetupToken(actor: Actor, input: { token?: string }): Promise<{ token: string | null }>;
  /** Anyone: whether a setup token is valid (constant time); false once set up. */
  validateSetupToken(actor: Actor, input: { token: string }): Promise<{ ok: boolean }>;
  /** Anyone with the setup token: the first administrator and the project's name. */
  completeSetup(actor: Actor, input: SetupRequest & WithUserAgent): Promise<SignedIn>;
  /** System, development instances only: the developer account (an administrator). */
  ensureDevAccount(actor: Actor, input: Record<string, never>): Promise<UserInfo>;
  /** System, development instances only: a session for the developer account. */
  devSignIn(actor: Actor, input: WithUserAgent): Promise<SignedIn>;

  // --- Other ways to sign in (S6.4).
  /** System only (the server's OAuth callback). */
  signInWithIdentity(actor: Actor, input: IdentityInput): Promise<IdentityResult>;
  /** The signed-in person; refused for their last way to sign in. */
  unlinkIdentity(actor: Actor, input: { provider: IdentityProvider }): Promise<UserInfo>;
  /** System only: a link's token for the account with this address, or null. */
  createEmailToken(
    actor: Actor,
    input: { email: string; purpose: EmailPurpose },
  ): Promise<EmailTokenResult | null>;
  /** Anyone holding the link. */
  verifyEmail(actor: Actor, input: { token: string }): Promise<{ ok: true }>;
  /** Anyone holding the link: a new password, every other session signed out. */
  resetPassword(
    actor: Actor,
    input: { token: string; password: string } & WithUserAgent,
  ): Promise<SignedIn>;
  /** Anyone holding the link. */
  signInWithEmailLink(actor: Actor, input: { token: string } & WithUserAgent): Promise<SignedIn>;
  /** Administrators: a reset link to pass on, for teams without an email service. */
  createResetLink(actor: Actor, input: { userId: number; baseUrl: string }): Promise<ResetLink>;

  // --- The account (S6.10, OPS-3).
  /** The signed-in person. */
  getAccount(actor: Actor, input: Record<string, never>): Promise<UserInfo>;
  /**
   * The signed-in person. The email address and the password need `currentPassword` when
   * the account has one. A new password signs out every session but `sessionId`.
   */
  updateAccount(
    actor: Actor,
    input: UpdateAccountRequest & { sessionId?: string },
  ): Promise<UserInfo>;
  /** The signed-in person, with their password when the account has one. */
  deleteAccount(actor: Actor, input: DeleteAccountRequest): Promise<{ ok: true }>;

  // --- Volunteers and the team (S6.6, ROLE-1 to ROLE-3).
  /** A signed-in person without a role. The server checks `humanCheck`. */
  requestVolunteer(actor: Actor, input: VolunteerRequest): Promise<UserInfo>;
  /** Administrators. */
  listVolunteerRequests(actor: Actor, input: Record<string, never>): Promise<MembersResult>;
  /** Administrators. */
  reviewVolunteer(
    actor: Actor,
    input: ReviewVolunteerRequest & { userId: number },
  ): Promise<MemberInfo>;
  /** Administrators: members, and people waiting for an answer. */
  listMembers(actor: Actor, input: Record<string, never>): Promise<MembersResult>;
  /** Administrators. The last administrator stays one. */
  updateMember(actor: Actor, input: UpdateMemberRequest & { id: number }): Promise<MemberInfo>;
  /** Administrators: the role goes; the account stays. */
  removeMember(actor: Actor, input: { id: number }): Promise<{ ok: true }>;
  /** Administrators: the link (`url`) appears only in this result. */
  createInvite(actor: Actor, input: CreateInviteRequest & { baseUrl: string }): Promise<InviteInfo>;
  /** Administrators. */
  listInvites(actor: Actor, input: Record<string, never>): Promise<{ invites: InviteInfo[] }>;
  /** Administrators. */
  revokeInvite(actor: Actor, input: { id: number }): Promise<{ ok: true }>;
  /** Anyone: whether an invite link is still valid, for the sign-up page. */
  checkInvite(actor: Actor, input: { token: string }): Promise<InviteCheck>;

  // --- Suggestions and review (S6.7, S6.8; STR-2, WEB-4).
  /** Contributors and above, in their languages. */
  suggest(
    actor: Actor,
    input: TranslationTarget & {
      kind: "translation" | "correction" | "approval";
      value?: TextValue;
    },
  ): Promise<SuggestionInfo>;
  /** The suggestion's author, while it is pending. */
  withdrawSuggestion(actor: Actor, input: { id: number }): Promise<SuggestionInfo>;
  /** Managers and administrators: everyone's; others: their own. */
  listSuggestions(actor: Actor, input: SuggestionsQuery): Promise<SuggestionsPage>;
  /** Managers and administrators, in their languages. */
  reviewSuggestions(actor: Actor, input: ReviewRequest): Promise<ReviewResult>;

  // --- Direct edits (S6.9): managers and administrators, in their languages.
  /** Blue. */
  saveTranslation(
    actor: Actor,
    input: TranslationTarget & { value: TextValue },
  ): Promise<TranslationResult>;
  /** Green (or outdated) to blue, as it is. */
  approveTranslation(actor: Actor, input: TranslationTarget): Promise<TranslationResult>;
  /** Blue to green. */
  unapproveTranslation(actor: Actor, input: TranslationTarget): Promise<TranslationResult>;
  /** To red. */
  deleteTranslation(actor: Actor, input: TranslationTarget): Promise<TranslationResult>;
}

/** The method names above, for the internal HTTP API's allowlist. */
export const ACCOUNTS_METHODS = [
  "getSession",
  "resolveSession",
  "signUp",
  "signIn",
  "signOut",
  "ensureSetupToken",
  "validateSetupToken",
  "completeSetup",
  "ensureDevAccount",
  "devSignIn",
  "signInWithIdentity",
  "unlinkIdentity",
  "createEmailToken",
  "verifyEmail",
  "resetPassword",
  "signInWithEmailLink",
  "createResetLink",
  "getAccount",
  "updateAccount",
  "deleteAccount",
  "requestVolunteer",
  "listVolunteerRequests",
  "reviewVolunteer",
  "listMembers",
  "updateMember",
  "removeMember",
  "createInvite",
  "listInvites",
  "revokeInvite",
  "checkInvite",
  "suggest",
  "withdrawSuggestion",
  "listSuggestions",
  "reviewSuggestions",
  "saveTranslation",
  "approveTranslation",
  "unapproveTranslation",
  "deleteTranslation",
] as const satisfies readonly (keyof AccountsApi)[];

/** Those that only read (or, like `resolveSession`, are safe to repeat). */
export const ACCOUNTS_SAFE_METHODS = [
  "getSession",
  "resolveSession",
  "validateSetupToken",
  "getAccount",
  "listVolunteerRequests",
  "listMembers",
  "listInvites",
  "checkInvite",
  "listSuggestions",
] as const satisfies readonly (keyof AccountsApi)[];
