// SPDX-License-Identifier: MIT
/** Validated async read methods, composed into the service alongside its write methods. */
import {
  CommentsQuery,
  ExportQuery,
  FileVersionQuery,
  FileVersionsQuery,
  GlossaryQuery,
  Id,
  JobsQuery,
  LanguageTag,
  s,
  type Schema,
  StringsQuery,
  StringsQueueQuery,
  SuggestionsQuery,
  UsageQuery,
} from "@quaso/core";
import { validateSetupTokenAsync } from "./accounts.ts";
import { getAdminInfoAsync, type AdminHost } from "./admin.ts";
import { listSecretsAsync } from "./secrets.ts";
import type { Actor, ServiceApi } from "./api.ts";
import {
  backupInfoAsync,
  backupTablesAsync,
  MAX_BACKUP_CHUNK,
  restoreTokenValidAsync,
} from "./backup.ts";
import { listCommentsAsync } from "./comments.ts";
import { FALLBACK_MODEL } from "./context.ts";
import { exportFilesAsync } from "./export.ts";
import {
  checkPublishedQuery,
  exportPublishedFiles,
  getFileVersion,
  getFileVersions,
  readPublishedFile,
} from "./file_reads.ts";
import { listGlossaryAsync } from "./glossary.ts";
import { getActivityAsync, getHistoryAsync } from "./history.ts";
import { getJobAsync, listJobsAsync } from "./jobs/jobs.ts";
import { ModelList, SettingsModels } from "./jobs/models.ts";
import { getUsageAsync } from "./jobs/usage.ts";
import { listLanguageRequestsAsync } from "./language_requests.ts";
import type { TranslationProvider } from "./llm/provider.ts";
import type { LlmConfiguration } from "./llm/configuration.ts";
import type { LlmTestResult } from "@quaso/core";
import { badRequest } from "./errors.ts";
import {
  type Action,
  permissionReadStatements,
  permissionsFromRows,
  readPermissions,
} from "./permissions.ts";
import { type Clock, type Logger, silentLogger, type Sql, type Store } from "./ports.ts";
import { getProjectAsync } from "./project.ts";
import { getSettingsAsync } from "./settings_api.ts";
import { getStatusAsync, listFilesAsync } from "./status.ts";
import { getStringAsync, getStringsQueueAsync, listStringsAsync } from "./strings.ts";
import { listSuggestionsAsync } from "./suggestions.ts";
import {
  checkInviteAsync,
  listInvitesAsync,
  listMembersAsync,
  listVolunteerRequestsAsync,
} from "./team.ts";
import { listApiTokensAsync } from "./tokens.ts";
import { getAccountAsync, getSessionAsync } from "./users.ts";
import { validateActor, validateInput } from "./validation.ts";
import { emailMethods } from "./email_configuration.ts";

export const ASYNC_READ_METHODS = [
  "getProject",
  "listFiles",
  "listStrings",
  "getStringsQueue",
  "getString",
  "getHistory",
  "getActivity",
  "getStatus",
  "exportFiles",
  "getFileVersions",
  "getFileVersion",
  "getPublishedFile",
  "listApiTokens",
  "getHealth",
  "getSettings",
  "listSecrets",
  "testLlm",
  "emailStatus",
  "backupInfo",
  "backupTables",
  "checkRestoreToken",
  "getAdminInfo",
  "getSession",
  "validateSetupToken",
  "getAccount",
  "listVolunteerRequests",
  "listMembers",
  "listInvites",
  "checkInvite",
  "listSuggestions",
  "getJob",
  "listJobs",
  "getUsage",
  "listModels",
  "listGlossary",
  "listComments",
  "listLanguageRequests",
] as const satisfies readonly (keyof ServiceApi)[];

export type AsyncReadMethods = Pick<ServiceApi, (typeof ASYNC_READ_METHODS)[number]>;

interface ReadOptions {
  emailFetch?: import("@quaso/core").Fetch;
  testLlm?: (sql: Sql) => Promise<LlmTestResult>;
  sql: Sql;
  store?: Store;
  clock?: Clock;
  logger?: Logger;
  defaultModel?: string;
  provider?: TranslationProvider | null;
  llmConfiguration?: () => Promise<LlmConfiguration>;
  models?: () => Promise<string[]>;
  monthlyTokenBudget?: number | null;
  version?: string;
  setup?: "local" | "cloudflare";
  databaseSize?: () => number | null;
  busy?: () => boolean;
  background?: { nextWakeUp(): number | null };
}

