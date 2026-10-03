// SPDX-License-Identifier: MIT
/**
 * The `AccountsApi` methods of the service: each checks the actor, the permission and the
 * input, then works in one transaction. Methods with a password hash it (or check it)
 * first, outside the transaction, since that is asynchronous and slow on purpose; the
 * transaction then refuses if the account changed meanwhile.
 */
import {
  CreateInviteRequest,
  DeleteAccountRequest,
  Email,
  Id,
  LanguageTag,
  ResetPasswordRequest,
  ReviewRequest,
  ReviewVolunteerRequest,
  s,
  SaveTranslationRequest,
  type Schema,
  SetupRequest,
  SignInRequest,
  SignUpRequest,
  SuggestionsQuery,
  SuggestRequest,
  TokenRequest,
  TranslationActionRequest,
  UpdateAccountRequest,
  UpdateMemberRequest,
  VolunteerRequest,
} from "@quaso/core";
import * as accounts from "./accounts.ts";
import type { AccountsApi } from "./accounts_api.ts";
import { authorFor } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { transaction } from "./db.ts";
import * as edits from "./edits.ts";
import { badRequest, forbidden, unauthorized } from "./errors.ts";
import { hashPassword, type PasswordOptions, verifyPassword } from "./passwords.ts";
import { type Action, requirePermission } from "./permissions.ts";
import { deleteSession, resolveSession } from "./sessions.ts";
import * as suggestions from "./suggestions.ts";
import * as team from "./team.ts";
import { loadUser, requireUserRow, setupRequired, userIdOf, userInfo } from "./users.ts";
import { validateActor, validateInput } from "./validation.ts";

export interface AccountsOptions {
  /** A development instance: the developer account and its one-click sign-in. */
  dev: boolean;
  /** PBKDF2 iterations for new password hashes. Default: `DEFAULT_ITERATIONS`. */
  passwordIterations?: number;
}

/** The service's `call`: actor, permission and input checks, then one transaction. */
export type Call = <I, O>(
  caller: Actor,
  action: Action | null,
  schema: Schema<I>,
  input: unknown,
  fn: (input: I, actor: Actor) => O,
) => Promise<O>;

const UserAgent = s.string({ maxLength: 1000 }).optional();
const Token = s.string({ minLength: 1, maxLength: 200 });
const Empty = s.object({});
const IdInput = s.object({ id: Id });
const TokenInput = s.object({ token: Token });
const SessionInput = s.object({ sessionId: Token });
const Provider = s.enum(["github", "discord"]);
const BaseUrl = s.string({ minLength: 1, maxLength: 500 });

const Inputs = {
  signUp: SignUpRequest.extend({ userAgent: UserAgent }),
  signIn: SignInRequest.extend({ userAgent: UserAgent }),
  setup: SetupRequest.extend({ userAgent: UserAgent }),
  ensureSetupToken: s.object({ token: Token.optional() }),
  devSignIn: s.object({ userAgent: UserAgent }),
  identity: s.object({
    provider: Provider,
    subject: Token,
    username: s.string({ maxLength: 200 }).nullable().optional(),
    email: s.string({ maxLength: 254 }).nullable().optional(),
    emailVerified: s.boolean().optional(),
    displayName: s.string({ maxLength: 200 }).nullable().optional(),
    avatarUrl: s.string({ maxLength: 2000 }).nullable().optional(),
    linkToUserId: Id.optional(),
    linkSessionId: Token.optional(),
    invite: Token.optional(),
    userAgent: UserAgent,
  }),
  provider: s.object({ provider: Provider }),
  emailToken: s.object({ email: Email, purpose: s.enum(["verify", "reset", "signin"]) }),
  reset: ResetPasswordRequest.extend({ token: Token, userAgent: UserAgent }),
  emailLink: TokenRequest.extend({ token: Token, userAgent: UserAgent }),
  resetLink: s.object({ userId: Id, baseUrl: BaseUrl }),
  updateAccount: UpdateAccountRequest.extend({ sessionId: Token.optional() }),
  reviewVolunteer: ReviewVolunteerRequest.extend({ userId: Id }),
  updateMember: UpdateMemberRequest.extend({ id: Id }),
  createInvite: CreateInviteRequest.extend({ baseUrl: BaseUrl }),
  suggest: SuggestRequest.extend({ id: Id, language: LanguageTag }),
  save: SaveTranslationRequest.extend({ id: Id, language: LanguageTag }),
  translationAction: TranslationActionRequest.extend({ id: Id, language: LanguageTag }),
};

