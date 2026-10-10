// SPDX-License-Identifier: MIT
/**
 * @module
 * The service: the project's logic and data, behind the ports (design §3). The same code
 * runs in the Deno server with local storage and in a Cloudflare Durable Object.
 *
 * The `node:sqlite` adapter has its own entry point (`@quaso/service/node-sqlite`), and so
 * do the `SyncSql` port's shared test cases (`@quaso/service/sql-cases`).
 */
export * from "./src/ports.ts";
export * from "./src/api.ts";
export * from "./src/errors.ts";
export * from "./src/service.ts";
export * from "./src/service_async.ts";
export { DATABASE_VERSION, MIGRATIONS } from "./src/migrations.ts";
export { TimerScheduler } from "./src/adapters/timer_scheduler.ts";
export { DEFAULT_PROMPT_TEMPLATE, defaultSettings } from "./src/settings.ts";
export { TOKEN_PREFIX } from "./src/tokens.ts";
export { createApiTokenAsync, revokeApiTokenAsync, authenticateTokenAsync } from "./src/tokens.ts";
export {
  BACKUP_CHANGED,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupJsonStream,
  requireBackupGeneration,
  checkBackupHeader,
  documentSource,
  fromBase64,
  restoreBackup,
  SECRET_TABLES,
  sqlBackupReader,
  sqlAsyncBackupReader,
  backupInfoAsync,
  backupTablesAsync,
  restoreTokenValidAsync,
  toBase64,
  toJsonValue,
  withBackupRetries,
} from "./src/backup.ts";
export type {
  BackupChunk,
  BackupInfo,
  BackupReader,
  BackupSource,
  BackupTablesInput,
  BeginRestoreInput,
  BeginRestoreResult,
  RestoreTarget,
} from "./src/backup.ts";
export { createGeminiProvider, type GeminiOptions } from "./src/llm/gemini.ts";
export { createFakeTranslator, FAKE_MODEL } from "./src/llm/fake.ts";
export {
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type TranslationProvider,
} from "./src/llm/provider.ts";
export { LLM_UNAVAILABLE } from "./src/jobs/jobs.ts";

export { withRetries, RevisionConflict, GUARD_STATEMENTS } from "./src/write.ts";

export { createD1Sql } from "./src/adapters/d1_sql.ts";
export { uploadAsync } from "./src/upload.ts";
export { StoreConflict } from "./src/store.ts";
export { createMemoryStore } from "./src/adapters/memory_store.ts";
export { createR2Store } from "./src/adapters/r2_store.ts";
export { migrateAsync, schemaVersionAsync } from "./src/migrate.ts";
export { getProjectAsync } from "./src/project.ts";
export { getStatusAsync, listFilesAsync } from "./src/status.ts";
export { getHistoryAsync, getActivityAsync } from "./src/history.ts";
export { listStringsAsync, getStringAsync } from "./src/strings.ts";
export { listGlossaryAsync } from "./src/glossary.ts";
export { exportFilesAsync } from "./src/export.ts";
export { listCommentsAsync } from "./src/comments.ts";
export { listLanguageRequestsAsync } from "./src/language_requests.ts";
export { listApiTokensAsync } from "./src/tokens.ts";
export { getAccountAsync, getSessionAsync } from "./src/users.ts";
export { getSettingsAsync } from "./src/settings_api.ts";
export * from "./src/stored_backups.ts";
export { createNightlyBackups, nextNightlyBackup } from "./src/nightly_backups.ts";
export { listSuggestionsAsync } from "./src/suggestions.ts";
export { getJobAsync, listJobsAsync } from "./src/jobs/jobs.ts";
export { getUsageAsync } from "./src/jobs/usage.ts";
export { getAdminInfoAsync } from "./src/admin.ts";
export { validateSetupTokenAsync } from "./src/accounts.ts";
export {
  listMembersAsync,
  listVolunteerRequestsAsync,
  listInvitesAsync,
  checkInviteAsync,
} from "./src/team.ts";
export {
  Permissions,
  readPermissions,
  permissionReadStatements,
  permissionsFromRows,
} from "./src/permissions.ts";