const Empty = s.object({});
const TokenInput = s.object({ token: s.string({ minLength: 1, maxLength: 200 }) });
const IdInput = s.object({ id: Id });
const OptionalLanguageInput = s.object({ language: LanguageTag.optional() });
const StringInput = s.object({ id: Id, language: LanguageTag });
const HistoryInput = s.object({ id: Id, language: LanguageTag.optional() });
const ActivityInput = s.object({
  cursor: s.string({ maxLength: 20 }).optional(),
  limit: s.integer({ min: 1, max: 200 }).optional(),
});
const BackupInput = s.object({
  table: s.string({ minLength: 1, maxLength: 128 }),
  after: s.integer({ min: 0 }).optional(),
  limit: s.integer({ min: 1, max: MAX_BACKUP_CHUNK }).optional(),
  state: s.string({ maxLength: 20_000 }).optional(),
});

export function asyncReadMethods(options: ReadOptions): AsyncReadMethods {
  const clock = options.clock ?? Date.now;
  const model = options.defaultModel ?? FALLBACK_MODEL;
  const provider = options.provider ?? null;
  const cached = new ModelList(provider, clock, options.logger ?? silentLogger);
  const models = options.models ?? (() => cached.list());
  const configuration =
    options.llmConfiguration ??
    (async () => ({
      provider,
      concurrency: 4,
      monthlyTokenBudget: options.monthlyTokenBudget ?? null,
    }));
  const host: AdminHost = {
    version: options.version ?? "unknown",
    setup: options.setup ?? "local",
    startedAt: clock(),
    provider: provider?.name ?? null,
    databaseSize: options.databaseSize,
  };

  async function call<I, O>(
    caller: Actor,
    action: Action | null,
    schema: Schema<I>,
    input: unknown,
    run: (sql: Sql, input: I, actor: Actor) => Promise<O>,
  ): Promise<O> {
    const actor = validateActor(caller);
    let request: I;
    try {
      request = validateInput(schema, input);
    } catch (error) {
      // Permission errors take precedence over malformed inputs, as on the write paths.
      if (action !== null) (await readPermissions(options.sql, actor)).require(action);
      throw error;
    }
    const sql: Sql =
      action === null
        ? options.sql
        : {
            ...options.sql,
            async read(statements) {
              const rows = await options.sql.read([
                ...statements,
                ...permissionReadStatements(actor),
              ]);
              permissionsFromRows(actor, rows.slice(statements.length)).require(action);
              return rows.slice(0, statements.length);
            },
          };
    return run(sql, request, actor);
  }

  const settingsModels = new SettingsModels(models);

  return {
    emailStatus: emailMethods(options.sql, {
      model,
      logger: options.logger ?? silentLogger,
      fetch: options.emailFetch,
    }).emailStatus,
    testLlm: (actor, input) =>
      call(actor, "settings", Empty, input, async (sql) => {
        await sql.read([]);
        try {
          if (!options.testLlm) throw badRequest("Gemini testing is not configured.");
          const result = await options.testLlm(sql);
          await sql.read([]);
          return result;
        } catch (error) {
          await sql.read([]);
          throw error;
        }
      }),
    getProject: (actor, input) =>
      call(actor, "read", Empty, input, async (sql) =>
        getProjectAsync(sql, model, (await configuration()).provider !== null),
      ),
    listFiles: (actor, input) =>
      call(actor, "read", OptionalLanguageInput, input, (sql, { language }) =>
        listFilesAsync(sql, model, language),
      ),
    listStrings: (actor, input) =>
      call(actor, "read", StringsQuery, input, (sql, query) => listStringsAsync(sql, query)),
    getStringsQueue: (actor, input) =>
      call(actor, "read", StringsQueueQuery, input, (sql, query) =>
        getStringsQueueAsync(sql, query),
      ),
    getString: (actor, input) =>
      call(actor, "read", StringInput, input, (sql, { id, language }) =>
        getStringAsync(sql, id, language, { model, clock }),
      ),
    getHistory: (actor, input) =>
      call(actor, "read", HistoryInput, input, (sql, { id, language }) =>
        getHistoryAsync(sql, id, language),
      ),
    getActivity: (actor, input) =>
      call(actor, "read", ActivityInput, input, (sql, { cursor, limit }) =>
        getActivityAsync(sql, cursor, limit),
      ),
    getStatus: (actor, input) =>
      call(actor, "download", OptionalLanguageInput, input, (sql, { language }) =>
        getStatusAsync(sql, model, language),
      ),
    exportFiles: (actor, input) =>
      call(actor, "download", ExportQuery, input, (sql, query) => {
        checkPublishedQuery(query);
        if (query.at === undefined) return exportFilesAsync(sql, query, model);
        return exportPublishedFiles(sql, options.store, query, model);
      }),
    getFileVersions: (actor, input) =>
      call(actor, "download", FileVersionsQuery, input, (sql, query) =>
        getFileVersions(sql, query),
      ),
    getFileVersion: (actor, input) =>
      call(actor, "download", FileVersionQuery, input, (sql, query) =>
        getFileVersion(sql, options.store, query),
      ),
    getPublishedFile: (actor, input) => readPublishedFile(options.sql, options.store, actor, input),
    listApiTokens: (actor, input) =>
      call(actor, null, Empty, input, (sql, _input, caller) => listApiTokensAsync(sql, caller)),
    getHealth: (actor, input) =>
      call(actor, null, Empty, input, async (sql) => {
        const [rows] = await sql.read([
          {
            sql: "SELECT key, value FROM meta WHERE key IN ('schema_version', 'revision', 'next_alarm')",
          },
        ]);
        const values = new Map(rows.map((row) => [row.key, row.value]));
        const scheduled = values.has("next_alarm") ? Number(values.get("next_alarm")) : null;
        const deadlines = [scheduled, options.background?.nextWakeUp() ?? null].filter(
          (at): at is number => at !== null,
        );
        return {
          ok: true as const,
          schemaVersion: Number(values.get("schema_version") ?? 0),
          revision: Number(values.get("revision") ?? 0),
          busy: options.busy?.() ?? false,
          nextWakeUp: deadlines.length === 0 ? null : Math.min(...deadlines),
        };
      }),
    getSettings: (actor, input) =>
      call(actor, "settings", Empty, input, async (sql, _input, caller) => {
        await sql.read([]);
        const list = await settingsModels.list();
        return getSettingsAsync(sql, caller, model, {
          models: list,
          llmAvailable: (await configuration()).provider !== null,
        });
      }),
    listSecrets: (actor, input) =>
      call(actor, "settings", Empty, input, (sql, _input, caller) => listSecretsAsync(sql, caller)),
    backupInfo: (actor, input) =>
      call(actor, "backup", Empty, input, (sql, _input, caller) =>
        backupInfoAsync(sql, caller, clock()),
      ),
    backupTables: (actor, input) =>
      call(actor, "backup", BackupInput, input, (sql, query, caller) =>
        backupTablesAsync(sql, caller, query),
      ),
    checkRestoreToken: (actor, input) =>
      call(
        actor,
        null,
        s.object({ token: s.string({ maxLength: 500 }) }),
        input,
        async (sql, { token }, caller) => ({
          ok: await restoreTokenValidAsync(sql, caller, token),
        }),
      ),
    getAdminInfo: (actor, input) =>
      call(actor, "settings", Empty, input, async (sql, _input, caller) =>
        getAdminInfoAsync(
          sql,
          caller,
          { ...host, provider: (await configuration()).provider?.name ?? null },
          model,
          clock(),
        ),
      ),
    getSession: (actor, input) =>
      call(actor, null, Empty, input, (sql, _input, caller) => getSessionAsync(sql, caller)),
    validateSetupToken: (actor, input) =>
      call(actor, null, TokenInput, input, async (sql, { token }) => ({
        ok: await validateSetupTokenAsync(sql, token),
      })),
    getAccount: (actor, input) =>
      call(actor, "account", Empty, input, (sql, _input, caller) => getAccountAsync(sql, caller)),
    listVolunteerRequests: (actor, input) =>
      call(actor, "team", Empty, input, (sql, _input, caller) =>
        listVolunteerRequestsAsync(sql, caller),
      ),
    listMembers: (actor, input) =>
      call(actor, "team", Empty, input, (sql, _input, caller) => listMembersAsync(sql, caller)),
    listInvites: (actor, input) =>
      call(actor, "team", Empty, input, (sql, _input, caller) => listInvitesAsync(sql, caller)),
    checkInvite: (actor, input) =>
      call(actor, null, TokenInput, input, (sql, { token }) =>
        checkInviteAsync(sql, token, clock()),
      ),
    listSuggestions: (actor, input) =>
      call(actor, "account", SuggestionsQuery, input, (sql, query, caller) =>
        listSuggestionsAsync(sql, caller, query, model),
      ),
    getJob: (actor, input) =>
      call(actor, "translate", IdInput, input, (sql, { id }, caller) =>
        getJobAsync(sql, caller, id),
      ),
    listJobs: (actor, input) =>
      call(actor, "translate", JobsQuery, input, (sql, query, caller) =>
        listJobsAsync(sql, caller, query),
      ),
    getUsage: (actor, input) =>
      call(actor, "usage", UsageQuery, input, async (sql, query, caller) =>
        getUsageAsync(sql, caller, query, (await configuration()).monthlyTokenBudget, clock()),
      ),
    listModels: (actor, input) =>
      call(actor, "translate", Empty, input, async (sql) => {
        await sql.read([]);
        return { models: await models() };
      }),
    listGlossary: (actor, input) =>
      call(actor, "read", GlossaryQuery, input, (sql, query) => listGlossaryAsync(sql, query)),
    listComments: (actor, input) =>
      call(
        actor,
        "read",
        CommentsQuery.extend({ stringId: Id.optional() }),
        input,
        (sql, query, caller) => listCommentsAsync(sql, caller, query),
      ),
    listLanguageRequests: (actor, input) =>
      call(actor, "read", Empty, input, (sql, _input, caller) =>
        listLanguageRequestsAsync(sql, caller),
      ),
  };
}
