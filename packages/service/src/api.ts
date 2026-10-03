// SPDX-License-Identifier: MIT
/**
 * The service's interface (design §3, §5.11). One interface describes the direct call with
 * local storage and the internal HTTP API with Cloudflare storage: every method takes the
 * actor and one JSON input, and returns a promise of JSON.
 *
 * The server authenticates people and API keys, then passes the actor along. The service
 * still decides what the actor may do, next to the data (design §4).
 */
import type {
  ActivityResult,
  ApiTokensResult,
  CreateApiTokenRequest,
  CreatedApiToken,
  ExportQuery,
  ExportResult,
  FilesResult,
  FileVersionResult,
  FileVersionsResult,
  HistoryResult,
  ImportRequest,
  ImportResult,
  ProjectInfo,
  StatusResult,
  StringDetail,
  StringsPage,
  StringsQuery,
  StringsQueue,
  StringsQueueQuery,
  TokenScope,
  UploadRequest,
  UploadResult,
} from "@quaso/core";
import type {
  AddLanguageRequest,
  AddLanguageResult,
  AdminInfo,
  FileSettings,
  LanguageSettings,
  RenameRequest,
  RenameResult,
  RestoreResult,
  SettingsResult,
  ManagedSecretName,
  SetSecretRequest,
  SecretStatus,
  SecretsResult,
  LlmTestResult,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateStringRequest,
  UpdateStringResult,
} from "@quaso/core";
import type { BackupChunk, BackupInfo, BeginRestoreInput, BeginRestoreResult } from "./backup.ts";
import type { LaterApi } from "./later_api.ts";
import type { AccountsApi } from "./accounts_api.ts";
import type { LlmMethods } from "./jobs/llm_service.ts";

/** Who is calling. */
export type Actor =
  /** A visitor who isn't signed in. */
  | { type: "anonymous" }
  /** A signed-in person, authenticated by the server. */
  | { type: "user"; userId: number }
  /** An API key, authenticated by the server with `authenticateToken`. */
  | { type: "token"; tokenId: number }
  /** The server itself: setup, the development seed, maintenance. May do anything. */
  | { type: "system" };

export const ANONYMOUS: Actor = { type: "anonymous" };
export const SYSTEM: Actor = { type: "system" };

/** An API key, as `authenticateToken` finds it. */
export interface AuthenticatedToken {
  tokenId: number;
  scope: TokenScope;
  name: string;
}

/** The service's health, for `/healthz` and the admin page. */
export interface ServiceHealth {
  ok: true;
  schemaVersion: number;
  revision: number;
  busy: boolean;
  nextWakeUp: number | null;
}

/**
 * Every operation of the service. Later sprints add accounts, review, LLM jobs and
 * settings (see the sprint plan). The methods for people (sign-in, accounts, the team,
 * suggestions, review and direct edits) are in `AccountsApi` (`accounts_api.ts`).
 * The LLM jobs, usage and models are in `LlmMethods` (`jobs/llm_service.ts`).
 */
export interface ServiceApi extends AccountsApi, LlmMethods, LaterApi, LaterApi {
  // --- Public reads (WEB-1): anyone may call them.
  getProject(actor: Actor, input: Record<string, never>): Promise<ProjectInfo>;
  listFiles(actor: Actor, input: { language?: string }): Promise<FilesResult>;
  listStrings(actor: Actor, input: StringsQuery): Promise<StringsPage>;
  getStringsQueue(actor: Actor, input: StringsQueueQuery): Promise<StringsQueue>;
  getString(actor: Actor, input: { id: number; language: string }): Promise<StringDetail>;
  getHistory(actor: Actor, input: { id: number; language?: string }): Promise<HistoryResult>;
  getActivity(actor: Actor, input: { cursor?: string; limit?: number }): Promise<ActivityResult>;
  getStatus(actor: Actor, input: { language?: string }): Promise<StatusResult>;

  // --- The CLI (API keys; administrators too).
  /** `upload` scope. */
  upload(actor: Actor, input: UploadRequest): Promise<UploadResult>;
  /** `read` scope. */
  exportFiles(actor: Actor, input: ExportQuery): Promise<ExportResult>;
  getFileVersions(
    actor: Actor,
    input: { file: string; language: string },
  ): Promise<FileVersionsResult>;
  getFileVersion(actor: Actor, input: { file: string; id: number }): Promise<FileVersionResult>;
  getPublishedFile(
    actor: Actor,
    input: { file: string; language: string },
  ): Promise<FileVersionResult>;
  /** `upload` scope. */
  importTranslations(actor: Actor, input: ImportRequest): Promise<ImportResult>;