/** The `AccountsApi` methods, on the service's context and `call`. */
export function accountsMethods(ctx: Context, call: Call, options: AccountsOptions): AccountsApi {
  const passwords: PasswordOptions = {
    iterations: options.passwordIterations,
  };
  const tx = <T>(fn: () => T): T => transaction(ctx.sql, fn);

  /** Checks the actor and the input, then runs an asynchronous flow. */
  async function flow<I, O>(
    caller: unknown,
    schema: Schema<I>,
    input: unknown,
    fn: (input: I, actor: Actor) => Promise<O>,
  ): Promise<O> {
    const actor: Actor = validateActor(caller);
    return await fn(validateInput(schema, input), actor);
  }

  function systemOnly(actor: Actor): void {
    if (actor.type !== "system") throw forbidden();
  }

  function devOnly(actor: Actor): void {
    systemOnly(actor);
    if (!options.dev) {
      throw forbidden("The developer account only exists on development instances.");
    }
  }

  /** The signed-in person's password hash (null without one), with the permission checked. */
  function ownPassword(actor: Actor): { userId: number; hash: string | null } {
    return tx(() => {
      requirePermission(ctx, actor, "account");
      const userId = userIdOf(actor);
      return { userId, hash: requireUserRow(ctx.sql, userId).password_hash };
    });
  }

  return {
    // --- Sessions.
    getSession: (caller, input) =>
      call(caller, null, Empty, input, (_input, actor) => {
        const row = actor.type === "user" ? loadUser(ctx.sql, actor.userId) : undefined;
        return {
          user: row === undefined || row.deleted_at !== null ? null : userInfo(ctx.sql, row),
          setupRequired: setupRequired(ctx.sql),
        };
      }),
    resolveSession: (caller, input) =>
      call(caller, null, SessionInput, input, ({ sessionId }, actor) => {
        systemOnly(actor);
        return resolveSession(ctx, sessionId);
      }),
    signUp: (caller, input) =>
      flow(caller, Inputs.signUp, input, async (request) => {
        const hash = await hashPassword(request.password, passwords);
        return tx(() =>
          accounts.signUp(
            ctx,
            { email: request.email, displayName: request.displayName, invite: request.invite },
            hash,
            request.userAgent,
          ),
        );
      }),
    signIn: (caller, input) =>
      flow(caller, Inputs.signIn, input, async (request) => {
        const found = tx(() => accounts.passwordFor(ctx, request.email));
        const checked = await verifyPassword(request.password, found?.hash ?? null, passwords);
        if (found === null || !checked.ok) {
          ctx.logger.info("Sign-in refused");
          throw unauthorized(accounts.WRONG_CREDENTIALS);
        }
        const rehash = checked.needsRehash ? await hashPassword(request.password, passwords) : null;
        return tx(() =>
          accounts.completeSignIn(ctx, found.userId, found.hash, rehash, request.userAgent),
        );
      }),
    signOut: (caller, input) =>
      call(caller, null, SessionInput, input, ({ sessionId }) => {
        deleteSession(ctx, sessionId);
        return { ok: true as const };
      }),

    // --- First start.
    ensureSetupToken: (caller, input) =>
      call(caller, null, Inputs.ensureSetupToken, input, ({ token }, actor) => {
        systemOnly(actor);
        return { token: accounts.ensureSetupToken(ctx, token) };
      }),
    validateSetupToken: (caller, input) =>
      call(caller, null, TokenInput, input, ({ token }) => ({
        ok: accounts.validateSetupToken(ctx, token),
      })),
    completeSetup: (caller, input) =>
      flow(caller, Inputs.setup, input, async (request) => {
        // Refuse a wrong link before spending time on the password.
        tx(() => {
          if (!setupRequired(ctx.sql)) throw forbidden("This instance is set up already.");
          if (!accounts.validateSetupToken(ctx, request.token)) {
            throw forbidden(
              "The setup key is incorrect. Use the key from the deployment configuration.",
            );
          }
        });
        const hash = await hashPassword(request.password, passwords);
        const { password: _password, userAgent, ...rest } = request;
        return tx(() => accounts.completeSetup(ctx, rest, hash, userAgent));
      }),
    ensureDevAccount: (caller, input) =>
      call(caller, null, Empty, input, (_input, actor) => {
        devOnly(actor);
        return userInfo(ctx.sql, accounts.ensureDevAccount(ctx));
      }),
    devSignIn: (caller, input) =>
      call(caller, null, Inputs.devSignIn, input, ({ userAgent }, actor) => {
        devOnly(actor);
        return accounts.devSignIn(ctx, userAgent);
      }),

    // --- Other ways to sign in.
    signInWithIdentity: (caller, input) =>
      call(caller, null, Inputs.identity, input, (fields, actor) => {
        systemOnly(actor);
        return accounts.signInWithIdentity(ctx, fields);
      }),
    unlinkIdentity: (caller, input) =>
      call(caller, "account", Inputs.provider, input, ({ provider }, actor) =>
        accounts.unlinkIdentity(ctx, userIdOf(actor), provider),
      ),
    createEmailToken: (caller, input) =>
      call(caller, null, Inputs.emailToken, input, ({ email, purpose }, actor) => {
        systemOnly(actor);
        return accounts.createEmailToken(ctx, email, purpose);
      }),
    verifyEmail: (caller, input) =>
      call(caller, null, TokenInput, input, ({ token }) => {
        accounts.verifyEmail(ctx, token);
        return { ok: true as const };
      }),
    resetPassword: (caller, input) =>
      flow(caller, Inputs.reset, input, async (request) => {
        const hash = await hashPassword(request.password, passwords);
        return tx(() => accounts.resetPassword(ctx, request.token, hash, request.userAgent));
      }),
    signInWithEmailLink: (caller, input) =>
      call(caller, null, Inputs.emailLink, input, ({ token, userAgent }) =>
        accounts.signInWithEmailLink(ctx, token, userAgent),
      ),
    createResetLink: (caller, input) =>
      call(caller, "team", Inputs.resetLink, input, ({ userId, baseUrl }) => {
        const link = accounts.createResetLink(ctx, userId, baseUrl);
        ctx.logger.info("Reset link created", { userId });
        return link;
      }),

    // --- The account.
    getAccount: (caller, input) =>
      call(caller, "account", Empty, input, (_input, actor) =>
        userInfo(ctx.sql, requireUserRow(ctx.sql, userIdOf(actor))),
      ),
    updateAccount: (caller, input) =>
      flow(caller, Inputs.updateAccount, input, async (request, actor) => {
        const own = ownPassword(actor);
        const sensitive = request.email !== undefined || request.password !== undefined;
        if (sensitive && own.hash !== null) {
          if (request.currentPassword === undefined) {
            throw badRequest(
              "Enter your current password to change your email address or password.",
            );
          }
          const checked = await verifyPassword(request.currentPassword, own.hash, passwords);
          if (!checked.ok) throw forbidden("The current password is wrong.");
        }
        const passwordHash =
          request.password === undefined
            ? undefined
            : await hashPassword(request.password, passwords);
        return tx(() => {
          requirePermission(ctx, actor, "account");
          return accounts.updateAccount(
            ctx,
            own.userId,
            {
              displayName: request.displayName,
              email: request.email,
              passwordHash,
              keepSessionId: request.sessionId,
            },
            sensitive ? own.hash : undefined,
          );
        });
      }),
    deleteAccount: (caller, input) =>
      flow(caller, DeleteAccountRequest, input, async (request, actor) => {
        const own = ownPassword(actor);
        if (own.hash !== null) {
          if (request.password === undefined) {
            throw badRequest("Enter your password to delete your account.");
          }
          const checked = await verifyPassword(request.password, own.hash, passwords);
          if (!checked.ok) throw forbidden("The password is wrong.");
        }
        tx(() => {
          requirePermission(ctx, actor, "account");
          accounts.deleteAccount(ctx, own.userId, own.hash);
        });
        return { ok: true as const };
      }),

    // --- Volunteers and the team.
    requestVolunteer: (caller, input) =>
      call(caller, "volunteer", VolunteerRequest, input, (request, actor) =>
        team.requestVolunteer(ctx, userIdOf(actor), request),
      ),
    listVolunteerRequests: (caller, input) =>
      call(caller, "team", Empty, input, () => team.listVolunteerRequests(ctx)),
    reviewVolunteer: (caller, input) =>
      call(caller, "team", Inputs.reviewVolunteer, input, ({ userId, ...review }, actor) =>
        team.reviewVolunteer(ctx, authorFor(ctx, actor), userId, review),
      ),
    listMembers: (caller, input) => call(caller, "team", Empty, input, () => team.listMembers(ctx)),
    updateMember: (caller, input) =>
      call(caller, "team", Inputs.updateMember, input, ({ id, ...change }, actor) =>
        team.updateMember(ctx, authorFor(ctx, actor), id, change),
      ),
    removeMember: (caller, input) =>
      call(caller, "team", IdInput, input, ({ id }, actor) => {
        team.removeMember(ctx, authorFor(ctx, actor), id);
        return { ok: true as const };
      }),
    createInvite: (caller, input) =>
      call(caller, "team", Inputs.createInvite, input, ({ baseUrl, ...request }, actor) =>
        team.createInvite(ctx, authorFor(ctx, actor), request, baseUrl),
      ),
    listInvites: (caller, input) => call(caller, "team", Empty, input, () => team.listInvites(ctx)),
    revokeInvite: (caller, input) =>
      call(caller, "team", IdInput, input, ({ id }) => {
        team.revokeInvite(ctx, id);
        return { ok: true as const };
      }),
    checkInvite: (caller, input) =>
      call(caller, null, TokenInput, input, ({ token }) => team.checkInvite(ctx, token)),

    // --- Suggestions and review.
    suggest: (caller, input) =>
      call(caller, "suggest", Inputs.suggest, input, (request, actor) =>
        suggestions.suggest(ctx, actor, request),
      ),
    withdrawSuggestion: (caller, input) =>
      call(caller, "account", IdInput, input, ({ id }, actor) =>
        suggestions.withdrawSuggestion(ctx, actor, id),
      ),
    listSuggestions: (caller, input) =>
      call(caller, "account", SuggestionsQuery, input, (query, actor) =>
        suggestions.listSuggestions(ctx, actor, query),
      ),
    reviewSuggestions: (caller, input) =>
      call(caller, "review", ReviewRequest, input, (request, actor) => {
        const result = suggestions.reviewSuggestions(ctx, actor, request);
        ctx.logger.info("Review", {
          action: request.action,
          approved: result.approved.length,
          rejected: result.rejected.length,
          failed: result.failed.length,
        });
        return result;
      }),

    // --- Direct edits.
    saveTranslation: (caller, input) =>
      call(caller, "edit", Inputs.save, input, (request, actor) =>
        edits.saveTranslation(ctx, actor, request),
      ),
    approveTranslation: (caller, input) =>
      call(caller, "edit", Inputs.translationAction, input, (request, actor) =>
        edits.approveTranslation(ctx, actor, request),
      ),
    unapproveTranslation: (caller, input) =>
      call(caller, "edit", Inputs.translationAction, input, (request, actor) =>
        edits.unapproveTranslation(ctx, actor, request),
      ),
    deleteTranslation: (caller, input) =>
      call(caller, "edit", Inputs.translationAction, input, (request, actor) =>
        edits.deleteTranslation(ctx, actor, request),
      ),
  };
}
