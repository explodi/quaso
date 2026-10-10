// SPDX-License-Identifier: MIT
/** Validated async writes, composed with the service's read methods. */
import {
  CreateJobRequest,
  ManagedSecretName,
  SetSecretRequest,
  CreateApiTokenRequest,
  CreateCommentRequest,
  CreateGlossaryTermRequest,
  AddLanguageRequest,
  LanguageTag,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateFileRequest,
  UpdateStringRequest,
  CreateLanguageRequestRequest,
  ReviewLanguageRequestRequest,
  CreateInviteRequest,
  UpdateMemberRequest,
  SignInRequest,
  SignUpRequest,
  SetupRequest,
  UpdateAccountRequest,
  DeleteAccountRequest,
  ResetPasswordRequest,
  VolunteerRequest,
  ReviewVolunteerRequest,
  SuggestRequest,
  ReviewRequest,
  SaveTranslationRequest,
  TranslationActionRequest,
  ImportRequest,
  RenameRequest,
  UpdateGlossaryTermRequest,
  Id,
  Email,
  s,
  type Schema,
} from "@quaso/core";
import {
  restoreRowsAsync,
  beginRestoreAsync,
  finishRestoreAsync,
  recordBackupAsync,
} from "./backup.ts";
import { renameKeyAsync } from "./rename.ts";
import { importTranslationsAsync } from "./imports.ts";
import { editTranslationAsync } from "./edits.ts";
import { FALLBACK_MODEL } from "./context.ts";
import {
  createGlossaryTermAsync,
  updateGlossaryTermAsync,
  deleteGlossaryTermAsync,
} from "./glossary.ts";
import { addCommentAsync, resolveCommentAsync, deleteCommentAsync } from "./comments.ts";
import { SYSTEM, type Actor, type ServiceApi } from "./api.ts";
import { type Action, readPermissions } from "./permissions.ts";
import { type Clock, type Logger, silentLogger, type Sql } from "./ports.ts";
import { authenticateTokenAsync, createApiTokenAsync, revokeApiTokenAsync } from "./tokens.ts";
import { validateActor, validateInput } from "./validation.ts";
import {
  addProjectLanguageAsync,
  updateProjectLanguageAsync,
  removeProjectLanguageAsync,
  updateSettingsAsync,
} from "./settings_writes.ts";
import { cancelJobAsync, createJobAsync } from "./jobs/jobs.ts";
import { suggestWithLlm } from "./jobs/llm_suggestion.ts";
import { recordRequestAsync } from "./jobs/usage.ts";
import { ModelList, SettingsModels } from "./jobs/models.ts";
import { withdrawSuggestionAsync, suggestAsync, reviewSuggestionsAsync } from "./suggestions.ts";
import type { TranslationProvider } from "./llm/provider.ts";
import type { LlmConfiguration } from "./llm/configuration.ts";
import { updateFileAsync, updateStringAsync } from "./metadata_writes.ts";
import { requestLanguageAsync, reviewLanguageRequestAsync } from "./language_requests.ts";
import { resolveSessionAsync, deleteSessionAsync } from "./sessions.ts";
import {
  signInAsync,
  signUpAsync,
  setupAsync,
  ensureSetupTokenAsync,
  ensureDevAccountAsync,
  devSignInAsync,
  unlinkIdentityAsync,
  updateAccountAsync,
  deleteAccountAsync,
  createEmailTokenAsync,
  createResetLinkAsync,
  verifyEmailAsync,
  resetPasswordAsync,
  signInWithEmailLinkAsync,
  signInWithIdentityAsync,
} from "./accounts.ts";
import { emailMethods } from "./email_configuration.ts";
import { changeSecretAsync } from "./secrets.ts";
import {
  createInviteAsync,
  revokeInviteAsync,
  updateMemberAsync,
  removeMemberAsync,
  requestVolunteerAsync,
  reviewVolunteerAsync,
} from "./team.ts";