  // --- API keys (OPS-3).
  /** System only: finds the key for a secret, and records when it was last used. */
  authenticateToken(actor: Actor, input: { secret: string }): Promise<AuthenticatedToken | null>;
  /** Administrators. */
  listApiTokens(actor: Actor, input: Record<string, never>): Promise<ApiTokensResult>;
  /** Administrators, and the system (the development key and the `token create` command). */
  createApiToken(actor: Actor, input: CreateApiTokenRequest): Promise<CreatedApiToken>;
  /** Administrators. */
  revokeApiToken(actor: Actor, input: { id: number }): Promise<{ ok: true }>;

  // --- Administrators: settings, languages, files, strings and renames (S8.4, S8.5, S10.1).
  /** Administrators. */
  getSettings(actor: Actor, input: Record<string, never>): Promise<SettingsResult>;
  listSecrets(actor: Actor, input: Record<string, never>): Promise<SecretsResult>;
  testLlm(actor: Actor, input: Record<string, never>): Promise<LlmTestResult>;
  testEmail(
    actor: Actor,
    input: import("@quaso/core").TestEmailRequest,
  ): Promise<import("@quaso/core").EmailTestResult>;
  emailStatus(actor: Actor, input: Record<string, never>): Promise<{ available: boolean }>;
  sendEmail(actor: Actor, input: import("./email_sender.ts").EmailMessage): Promise<{ ok: true }>;
  setSecret(
    actor: Actor,
    input: SetSecretRequest & { name: ManagedSecretName },
  ): Promise<SecretStatus>;
  removeSecret(actor: Actor, input: { name: ManagedSecretName }): Promise<SecretStatus>;
  /** Administrators: `llm` and `llm.context` merge; the rest replaces. */
  updateSettings(actor: Actor, input: UpdateSettingsRequest): Promise<SettingsResult>;
  /** Administrators. */
  addLanguage(actor: Actor, input: AddLanguageRequest): Promise<AddLanguageResult>;
  /** Administrators. */
  updateLanguage(
    actor: Actor,
    input: UpdateLanguageRequest & { tag: string },
  ): Promise<LanguageSettings>;
  /** Administrators: translations and history stay, and come back with the language. */
  removeLanguage(actor: Actor, input: { tag: string }): Promise<{ ok: true }>;
  /** Managers and administrators: the file's context for the LLM. */
  updateFile(actor: Actor, input: { id: number; context?: string }): Promise<FileSettings>;
  /** Administrators: the description and a length limit not set by the CLI config. */
  updateString(
    actor: Actor,
    input: UpdateStringRequest & { id: number },
  ): Promise<UpdateStringResult>;
  /** Administrators: `quaso upload --rename`, on the website. */
  renameKey(actor: Actor, input: RenameRequest): Promise<RenameResult>;

  // --- Backups and restore (S8.9, S9.1, S9.2) and the admin page (S9.10).
  /** Administrators: the tables a backup holds, with their row counts. */
  backupInfo(actor: Actor, input: Record<string, never>): Promise<BackupInfo>;
  /** Administrators: one table's rows after a cursor, for building a backup in chunks. */
  backupTables(
    actor: Actor,
    input: { table: string; after?: number; limit?: number; state?: string },
  ): Promise<BackupChunk>;
  /** System only: starts restoring a backup into this empty instance (its data goes). */
  beginRestore(actor: Actor, input: BeginRestoreInput): Promise<BeginRestoreResult>;
  /** System only: one chunk of a table's rows. */
  restoreRows(
    actor: Actor,
    input: { table: string; rows: Record<string, unknown>[] },
  ): Promise<{ inserted: number; skipped: number }>;
  /** System only: checks the counts, migrates, and ends the restore. */
  finishRestore(actor: Actor, input: { counts: Record<string, number> }): Promise<RestoreResult>;
  /**
   * System only: whether a token is the setup token kept by a restore that didn't finish,
   * so `POST /restore` can start it again (`validateSetupToken` covers the first try).
   */
  checkRestoreToken(actor: Actor, input: { token: string }): Promise<{ ok: boolean }>;
  /** System only: records the last backup (scheduled snapshots, the nightly R2 file). */
  recordBackup(actor: Actor, input: { at: number; file: string | null }): Promise<{ ok: true }>;
  /** Administrators: the admin page, without the server's recent errors. */
  getAdminInfo(actor: Actor, input: Record<string, never>): Promise<AdminInfo>;

  // --- Operations.
  getHealth(actor: Actor, input: Record<string, never>): Promise<ServiceHealth>;
}

/** The names of the service's methods, for the internal HTTP API's allowlist. */
export type ServiceMethod = keyof ServiceApi;
