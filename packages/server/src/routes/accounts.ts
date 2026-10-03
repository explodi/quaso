// SPDX-License-Identifier: MIT
/**
 * The API routes for people (design §5.8, §5.11; Sprint 6), under `/api/v1`: sign-in and
 * sessions, the account, volunteers and the team, suggestions and review, and direct
 * edits. `API_ROUTES` includes them, so the router serves them and the OpenAPI document
 * describes them. Routes that sign in answer with the session info and set the session
 * cookie; the others answer what the service returns.
 */
import {
  CreateInviteRequest,
  DeleteAccountRequest,
  EmailRequest,
  Id,
  LanguageTag,
  ResetPasswordRequest,
  ReviewRequest,
  ReviewVolunteerRequest,
  Revision,
  s,
  SaveTranslationRequest,
  SetupRequest,
  SignInRequest,
  SignUpRequest,
  SuggestionsQuery,
  SuggestRequest,
  TokenRequest,
  UpdateAccountRequest,
  UpdateMemberRequest,
  VolunteerRequest,
} from "@quaso/core";
import { SYSTEM, ServiceError } from "@quaso/service";
import { json } from "../http/response.ts";
import { RATE_RULES } from "../rate_limit.ts";
import { setupKeyConfigured } from "../setup_key.ts";
import type { ApiRoute } from "./api.ts";
import { route } from "./route.ts";

const IdParams = s.object({ id: Id });
const UserIdParams = s.object({ userId: Id });
const TokenParams = s.object({ token: s.string({ minLength: 1, maxLength: 200 }) });
const ProviderParams = s.object({ provider: s.enum(["github", "discord"]) });
const TranslationParams = s.object({ id: Id, lang: LanguageTag });
const Revisioned = { baseRevision: Revision.optional() };
const SaveBody = SaveTranslationRequest.extend(Revisioned);
const ActionBody = s.object(Revisioned);

function userAgent(request: Request): string | undefined {
  return request.headers.get("User-Agent")?.slice(0, 1000) ?? undefined;
}

function noContent(setCookie?: string): Response {
  const response = new Response(null, { status: 204 });
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}

function emailServiceOff(what: string): ServiceError {
  return new ServiceError(
    "not_found",
    `${what} by email is off on this instance: there is no email service. ` +
      "Ask an administrator for a reset link.",
  );
}

/**
 * The translation's revision a change is based on: `baseRevision` in the body, or the
 * `If-Match` header (`12` or `"12"`); both must agree when both are sent.
 */
export function baseRevisionOf(body: { baseRevision?: number }, request: Request): number {
  const header = request.headers.get("If-Match");
  let fromHeader: number | undefined;
  if (header !== null) {
    const match = header.trim().match(/^(?:W\/)?"?(\d{1,15})"?$/);
    if (!match) {
      throw new ServiceError("validation_failed", "If-Match must be the translation's revision.", {
        details: [{ path: "If-Match", message: 'must be a revision, such as "12"' }],
      });
    }
    fromHeader = Number(match[1]);
  }
  if (
    body.baseRevision !== undefined &&
    fromHeader !== undefined &&
    body.baseRevision !== fromHeader
  ) {
    throw new ServiceError("bad_request", "baseRevision and If-Match name different revisions.");
  }
  const revision = body.baseRevision ?? fromHeader;
  if (revision === undefined) {
    throw new ServiceError(
      "validation_failed",
      "Invalid request: baseRevision is required (or send the revision in If-Match).",
      { details: [{ path: "baseRevision", message: "is required" }] },
    );
  }
  return revision;
}