export type AsyncWriteMethods = Pick<
  ServiceApi,
  | "testEmail"
  | "sendEmail"
  | "createApiToken"
  | "setSecret"
  | "removeSecret"
  | "revokeApiToken"
  | "authenticateToken"
  | "addComment"
  | "resolveComment"
  | "deleteComment"
  | "createGlossaryTerm"
  | "updateGlossaryTerm"
  | "deleteGlossaryTerm"
  | "addLanguage"
  | "updateLanguage"
  | "removeLanguage"
  | "updateSettings"
  | "updateFile"
  | "updateString"
  | "requestLanguage"
  | "reviewLanguageRequest"
  | "createInvite"
  | "revokeInvite"
  | "updateMember"
  | "removeMember"
  | "resolveSession"
  | "signOut"
  | "signIn"
  | "signUp"
  | "ensureSetupToken"
  | "completeSetup"
  | "ensureDevAccount"
  | "devSignIn"
  | "unlinkIdentity"
  | "updateAccount"
  | "deleteAccount"
  | "createEmailToken"
  | "createResetLink"
  | "verifyEmail"
  | "resetPassword"
  | "signInWithEmailLink"
  | "signInWithIdentity"
  | "requestVolunteer"
  | "reviewVolunteer"
  | "withdrawSuggestion"
  | "suggest"
  | "reviewSuggestions"
  | "saveTranslation"
  | "approveTranslation"
  | "unapproveTranslation"
  | "deleteTranslation"
  | "importTranslations"
  | "renameKey"
  | "restoreRows"
  | "beginRestore"
  | "finishRestore"
  | "recordBackup"
  | "cancelJob"
  | "createJob"
  | "suggestWithLlm"
>;

