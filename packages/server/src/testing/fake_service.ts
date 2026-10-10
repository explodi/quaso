// SPDX-License-Identifier: MIT
/**
 * A small fake of the service for the server's unit tests: it records calls, returns
 * fixed answers, and knows API keys and their scopes. The integration tests use the real
 * service instead.
 */
import type {
  ActivityResult,
  ApiTokensResult,
  CreatedApiToken,
  ExportResult,
  FileVersionResult,
  FileVersionsResult,
  FilesResult,
  HistoryResult,
  ImportResult,
  ProjectInfo,
  StatusResult,
  StringDetail,
  StringsPage,
  TokenScope,
  UploadResult,
} from "@quaso/core";
import {
  type Actor,
  type AuthenticatedToken,
  forbidden,
  notFound,
  type ServiceApi,
  ServiceError,
  type ServiceHealth,
  unauthorized,
} from "@quaso/service";

export interface FakeToken {
  id: number;
  name: string;
  scope: TokenScope;
  revoked: boolean;
}

/**
 * Anonymous callers may read; API keys by scope. Any API key may manage keys here (the
 * real service keeps that to administrators).
 */
export class FakeService implements ServiceApi {
  createQualityJob(): Promise<import("@quaso/core").QualityJobInfo> {
    return Promise.reject(new Error("Not stubbed"));
  }
  getQualityJob(): Promise<import("@quaso/core").QualityJobInfo> {
    return Promise.reject(new Error("Not stubbed"));
  }
  listQualityJobs(): Promise<{ jobs: import("@quaso/core").QualityJobInfo[] }> {
    return Promise.resolve({ jobs: [] });
  }
  async getFileVersions(
    actor: Actor,
    input: { file: string; language: string },
  ): Promise<FileVersionsResult> {
    this.#record("getFileVersions", actor, input);
    this.#require(actor, ["read", "upload"]);
    return { versions: [] };
  }
  async getFileVersion(
    actor: Actor,
    input: { file: string; id: number },
  ): Promise<FileVersionResult> {
    this.#record("getFileVersion", actor, input);
    this.#require(actor, ["read", "upload"]);
    throw notFound("File version");
  }
  async getPublishedFile(
    actor: Actor,
    input: { file: string; language: string },
  ): Promise<FileVersionResult> {
    this.#record("getPublishedFile", actor, input);
    throw notFound("Published file");
  }
  /** Every call, in order. */
  readonly calls: { method: keyof ServiceApi; actor: Actor; input: unknown }[] = [];
  readonly tokens = new Map<string, FakeToken>();
  healthy = true;
  busy = false;
  nextWakeUp: number | null = null;
  /** Thrown by `getProject`, to test error handling. */
  projectError: unknown = null;

  /** Adds an API key and returns its secret. */
  addToken(scope: TokenScope, name = "Test key"): { secret: string; id: number } {
    const id = this.tokens.size + 1;
    const secret = `qso_test${id}_${crypto.randomUUID()}`;
    this.tokens.set(secret, { id, name, scope, revoked: false });
    return { secret, id };
  }