export const ACCOUNT_ROUTES: ApiRoute[] = [
  // --- Sign-in and sessions.
  route({
    method: "GET",
    path: "/auth/session",
    operationId: "getSession",
    summary: "Who is signed in, whether setup is needed, and the sign-in methods on offer",
    tag: "Sign-in",
    access: "anyone",
    handle: async ({ actor, http }) => {
      const info = await http.accounts.sessionInfo(actor);
      if (info.user !== null || http.session === null) return info;
      // A cookie whose person is gone (a deleted account's other devices): forget it.
      const response = json(info);
      response.headers.append("Set-Cookie", http.accounts.sessions.clear());
      return response;
    },
  }),
  route({
    method: "POST",
    path: "/auth/signup",
    operationId: "signUp",
    summary: "Create an account (with an invite's role, if any) and sign in",
    tag: "Sign-in",
    access: "anyone",
    body: SignUpRequest,
    handle: async ({ service, actor, body, http }) => {
      http.accounts.limitSignIn(http.ip, body.email);
      await http.accounts.humanCheck(body.humanCheck, http.ip);
      const { humanCheck: _check, ...request } = body;
      const result = await service.signUp(actor, {
        ...request,
        userAgent: userAgent(http.request),
      });
      if (result.user.email !== null) http.accounts.emailLink("verify", result.user.email);
      return await http.accounts.signedIn(result, http.session);
    },
  }),
  route({
    method: "POST",
    path: "/auth/signin",
    operationId: "signIn",
    summary: "Sign in with an email address and a password",
    tag: "Sign-in",
    access: "anyone",
    body: SignInRequest,
    handle: async ({ service, actor, body, http }) => {
      http.accounts.limitSignIn(http.ip, body.email);
      const result = await service.signIn(actor, { ...body, userAgent: userAgent(http.request) });
      return await http.accounts.signedIn(result, http.session);
    },
  }),
  route({
    method: "POST",
    path: "/auth/signout",
    operationId: "signOut",
    summary: "Sign out: the session ends",
    tag: "Sign-in",
    access: "anyone",
    optionalBody: true,
    body: s.object({}),
    handle: async ({ service, actor, http }) => {
      if (http.session) await service.signOut(actor, { sessionId: http.session.sessionId });
      return noContent(http.accounts.sessions.clear());
    },
  }),
  route({
    method: "POST",
    path: "/auth/setup",
    operationId: "completeSetup",
    summary: "First start: create the first administrator with the setup key, and name the project",
    tag: "Sign-in",
    access: "anyone",
    body: SetupRequest,
    handle: async ({ service, actor, body, http }) => {
      if (!(await service.getSession(SYSTEM, {})).setupRequired)
        throw new ServiceError("not_found", "Setup is no longer available.");
      if (!setupKeyConfigured(http.accounts.config))
        throw new ServiceError(
          "unavailable",
          "Set SETUP_KEY to at least 16 random characters, then restart.",
        );
      http.accounts.limiter.check([`setup:${http.ip ?? "unknown"}`, RATE_RULES.setup]);
      const result = await service.completeSetup(actor, {
        ...body,
        userAgent: userAgent(http.request),
      });
      return await http.accounts.signedIn(result, http.session);
    },
  }),
  route({
    method: "POST",
    path: "/auth/password-reset/request",
    operationId: "requestPasswordReset",
    summary: "Email a password reset link (always 204, whether the address has an account or not)",
    tag: "Sign-in",
    access: "anyone",
    body: EmailRequest,
    status: 204,
    handle: async ({ service, body, http }) => {
      if (!(await service.emailStatus(SYSTEM, {})).available)
        throw emailServiceOff("Password reset");
      http.accounts.limitEmail(http.ip, body.email);
      // In the background: waiting would tell whether the address has an account.
      http.accounts.emailLink("reset", body.email);
      return Promise.resolve(noContent());
    },
  }),
  route({
    method: "POST",
    path: "/auth/password-reset",
    operationId: "resetPassword",
    summary: "Choose a new password with a reset link's token; every other session ends",
    tag: "Sign-in",
    access: "anyone",
    body: ResetPasswordRequest,
    handle: async ({ service, actor, body, http }) => {
      http.accounts.limitSignIn(http.ip);
      const result = await service.resetPassword(actor, {
        ...body,
        userAgent: userAgent(http.request),
      });
      return await http.accounts.signedIn(result, http.session);
    },
  }),
  route({
    method: "POST",
    path: "/auth/verify-email",
    operationId: "verifyEmail",
    summary: "Verify an email address with the link's token",
    tag: "Sign-in",
    access: "anyone",
    body: TokenRequest,
    handle: ({ service, actor, body, http }) => {
      http.accounts.limitSignIn(http.ip);
      return service.verifyEmail(actor, body);
    },
  }),
  route({
    method: "POST",
    path: "/auth/email-link/request",
    operationId: "requestEmailLink",
    summary: "Email a sign-in link (always 204, whether the address has an account or not)",
    tag: "Sign-in",
    access: "anyone",
    body: EmailRequest,
    status: 204,
    handle: async ({ service, body, http }) => {
      if (!(await service.emailStatus(SYSTEM, {})).available) throw emailServiceOff("Signing in");
      http.accounts.limitEmail(http.ip, body.email);
      // In the background: waiting would tell whether the address has an account.
      http.accounts.emailLink("signin", body.email);
      return Promise.resolve(noContent());
    },
  }),
  route({
    method: "POST",
    path: "/auth/email-link",
    operationId: "signInWithEmailLink",
    summary: "Sign in with a sign-in link's token",
    tag: "Sign-in",
    access: "anyone",
    body: TokenRequest,
    handle: async ({ service, actor, body, http }) => {
      if (!(await service.emailStatus(SYSTEM, {})).available) throw emailServiceOff("Signing in");
      http.accounts.limitSignIn(http.ip);
      const result = await service.signInWithEmailLink(actor, {
        ...body,
        userAgent: userAgent(http.request),
      });
      return await http.accounts.signedIn(result, http.session);
    },
  }),

  // --- The account.
  route({
    method: "GET",
    path: "/account",
    operationId: "getAccount",
    summary: "Your account",
    tag: "Account",
    access: "signed in",
    handle: ({ service, actor }) => service.getAccount(actor, {}),
  }),
  route({
    method: "PATCH",
    path: "/account",
    operationId: "updateAccount",
    summary: "Change your name, email address or password (the last two need the current password)",
    tag: "Account",
    access: "signed in",
    body: UpdateAccountRequest,
    handle: async ({ service, actor, body, http }) => {
      if (body.currentPassword !== undefined) http.accounts.limitPasswordCheck(http.ip, actor);
      const user = await service.updateAccount(actor, {
        ...body,
        ...(http.session ? { sessionId: http.session.sessionId } : {}),
      });
      if (body.email !== undefined && user.email !== null && !user.emailVerified) {
        http.accounts.emailLink("verify", user.email);
      }
      return user;
    },
  }),
  route({
    method: "DELETE",
    path: "/account",
    operationId: "deleteAccount",
    summary:
      'Delete your account (OPS-3): confirm with "delete", and your password if you have one',
    tag: "Account",
    access: "signed in",
    body: DeleteAccountRequest,
    handle: async ({ service, actor, body, http }) => {
      if (body.password !== undefined) http.accounts.limitPasswordCheck(http.ip, actor);
      const result = await service.deleteAccount(actor, body);
      const response = json(result);
      response.headers.append("Set-Cookie", http.accounts.sessions.clear());
      return response;
    },
  }),
  route({
    method: "DELETE",
    path: "/account/identities/:provider",
    operationId: "unlinkIdentity",
    summary: "Unlink GitHub or Discord (not the account's last way to sign in)",
    tag: "Account",
    access: "signed in",
    params: ProviderParams,
    handle: ({ service, actor, params }) => service.unlinkIdentity(actor, params),
  }),
  route({
    method: "POST",
    path: "/volunteer-requests",
    operationId: "requestVolunteer",
    summary: "Ask to become a volunteer, with languages and a message",
    tag: "Team",
    access: "signed in",
    body: VolunteerRequest,
    status: 201,
    handle: async ({ service, actor, body, http }) => {
      await http.accounts.humanCheck(body.humanCheck, http.ip);
      const { humanCheck: _check, ...request } = body;
      return await service.requestVolunteer(actor, request);
    },
  }),

  // --- The team (administrators).
  route({
    method: "GET",
    path: "/team/members",
    operationId: "listMembers",
    summary: "Members, and people waiting for an answer to their volunteer request",
    tag: "Team",
    access: "administrator",
    handle: ({ service, actor }) => service.listMembers(actor, {}),
  }),
  route({
    method: "PATCH",
    path: "/team/members/:id",
    operationId: "updateMember",
    summary: "Change a member's role or languages (the last administrator stays one)",
    tag: "Team",
    access: "administrator",
    params: IdParams,
    body: UpdateMemberRequest,
    handle: ({ service, actor, params, body }) =>
      service.updateMember(actor, { ...body, id: params.id }),
  }),
  route({
    method: "DELETE",
    path: "/team/members/:id",
    operationId: "removeMember",
    summary: "Remove a member's role (the account stays)",
    tag: "Team",
    access: "administrator",
    params: IdParams,
    handle: ({ service, actor, params }) => service.removeMember(actor, params),
  }),
  route({
    method: "POST",
    path: "/team/members/:id/reset-link",
    operationId: "createResetLink",
    summary: "A password reset link to pass on, for instances without an email service",
    tag: "Team",
    access: "administrator",
    params: IdParams,
    handle: ({ service, actor, params, http }) =>
      service.createResetLink(actor, {
        userId: params.id,
        baseUrl: http.accounts.config.publicUrl,
      }),
  }),
  route({
    method: "GET",
    path: "/team/volunteer-requests",
    operationId: "listVolunteerRequests",
    summary: "Pending volunteer requests",
    tag: "Team",
    access: "administrator",
    handle: ({ service, actor }) => service.listVolunteerRequests(actor, {}),
  }),
  route({
    method: "POST",
    path: "/team/volunteer-requests/:userId",
    operationId: "reviewVolunteer",
    summary:
      "Approve a volunteer request (as a contributor or a manager, maybe for some languages) or reject it",
    tag: "Team",
    access: "administrator",
    params: UserIdParams,
    body: ReviewVolunteerRequest,
    handle: ({ service, actor, params, body }) =>
      service.reviewVolunteer(actor, { ...body, userId: params.userId }),
  }),
  route({
    method: "GET",
    path: "/team/invites",
    operationId: "listInvites",
    summary: "Invite links that aren't revoked",
    tag: "Team",
    access: "administrator",
    handle: ({ service, actor }) => service.listInvites(actor, {}),
  }),
  route({
    method: "POST",
    path: "/team/invites",
    operationId: "createInvite",
    summary: "Create a single-use invite link; the link appears only in this response",
    tag: "Team",
    access: "administrator",
    body: CreateInviteRequest,
    status: 201,
    handle: ({ service, actor, body, http }) =>
      service.createInvite(actor, { ...body, baseUrl: http.accounts.config.publicUrl }),
  }),
  route({
    method: "DELETE",
    path: "/team/invites/:id",
    operationId: "revokeInvite",
    summary: "Revoke an invite link",
    tag: "Team",
    access: "administrator",
    params: IdParams,
    handle: ({ service, actor, params }) => service.revokeInvite(actor, params),
  }),
  route({
    method: "GET",
    path: "/invites/:token",
    operationId: "checkInvite",
    summary: "Whether an invite link is still valid, and what it gives",
    tag: "Team",
    access: "anyone",
    params: TokenParams,
    handle: ({ service, actor, params }) => service.checkInvite(actor, params),
  }),

  // --- Direct edits (managers and administrators).
  route({
    method: "PUT",
    path: "/strings/:id/translations/:lang",
    operationId: "saveTranslation",
    summary: "Save a translation (blue); the revision in baseRevision or If-Match",
    tag: "Translations",
    access: "manager",
    params: TranslationParams,
    body: SaveBody,
    handle: ({ service, actor, params, body, http }) =>
      service.saveTranslation(actor, {
        id: params.id,
        language: params.lang,
        value: body.value,
        baseRevision: baseRevisionOf(body, http.request),
      }),
  }),
  route({
    method: "POST",
    path: "/strings/:id/translations/:lang/approve",
    operationId: "approveTranslation",
    summary: "Approve a translation as it is (blue); an outdated one becomes current",
    tag: "Translations",
    access: "manager",
    params: TranslationParams,
    body: ActionBody,
    optionalBody: true,
    handle: ({ service, actor, params, body, http }) =>
      service.approveTranslation(actor, {
        id: params.id,
        language: params.lang,
        baseRevision: baseRevisionOf(body, http.request),
      }),
  }),
  route({
    method: "POST",
    path: "/strings/:id/translations/:lang/unapprove",
    operationId: "unapproveTranslation",
    summary: "Unapprove a translation (green)",
    tag: "Translations",
    access: "manager",
    params: TranslationParams,
    body: ActionBody,
    optionalBody: true,
    handle: ({ service, actor, params, body, http }) =>
      service.unapproveTranslation(actor, {
        id: params.id,
        language: params.lang,
        baseRevision: baseRevisionOf(body, http.request),
      }),
  }),
  route({
    method: "DELETE",
    path: "/strings/:id/translations/:lang",
    operationId: "deleteTranslation",
    summary: "Delete a translation (red)",
    tag: "Translations",
    access: "manager",
    params: TranslationParams,
    body: ActionBody,
    optionalBody: true,
    handle: ({ service, actor, params, body, http }) =>
      service.deleteTranslation(actor, {
        id: params.id,
        language: params.lang,
        baseRevision: baseRevisionOf(body, http.request),
      }),
  }),

  // --- Suggestions and review.
  route({
    method: "POST",
    path: "/strings/:id/suggestions/:lang",
    operationId: "suggest",
    summary: 'Send a translation, a correction or "looks good" for review',
    tag: "Review",
    access: "contributor",
    params: TranslationParams,
    body: SuggestRequest,
    status: 201,
    handle: ({ service, actor, params, body }) =>
      service.suggest(actor, { ...body, id: params.id, language: params.lang }),
  }),
  route({
    method: "DELETE",
    path: "/suggestions/:id",
    operationId: "withdrawSuggestion",
    summary: "Withdraw your pending suggestion",
    tag: "Review",
    access: "signed in",
    params: IdParams,
    handle: ({ service, actor, params }) => service.withdrawSuggestion(actor, params),
  }),
  route({
    method: "GET",
    path: "/suggestions",
    operationId: "listSuggestions",
    summary: "Suggestions: everyone's for reviewers, your own for others (author=me)",
    tag: "Review",
    access: "signed in",
    query: SuggestionsQuery,
    handle: ({ service, actor, query }) => service.listSuggestions(actor, query),
  }),
  route({
    method: "POST",
    path: "/suggestions/review",
    operationId: "reviewSuggestions",
    summary: "Approve or reject one suggestion or many, with an optional comment",
    tag: "Review",
    access: "manager",
    body: ReviewRequest,
    handle: ({ service, actor, body }) => service.reviewSuggestions(actor, body),
  }),
];