export function asyncWriteMethods(options: {
  emailFetch?: import("@quaso/core").Fetch;
  sql: Sql;
  clock?: Clock;
  logger?: Logger;
  defaultModel?: string;
  provider?: TranslationProvider | null;
  llmConfiguration?: () => Promise<LlmConfiguration>;
  afterLlmChange?: () => Promise<void>;
  models?: () => Promise<string[]>;
  secretKey?: string;
  passwordIterations?: number;
  dev?: boolean;
  afterRestore?: () => Promise<void>;
  monthlyTokenBudget?: number | null;
  afterCreateJob?: (job: { id: number }) => Promise<void>;
}): AsyncWriteMethods {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const model = options.defaultModel ?? FALLBACK_MODEL;
  const provider = options.provider ?? null;
  const configuration =
    options.llmConfiguration ??
    (async () => ({
      provider,
      concurrency: 4,
      monthlyTokenBudget: options.monthlyTokenBudget ?? null,
    }));
  const cachedModels = new ModelList(provider, clock, logger);
  const settingsModels = new SettingsModels(options.models ?? (() => cachedModels.list()));

  async function call<I, O>(
    caller: Actor,
    action: Action | null,
    schema: Schema<I>,
    input: unknown,
    run: (input: I, actor: Actor) => Promise<O>,
  ): Promise<O> {
    const actor = validateActor(caller);
    let request: I;
    try {
      request = validateInput(schema, input);
    } catch (error) {
      // Permission errors take precedence over malformed inputs.
      if (action !== null) (await readPermissions(options.sql, actor)).require(action);
      throw error;
    }
    return run(request, actor);
  }

  const { testEmail, sendEmail } = emailMethods(options.sql, {
    model,
    logger,
    fetch: options.emailFetch,
  });
  return {
    testEmail,
    sendEmail,
    setSecret: (caller, input) =>
      call(
        caller,
        "settings",
        SetSecretRequest.extend({ name: ManagedSecretName }),
        input,
        async ({ name, value }, actor) => {
          const status = await changeSecretAsync(options.sql, actor, name, value, clock());
          if (name === "gemini_api_key") await options.afterLlmChange?.();
          return status;
        },
      ),
    removeSecret: (caller, input) =>
      call(
        caller,
        "settings",
        s.object({ name: ManagedSecretName }),
        input,
        async ({ name }, actor) => {
          const status = await changeSecretAsync(options.sql, actor, name, null, clock());
          if (name === "gemini_api_key") await options.afterLlmChange?.();
          return status;
        },
      ),
    async createJob(caller, input) {
      const result = await call(
        caller,
        "translate",
        CreateJobRequest,
        input,
        async (request, actor) => {
          const config = await configuration();
          return createJobAsync(options.sql, actor, request, {
            llmAvailable: config.provider !== null,
            monthlyTokenBudget: config.monthlyTokenBudget,
            now: clock(),
            model,
            logger,
          });
        },
      );
      if (result.job?.status === "queued") await options.afterCreateJob?.(result.job);
      return result;
    },
    suggestWithLlm: (caller, input) =>
      call(
        caller,
        "edit",
        s.object({ id: Id, language: LanguageTag }),
        input,
        async (request, actor) => {
          const config = await configuration();
          return suggestWithLlm(options.sql, actor, request, {
            provider: config.provider,
            model,
            monthlyTokenBudget: config.monthlyTokenBudget,
            clock,
            logger,
            record: (entry) => recordRequestAsync(options.sql, SYSTEM, entry, clock()),
          });
        },
      ),
    cancelJob: (caller, input) =>
      call(caller, null, s.object({ id: Id }), input, ({ id }, actor) =>
        cancelJobAsync(options.sql, actor, id, clock(), logger),
      ),
    finishRestore: (caller, input) =>
      call(
        caller,
        null,
        s.object({ counts: s.record(s.integer({ min: 0 })) }),
        input,
        async (request, actor) => {
          const result = await finishRestoreAsync(options.sql, actor, request);
          logger.warn("Restored a backup", {
            schemaVersion: result.schemaVersion,
            revision: result.revision,
          });
          await options.afterRestore?.();
          return result;
        },
      ),
    recordBackup: (caller, input) =>
      call(
        caller,
        null,
        s.object({ at: s.integer({ min: 0 }), file: s.string({ maxLength: 1000 }).nullable() }),
        input,
        (request, actor) => recordBackupAsync(options.sql, actor, request),
      ),
    beginRestore: (caller, input) =>
      call(
        caller,
        null,
        s.object({
          format: s.string({ maxLength: 100 }),
          version: s.integer(),
          schemaVersion: s.integer({ min: 1 }),
        }),
        input,
        async (request, actor) => {
          const result = await beginRestoreAsync(options.sql, actor, request, clock());
          logger.warn("Restoring a backup", { schemaVersion: result.schemaVersion });
          return result;
        },
      ),
    restoreRows: (caller, input) =>
      call(
        caller,
        null,
        s.object({
          table: s.string({ minLength: 1, maxLength: 128 }),
          rows: s.array(s.record(s.unknown())),
        }),
        input,
        (request, actor) => restoreRowsAsync(options.sql, actor, request),
      ),
    renameKey: (caller, input) =>
      call(caller, "settings", RenameRequest, input, async (request, actor) => {
        const result = await renameKeyAsync(options.sql, actor, request, clock(), model);
        if (result.renamed.length > 0) logger.info("Key renamed", { ...result.renamed[0] });
        return result;
      }),
    importTranslations: (caller, input) =>
      call(caller, "upload", ImportRequest, input, (request, actor) =>
        importTranslationsAsync(options.sql, actor, request, clock(), model),
      ),
    saveTranslation: (caller, input) =>
      call(
        caller,
        "edit",
        SaveTranslationRequest.extend({ id: Id, language: LanguageTag }),
        input,
        (request, actor) =>
          editTranslationAsync(
            options.sql,
            actor,
            { action: "save", input: request },
            clock(),
            model,
          ),
      ),
    approveTranslation: (caller, input) =>
      call(
        caller,
        "edit",
        TranslationActionRequest.extend({ id: Id, language: LanguageTag }),
        input,
        (request, actor) =>
          editTranslationAsync(
            options.sql,
            actor,
            { action: "approve", input: request },
            clock(),
            model,
          ),
      ),
    unapproveTranslation: (caller, input) =>
      call(
        caller,
        "edit",
        TranslationActionRequest.extend({ id: Id, language: LanguageTag }),
        input,
        (request, actor) =>
          editTranslationAsync(
            options.sql,
            actor,
            { action: "unapprove", input: request },
            clock(),
            model,
          ),
      ),
    deleteTranslation: (caller, input) =>
      call(
        caller,
        "edit",
        TranslationActionRequest.extend({ id: Id, language: LanguageTag }),
        input,
        (request, actor) =>
          editTranslationAsync(
            options.sql,
            actor,
            { action: "delete", input: request },
            clock(),
            model,
          ),
      ),
    reviewSuggestions: (caller, input) =>
      call(caller, "review", ReviewRequest, input, async (request, actor) => {
        const result = await reviewSuggestionsAsync(options.sql, actor, request, clock(), model);
        logger.info("Review", {
          action: request.action,
          approved: result.approved.length,
          rejected: result.rejected.length,
          failed: result.failed.length,
        });
        return result;
      }),
    suggest: (caller, input) =>
      call(
        caller,
        "suggest",
        SuggestRequest.extend({ id: Id, language: LanguageTag }),
        input,
        (request, actor) => suggestAsync(options.sql, actor, request, clock(), model),
      ),
    withdrawSuggestion: (caller, input) =>
      call(caller, "account", s.object({ id: Id }), input, ({ id }, actor) =>
        withdrawSuggestionAsync(options.sql, actor, id, clock(), model),
      ),
    requestVolunteer: (caller, input) =>
      call(caller, "volunteer", VolunteerRequest, input, (request, actor) =>
        requestVolunteerAsync(options.sql, actor, request, clock(), logger),
      ),
    reviewVolunteer: (caller, input) =>
      call(
        caller,
        "team",
        ReviewVolunteerRequest.extend({ userId: Id }),
        input,
        ({ userId, ...review }, actor) =>
          reviewVolunteerAsync(options.sql, actor, userId, review, clock(), logger),
      ),
    signInWithIdentity: (caller, input) =>
      call(
        caller,
        null,
        s.object({
          provider: s.enum(["github", "discord"]),
          subject: s.string({ minLength: 1, maxLength: 200 }),
          username: s.string({ maxLength: 200 }).nullable().optional(),
          email: s.string({ maxLength: 254 }).nullable().optional(),
          emailVerified: s.boolean().optional(),
          displayName: s.string({ maxLength: 200 }).nullable().optional(),
          avatarUrl: s.string({ maxLength: 2000 }).nullable().optional(),
          linkToUserId: Id.optional(),
          linkSessionId: s.string({ minLength: 1, maxLength: 200 }).optional(),
          invite: s.string({ minLength: 1, maxLength: 200 }).optional(),
          userAgent: s.string({ maxLength: 1000 }).optional(),
        }),
        input,
        (request, actor) => signInWithIdentityAsync(options.sql, actor, request, clock),
      ),
    verifyEmail: (caller, input) =>
      call(
        caller,
        null,
        s.object({ token: s.string({ minLength: 1, maxLength: 200 }) }),
        input,
        ({ token }) => verifyEmailAsync(options.sql, token, clock),
      ),
    resetPassword: (caller, input) =>
      call(
        caller,
        null,
        ResetPasswordRequest.extend({
          token: s.string({ minLength: 1, maxLength: 200 }),
          userAgent: s.string({ maxLength: 1000 }).optional(),
        }),
        input,
        (request) => {
          return resetPasswordAsync(
            options.sql,
            request,
            { iterations: options.passwordIterations },
            clock,
            logger,
          );
        },
      ),
    signInWithEmailLink: (caller, input) =>
      call(
        caller,
        null,
        s.object({
          token: s.string({ minLength: 1, maxLength: 200 }),
          userAgent: s.string({ maxLength: 1000 }).optional(),
        }),
        input,
        ({ token, userAgent }) => signInWithEmailLinkAsync(options.sql, token, clock, userAgent),
      ),
    createEmailToken: (caller, input) =>
      call(
        caller,
        null,
        s.object({ email: Email, purpose: s.enum(["verify", "reset", "signin"]) }),
        input,
        ({ email, purpose }, actor) =>
          createEmailTokenAsync(options.sql, actor, email, purpose, clock),
      ),
    createResetLink: (caller, input) =>
      call(
        caller,
        "team",
        s.object({ userId: Id, baseUrl: s.string({ minLength: 1, maxLength: 500 }) }),
        input,
        ({ userId, baseUrl }, actor) =>
          createResetLinkAsync(options.sql, actor, userId, baseUrl, clock, logger),
      ),
    deleteAccount: (caller, input) =>
      call(caller, "account", DeleteAccountRequest, input, (request, actor) =>
        deleteAccountAsync(
          options.sql,
          actor,
          request,
          { iterations: options.passwordIterations },
          clock(),
          logger,
        ),
      ),
    updateAccount: (caller, input) =>
      call(
        caller,
        "account",
        UpdateAccountRequest.extend({
          sessionId: s.string({ minLength: 1, maxLength: 200 }).optional(),
        }),
        input,
        (request, actor) =>
          updateAccountAsync(options.sql, actor, request, {
            iterations: options.passwordIterations,
          }),
      ),
    unlinkIdentity: (caller, input) =>
      call(
        caller,
        "account",
        s.object({ provider: s.enum(["github", "discord"]) }),
        input,
        ({ provider }, actor) => unlinkIdentityAsync(options.sql, actor, provider),
      ),
    ensureDevAccount: (caller, input) =>
      call(caller, null, s.object({}), input, (_request, actor) =>
        ensureDevAccountAsync(options.sql, actor, options.dev ?? false, clock()),
      ),
    devSignIn: (caller, input) =>
      call(
        caller,
        null,
        s.object({ userAgent: s.string({ maxLength: 1000 }).optional() }),
        input,
        ({ userAgent }, actor) =>
          devSignInAsync(options.sql, actor, options.dev ?? false, clock(), userAgent),
      ),
    ensureSetupToken: (caller, input) =>
      call(
        caller,
        null,
        s.object({ token: s.string({ minLength: 1, maxLength: 200 }).optional() }),
        input,
        async ({ token }, actor) => ({
          token: await ensureSetupTokenAsync(options.sql, actor, token),
        }),
      ),
    completeSetup: (caller, input) =>
      call(
        caller,
        null,
        SetupRequest.extend({ userAgent: s.string({ maxLength: 1000 }).optional() }),
        input,
        (request) => {
          return setupAsync(
            options.sql,
            request,
            { iterations: options.passwordIterations },
            { model, clock, logger },
          );
        },
      ),
    signUp: (caller, input) =>
      call(
        caller,
        null,
        SignUpRequest.extend({ userAgent: s.string({ maxLength: 1000 }).optional() }),
        input,
        (request) => {
          return signUpAsync(
            options.sql,
            request,
            { iterations: options.passwordIterations },
            clock,
            logger,
          );
        },
      ),
    signIn: (caller, input) =>
      call(
        caller,
        null,
        SignInRequest.extend({ userAgent: s.string({ maxLength: 1000 }).optional() }),
        input,
        (request) => {
          return signInAsync(
            options.sql,
            request,
            { iterations: options.passwordIterations },
            clock,
            logger,
          );
        },
      ),
    resolveSession: (caller, input) =>
      call(
        caller,
        null,
        s.object({ sessionId: s.string({ minLength: 1, maxLength: 200 }) }),
        input,
        ({ sessionId }, actor) => resolveSessionAsync(options.sql, actor, sessionId, clock()),
      ),
    signOut: (caller, input) =>
      call(
        caller,
        null,
        s.object({ sessionId: s.string({ minLength: 1, maxLength: 200 }) }),
        input,
        ({ sessionId }) => deleteSessionAsync(options.sql, sessionId),
      ),
    updateMember: (caller, input) =>
      call(
        caller,
        "team",
        UpdateMemberRequest.extend({ id: Id }),
        input,
        ({ id, ...change }, actor) =>
          updateMemberAsync(options.sql, actor, id, change, clock(), logger),
      ),
    removeMember: (caller, input) =>
      call(caller, "team", s.object({ id: Id }), input, ({ id }, actor) =>
        removeMemberAsync(options.sql, actor, id, clock(), logger),
      ),
    createInvite: (caller, input) =>
      call(
        caller,
        "team",
        CreateInviteRequest.extend({ baseUrl: s.string({ minLength: 1, maxLength: 500 }) }),
        input,
        ({ baseUrl, ...request }, actor) =>
          createInviteAsync(options.sql, actor, request, baseUrl, clock()),
      ),
    revokeInvite: (caller, input) =>
      call(caller, "team", s.object({ id: Id }), input, ({ id }, actor) =>
        revokeInviteAsync(options.sql, actor, id, clock()),
      ),
    requestLanguage: (caller, input) =>
      call(caller, "requestLanguage", CreateLanguageRequestRequest, input, (request, actor) =>
        requestLanguageAsync(options.sql, actor, request, { model, now: clock(), logger }),
      ),
    reviewLanguageRequest: (caller, input) =>
      call(
        caller,
        "settings",
        ReviewLanguageRequestRequest.extend({ id: Id }),
        input,
        ({ id, ...request }, actor) =>
          reviewLanguageRequestAsync(options.sql, actor, id, request, {
            model,
            now: clock(),
            logger,
          }),
      ),
    updateFile: (caller, input) =>
      call(
        caller,
        "context",
        UpdateFileRequest.extend({ id: Id }),
        input,
        ({ id, ...request }, actor) => updateFileAsync(options.sql, actor, id, request, clock()),
      ),
    updateString: (caller, input) =>
      call(
        caller,
        "settings",
        UpdateStringRequest.extend({ id: Id }),
        input,
        ({ id, ...request }, actor) =>
          updateStringAsync(options.sql, actor, id, request, clock(), model),
      ),
    updateSettings: (caller, input) =>
      call(caller, "settings", UpdateSettingsRequest, input, async (request, actor) => {
        const saved = await updateSettingsAsync(
          options.sql,
          actor,
          request,
          { model, now: clock(), logger },
          { models: [], llmAvailable: (await configuration()).provider !== null },
        );
        await options.afterLlmChange?.();
        return { ...saved, models: await settingsModels.list() };
      }),
    addLanguage: (caller, input) =>
      call(caller, "settings", AddLanguageRequest, input, ({ tag }, actor) =>
        addProjectLanguageAsync(options.sql, actor, tag, { model, now: clock(), logger }),
      ),
    updateLanguage: (caller, input) =>
      call(
        caller,
        "settings",
        UpdateLanguageRequest.extend({ tag: LanguageTag }),
        input,
        ({ tag, ...request }, actor) =>
          updateProjectLanguageAsync(options.sql, actor, tag, request, {
            model,
            now: clock(),
            logger,
          }),
      ),
    removeLanguage: (caller, input) =>
      call(caller, "settings", s.object({ tag: LanguageTag }), input, ({ tag }, actor) =>
        removeProjectLanguageAsync(options.sql, actor, tag, { model, now: clock(), logger }),
      ),
    createGlossaryTerm: (caller, input) =>
      call(caller, "glossary", CreateGlossaryTermRequest, input, (request, actor) =>
        createGlossaryTermAsync(options.sql, actor, request, clock(), model),
      ),
    updateGlossaryTerm: (caller, input) =>
      call(
        caller,
        "glossary",
        UpdateGlossaryTermRequest.extend({ id: Id }),
        input,
        ({ id, ...request }, actor) =>
          updateGlossaryTermAsync(options.sql, actor, id, request, clock(), model),
      ),
    deleteGlossaryTerm: (caller, input) =>
      call(caller, "glossary", s.object({ id: Id }), input, ({ id }, actor) =>
        deleteGlossaryTermAsync(options.sql, actor, id, model),
      ),
    addComment: (caller, input) =>
      call(
        caller,
        "comment",
        CreateCommentRequest.extend({ stringId: Id }),
        input,
        ({ stringId, ...request }, actor) =>
          addCommentAsync(options.sql, actor, stringId, request, clock()),
      ),
    resolveComment: (caller, input) =>
      call(caller, null, s.object({ id: Id }), input, ({ id }, actor) =>
        resolveCommentAsync(options.sql, actor, id, clock()),
      ),
    deleteComment: (caller, input) =>
      call(caller, null, s.object({ id: Id }), input, ({ id }, actor) =>
        deleteCommentAsync(options.sql, actor, id, clock()),
      ),
    createApiToken: (caller, input) =>
      call(caller, "account", CreateApiTokenRequest, input, async (request, actor) => {
        const created = await createApiTokenAsync(options.sql, actor, request, clock());
        logger.info("API key created", { id: created.id, scope: created.scope });
        return created;
      }),
    revokeApiToken: (caller, input) =>
      call(caller, "account", s.object({ id: Id }), input, async ({ id }, actor) => {
        await revokeApiTokenAsync(options.sql, actor, id, clock());
        logger.info("API key revoked", { id });
        return { ok: true as const };
      }),
    authenticateToken: (caller, input) =>
      call(
        caller,
        null,
        s.object({ secret: s.string({ maxLength: 200 }) }),
        input,
        ({ secret }, actor) => authenticateTokenAsync(options.sql, actor, secret, clock()),
      ),
  };
}