  /** How many times a method was called. */
  count(method: keyof ServiceApi): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  #record(method: keyof ServiceApi, actor: Actor, input: unknown): void {
    this.calls.push({ method, actor, input });
  }

  /**
   * Requires an API key with one of the scopes, or any key without scopes (the system may
   * do anything).
   */
  #require(actor: Actor, scopes: TokenScope[] = []): void {
    if (actor.type === "system") return;
    if (actor.type !== "token") throw unauthorized();
    const token = [...this.tokens.values()].find((t) => t.id === actor.tokenId);
    if (!token || (scopes.length > 0 && !scopes.includes(token.scope))) throw forbidden();
  }

  getProject(actor: Actor, input: Record<string, never>): Promise<ProjectInfo> {
    this.#record("getProject", actor, input);
    if (this.projectError) return Promise.reject(this.projectError);
    return Promise.resolve({
      languageRequestsEnabled: false,
      name: "Demo",
      description: "",
      sourceLanguage: "en",
      sourceLanguageName: "English",
      logoUrl: null,
      links: [],
      syntax: { prefix: "{{", suffix: "}}" },
      languages: [],
      details: { strings: 0, words: 0, files: 0, members: 0, lastActivity: null },
      llmAvailable: false,
      referenceLanguages: [],
      revision: 1,
    });
  }

  listFiles(actor: Actor, input: { language?: string }): Promise<FilesResult> {
    this.#record("listFiles", actor, input);
    return Promise.resolve(
      input.language === undefined ? { files: [] } : { language: input.language, files: [] },
    );
  }

  listStrings(actor: Actor, input: { language: string }): Promise<StringsPage> {
    this.#record("listStrings", actor, input);
    return Promise.resolve({ language: input.language, strings: [], nextCursor: null, total: 0 });
  }

  getString(actor: Actor, input: { id: number; language: string }): Promise<StringDetail> {
    this.#record("getString", actor, input);
    return Promise.reject(notFound(`String ${input.id}`));
  }

  getHistory(actor: Actor, input: { id: number; language?: string }): Promise<HistoryResult> {
    this.#record("getHistory", actor, input);
    return Promise.resolve({ entries: [] });
  }

  getActivity(actor: Actor, input: { cursor?: string; limit?: number }): Promise<ActivityResult> {
    this.#record("getActivity", actor, input);
    return Promise.resolve({ items: [], nextCursor: null });
  }

  getStatus(actor: Actor, input: { language?: string }): Promise<StatusResult> {
    this.#record("getStatus", actor, input);
    return Promise.resolve({ revision: 1, sourceLanguage: "en", languages: [] });
  }

  upload(actor: Actor, input: unknown): Promise<UploadResult> {
    this.#record("upload", actor, input);
    this.#require(actor, ["upload"]);
    return Promise.resolve({
      dryRun: false,
      uploadId: 1,
      files: [],
      added: [],
      changed: [],
      removed: [],
      restored: [],
      renamed: [],
      renameSuggestions: [],
      hiddenFiles: [],
      languagesAdded: [],
      warnings: [],
      job: null,
      revision: 2,
    });
  }

  exportFiles(actor: Actor, input: unknown): Promise<ExportResult> {
    this.#record("exportFiles", actor, input);
    this.#require(actor, ["read", "upload"]);
    return Promise.resolve({ schemaVersion: 1, revision: 1, sourceLanguage: "en", files: [] });
  }

  importTranslations(actor: Actor, input: { language: string }): Promise<ImportResult> {
    this.#record("importTranslations", actor, input);
    this.#require(actor, ["upload"]);
    return Promise.resolve({
      dryRun: false,
      language: input.language,
      imported: 0,
      unchanged: 0,
      skippedIdentical: 0,
      skippedEmpty: 0,
      droppedForms: 0,
      skippedBlue: 0,
      refused: [],
      flagged: [],
      unknownKeys: [],
      unknownFiles: [],
    });
  }

  authenticateToken(actor: Actor, input: { secret: string }): Promise<AuthenticatedToken | null> {
    this.#record("authenticateToken", actor, { secret: "(hidden)" });
    const token = this.tokens.get(input.secret);
    if (!token || token.revoked) return Promise.resolve(null);
    return Promise.resolve({ tokenId: token.id, scope: token.scope, name: token.name });
  }

  listApiTokens(actor: Actor, input: Record<string, never>): Promise<ApiTokensResult> {
    this.#record("listApiTokens", actor, input);
    this.#require(actor);
    return Promise.resolve({ tokens: [] });
  }

  createApiToken(
    actor: Actor,
    input: { name: string; scope: TokenScope },
  ): Promise<CreatedApiToken> {
    this.#record("createApiToken", actor, input);
    this.#require(actor);
    const { secret, id } = this.addToken(input.scope, input.name);
    return Promise.resolve({
      id,
      name: input.name,
      scope: input.scope,
      prefix: secret.slice(0, 8),
      createdAt: 0,
      createdBy: null,
      lastUsedAt: null,
      revokedAt: null,
      secret,
    });
  }

  revokeApiToken(actor: Actor, input: { id: number }): Promise<{ ok: true }> {
    this.#record("revokeApiToken", actor, input);
    this.#require(actor);
    for (const token of this.tokens.values()) {
      if (token.id === input.id) token.revoked = true;
    }
    return Promise.resolve({ ok: true });
  }

  getHealth(actor: Actor, input: Record<string, never>): Promise<ServiceHealth> {
    this.#record("getHealth", actor, input);
    if (!this.healthy) return Promise.reject(new Error("database is gone"));
    return Promise.resolve({
      ok: true,
      schemaVersion: 1,
      revision: 7,
      busy: this.busy,
      nextWakeUp: this.nextWakeUp,
    });
  }

  // The administrators' methods: the server's tests use the real service for them.
  getSettings = notFaked("getSettings");
  testLlm = notFaked("testLlm");
  testEmail = notFaked("testEmail");
  sendEmail = notFaked("sendEmail");
  async emailStatus() {
    return { available: false };
  }
  listSecrets = notFaked("listSecrets");
  setSecret = notFaked("setSecret");
  removeSecret = notFaked("removeSecret");
  updateSettings = notFaked("updateSettings");
  addLanguage = notFaked("addLanguage");
  updateLanguage = notFaked("updateLanguage");
  removeLanguage = notFaked("removeLanguage");
  updateFile = notFaked("updateFile");
  updateString = notFaked("updateString");
  renameKey = notFaked("renameKey");
  backupInfo = notFaked("backupInfo");
  backupTables = notFaked("backupTables");
  beginRestore = notFaked("beginRestore");
  restoreRows = notFaked("restoreRows");
  finishRestore = notFaked("finishRestore");
  recordBackup = notFaked("recordBackup");
  checkRestoreToken = notFaked("checkRestoreToken");
  getAdminInfo = notFaked("getAdminInfo");

  listGlossary = notFaked("listGlossary");
  createGlossaryTerm = notFaked("createGlossaryTerm");
  updateGlossaryTerm = notFaked("updateGlossaryTerm");
  deleteGlossaryTerm = notFaked("deleteGlossaryTerm");
  listComments = notFaked("listComments");
  addComment = notFaked("addComment");
  resolveComment = notFaked("resolveComment");
  deleteComment = notFaked("deleteComment");
  listLanguageRequests = notFaked("listLanguageRequests");
  requestLanguage = notFaked("requestLanguage");
  reviewLanguageRequest = notFaked("reviewLanguageRequest");

  // LLM jobs (Sprint 5): the server's tests use the real service for them.
  createJob = notFaked("createJob");
  getJob = notFaked("getJob");
  listJobs = notFaked("listJobs");
  getStringsQueue = notFaked("getStringsQueue");
  cancelJob = notFaked("cancelJob");
  suggestWithLlm = notFaked("suggestWithLlm");
  getUsage = notFaked("getUsage");
  listModels = notFaked("listModels");

  // People (Sprint 6): no one is signed in; the server's tests use the real service for the rest.
  getSession(actor: Actor, input: Record<string, never>) {
    this.#record("getSession", actor, input);
    return Promise.resolve({ user: null, setupRequired: false });
  }
  resolveSession(actor: Actor, _input: { sessionId: string }) {
    this.#record("resolveSession", actor, { sessionId: "(hidden)" });
    return Promise.resolve(null);
  }
  signUp = notFaked("signUp");
  signIn = notFaked("signIn");
  signOut = notFaked("signOut");
  ensureSetupToken = notFaked("ensureSetupToken");
  validateSetupToken = notFaked("validateSetupToken");
  completeSetup = notFaked("completeSetup");
  ensureDevAccount = notFaked("ensureDevAccount");
  devSignIn = notFaked("devSignIn");
  signInWithIdentity = notFaked("signInWithIdentity");
  unlinkIdentity = notFaked("unlinkIdentity");
  createEmailToken = notFaked("createEmailToken");
  verifyEmail = notFaked("verifyEmail");
  resetPassword = notFaked("resetPassword");
  signInWithEmailLink = notFaked("signInWithEmailLink");
  createResetLink = notFaked("createResetLink");
  getAccount = notFaked("getAccount");
  updateAccount = notFaked("updateAccount");
  deleteAccount = notFaked("deleteAccount");
  requestVolunteer = notFaked("requestVolunteer");
  listVolunteerRequests = notFaked("listVolunteerRequests");
  reviewVolunteer = notFaked("reviewVolunteer");
  listMembers = notFaked("listMembers");
  updateMember = notFaked("updateMember");
  removeMember = notFaked("removeMember");
  createInvite = notFaked("createInvite");
  listInvites = notFaked("listInvites");
  revokeInvite = notFaked("revokeInvite");
  checkInvite = notFaked("checkInvite");
  suggest = notFaked("suggest");
  withdrawSuggestion = notFaked("withdrawSuggestion");
  listSuggestions = notFaked("listSuggestions");
  reviewSuggestions = notFaked("reviewSuggestions");
  saveTranslation = notFaked("saveTranslation");
  approveTranslation = notFaked("approveTranslation");
  unapproveTranslation = notFaked("unapproveTranslation");
  deleteTranslation = notFaked("deleteTranslation");
}

/** A method the fake doesn't imitate: it fails with `unavailable`. */
function notFaked<M extends keyof ServiceApi>(method: M): ServiceApi[M] {
  const fail = () =>
    Promise.reject(new ServiceError("unavailable", `The fake service has no ${method}.`));
  return fail as unknown as ServiceApi[M];
}
