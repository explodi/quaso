// SPDX-License-Identifier: MIT
/**
 * The service (design §3): the project's logic and data behind the ports. `createService`
 * builds it; the host (the Bun server, or the Durable Object) calls `start()` once, then
 * the `ServiceApi` methods, and `alarm()` when the scheduler fires.
 */
import {
  CreateApiTokenRequest,
  ExportQuery,
  FileVersionQuery,
  FileVersionsQuery,
  Id,
  ImportRequest,
  LanguageTag,
  s,
  type Schema,
  StringsQuery,
  StringsQueueQuery,
  UploadRequest,
} from "@quaso/core";
import { laterMethods } from "./later_methods.ts";
import { accountsMethods } from "./accounts_methods.ts";
import { adminMethods } from "./admin_service.ts";
import { unfinishedRestore } from "./backup.ts";
import type { Actor, ServiceApi } from "./api.ts";
import { type Context, FALLBACK_MODEL } from "./context.ts";
import { getRevision, transaction } from "./db.ts";
import { forbidden } from "./errors.ts";
import { exportFiles } from "./export.ts";
import {
  exportPublishedFiles,
  getFileVersion,
  getFileVersions,
  getPublishedFile,
} from "./file_reads.ts";
import { getActivity, getHistory } from "./history.ts";
import { importTranslations } from "./imports.ts";
import { migrate, schemaVersion } from "./migrate.ts";
import { type Action, requirePermission } from "./permissions.ts";
import {
  type Clock,
  type Logger,
  type Scheduler,
  silentLogger,
  type SyncSql,
  type Sql,
  type Store,
} from "./ports.ts";
import { getProject } from "./project.ts";
import { defaultSettings, hasSettings, saveSettings } from "./settings.ts";
import { getStatus, listFiles } from "./status.ts";
import { getString, getStringsQueue, listStrings } from "./strings.ts";
import { authenticateToken, createApiToken, listApiTokens, revokeApiToken } from "./tokens.ts";
import { upload } from "./upload.ts";
import { validateActor, validateInput } from "./validation.ts";
import { nextWakeUp } from "./wakeups.ts";
import { createLlm } from "./jobs/llm_service.ts";
import type { TranslationProvider } from "./llm/provider.ts";
import { emailMethods } from "./email_configuration.ts";

export interface ServiceOptions {
  sql: SyncSql;
  scheduler: Scheduler;
  store?: Store;
  /** The server signing key; passwords use independent per-user salts. */
  secretKey?: string;
  clock?: Clock;
  logger?: Logger;
  /** Quaso's version, for the admin page. */
  version?: string;
  /** Where the service runs, for the admin page. */
  setup?: "local" | "cloudflare";
  /** A development instance (`bun run dev`): the developer account and its sign-in. */
  dev?: boolean;
  /** PBKDF2 iterations for new password hashes. Default: 210,000 (`DEFAULT_ITERATIONS`). */
  passwordIterations?: number;
  /** Internal default model override for tests and development tools. */
  defaultModel?: string;
  /**
   * Internal provider override for tests. Otherwise, use the stored Gemini key.
   */
  provider?: TranslationProvider | null;
  providerFactory?: (apiKey: string) => TranslationProvider;
  emailFetch?: import("@quaso/core").Fetch;
  /** Internal concurrency override; normally read from stored settings. */
  llmConcurrency?: number;
  /** Internal budget override; normally read from stored settings. */
  monthlyTokenBudget?: number | null;
  /**
   * Called before migrating an existing database to a newer schema, so the host can take a
   * snapshot first (design §5.3). Not called for a new, empty database.
   */
  beforeMigrate?: (from: number, to: number) => void | Promise<void>;
  /**
   * The database's size in bytes, for the admin page, when the host knows it better than
   * SQLite's page counts (a Durable Object: `ctx.storage.sql.databaseSize`).
   */
  databaseSize?: () => number | null;
}

/** What `start()` found. */
export interface StartResult {
  /** The schema version before and after migrating. */
  schemaVersion: { from: number; to: number };
  /** Whether the database was empty (a new instance). */
  created: boolean;
}

export interface Service extends ServiceApi {
  /**
   * Migrates the database if needed (calling `beforeMigrate` first), creates the default
   * settings on a new instance, and re-arms the scheduler from the stored next wake-up
   * (see `wakeups.ts`). Call it once, before anything else.
   */
  start(): Promise<StartResult>;
  /**
   * Runs due work (LLM jobs, from Sprint 5). The host calls it when the scheduler fires, and
   * calls it again later if it fails: the stored wake-up is cleared only after the work ran.
   */
  alarm(): Promise<void>;
}

/** Inputs without a schema of their own in core. */
const Empty = s.object({});
const OptionalLanguageInput = s.object({ language: LanguageTag.optional() });
const StringInput = s.object({ id: Id, language: LanguageTag });
const HistoryInput = s.object({ id: Id, language: LanguageTag.optional() });
const ActivityInput = s.object({
  cursor: s.string({ maxLength: 20 }).optional(),
  limit: s.integer({ min: 1, max: 200 }).optional(),
});
const SecretInput = s.object({ secret: s.string({ maxLength: 200 }) });
const IdInput = s.object({ id: Id });

/** Builds the service. */
export function createService(options: ServiceOptions): Service {
  const ctx: Context = {
    sql: options.sql,
    clock: options.clock ?? Date.now,
    logger: options.logger ?? silentLogger,
    defaultModel: options.defaultModel ?? FALLBACK_MODEL,
  };
  const llm = createLlm(ctx, {
    provider: options.provider,
    providerFactory: options.providerFactory,
    dev: options.dev,
    scheduler: options.scheduler,
    concurrency: options.llmConcurrency,
    monthlyTokenBudget: options.monthlyTokenBudget,
  });
  const publishedSql = (actor: Actor, action: Action): Pick<Sql, "read"> => ({
    async read(statements) {
      return ctx.sql.transaction(() => {
        requirePermission(ctx, actor, action);
        return statements.map((statement) =>
          ctx.sql.query(statement.sql, ...(statement.params ?? [])),
        );
      });
    },
  });

  /**
   * Checks the actor, the permission and the input, then runs `fn` in one transaction.
   * Methods are async for the transport, but do their database work synchronously.
   */
  function call<I, O>(
    caller: Actor,
    action: Action | null,
    schema: Schema<I>,
    input: unknown,
    fn: (input: I, actor: Actor) => O,
  ): Promise<Awaited<O>> {
    try {
      const actor: Actor = validateActor(caller);
      return Promise.resolve(
        transaction(ctx.sql, () => {
          if (action !== null) requirePermission(ctx, actor, action);
          return fn(validateInput(schema, input), actor);
        }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return {
    async start() {
      const migrated = await migrate(ctx.sql, { beforeMigrate: options.beforeMigrate });
      transaction(ctx.sql, () => {
        if (!hasSettings(ctx)) saveSettings(ctx, defaultSettings(ctx.defaultModel));
      });
      const next = nextWakeUp(ctx.sql);
      if (next !== null) await options.scheduler.schedule(next);
      await llm.start();
      ctx.logger.info("Service started", {
        schemaVersion: migrated.to,
        migratedFrom: migrated.from === migrated.to ? undefined : migrated.from,
        created: migrated.created,
      });
      return {
        schemaVersion: { from: migrated.from, to: migrated.to },
        created: migrated.created,
      };
    },

    // The due work: LLM jobs (`jobs/runner.ts`). If it throws, the wake-up stays stored, and
    // the host's scheduler tries again. Work that asks for another wake-up replaces the
    // stored one, which then stays. Not during a restore, or one that didn't finish and may
    // start again: its data may be incomplete (jobs would translate strings whose
    // translations aren't in yet); finishRestore starts the jobs.
    alarm: () =>
      transaction(ctx.sql, () => unfinishedRestore(ctx)?.resumable)
        ? Promise.resolve()
        : llm.alarm(),

    getProject: (actor, input) =>
      call(actor, "read", Empty, input, () => getProject(ctx, llm.available)),
    listFiles: (actor, input) =>
      call(actor, "read", OptionalLanguageInput, input, ({ language }) => listFiles(ctx, language)),
    listStrings: (actor, input) =>
      call(actor, "read", StringsQuery, input, (query) => listStrings(ctx, query)),
    getStringsQueue: (actor, input) =>
      call(actor, "read", StringsQueueQuery, input, (query) => getStringsQueue(ctx, query)),
    getString: (actor, input) =>
      call(actor, "read", StringInput, input, ({ id, language }) => getString(ctx, id, language)),
    getHistory: (actor, input) =>
      call(actor, "read", HistoryInput, input, ({ id, language }) => getHistory(ctx, id, language)),
    getActivity: (actor, input) =>
      call(actor, "read", ActivityInput, input, ({ cursor, limit }) =>
        getActivity(ctx, cursor, limit),
      ),
    getStatus: (actor, input) =>
      call(actor, "download", OptionalLanguageInput, input, ({ language }) =>
        getStatus(ctx, language),
      ),

    async upload(caller, input) {
      try {
        const actor: Actor = validateActor(caller);
        transaction(ctx.sql, () => requirePermission(ctx, actor, "upload"));
        const request = validateInput(UploadRequest, input);
        const result = upload(ctx, actor, request, llm.available);
        await llm.afterUpload(result.job);
        if (!result.dryRun && result.uploadId !== null) {
          ctx.logger.info("Upload", {
            uploadId: result.uploadId,
            added: result.added.length,
            changed: result.changed.length,
            removed: result.removed.length,
            restored: result.restored.length,
            revision: result.revision,
          });
        }
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    exportFiles: (actor, input) =>
      call(actor, "download", ExportQuery, input, (query, actor) =>
        query.at === undefined
          ? exportFiles(ctx, query)
          : exportPublishedFiles(
              publishedSql(actor, "download"),
              options.store,
              query,
              ctx.defaultModel,
            ),
      ),
    getFileVersions: (actor, input) =>
      call(actor, "download", FileVersionsQuery, input, (query, actor) =>
        getFileVersions(publishedSql(actor, "download"), query),
      ),
    getFileVersion: (actor, input) =>
      call(actor, "download", FileVersionQuery, input, (query, actor) =>
        getFileVersion(publishedSql(actor, "download"), options.store, query),
      ),
    getPublishedFile: (actor, input) =>
      call(actor, "read", FileVersionsQuery, input, (query, actor) =>
        getPublishedFile(publishedSql(actor, "read"), options.store, query),
      ),
    importTranslations: (caller, input) =>
      call(caller, "upload", ImportRequest, input, (request, actor) =>
        importTranslations(ctx, actor, request),
      ),

    authenticateToken: (caller, input) =>
      call(caller, null, SecretInput, input, ({ secret }, actor) => {
        if (actor.type !== "system") throw forbidden();
        return authenticateToken(ctx, secret);
      }),
    listApiTokens: (actor, input) => call(actor, "tokens", Empty, input, () => listApiTokens(ctx)),
    createApiToken: (caller, input) =>
      call(caller, "tokens", CreateApiTokenRequest, input, (request, actor) => {
        const created = createApiToken(ctx, actor, request);
        ctx.logger.info("API key created", { id: created.id, scope: created.scope });
        return created;
      }),
    revokeApiToken: (actor, input) =>
      call(actor, "tokens", IdInput, input, ({ id }) => {
        revokeApiToken(ctx, id);
        ctx.logger.info("API key revoked", { id });
        return { ok: true as const };
      }),

    getHealth: (actor, input) =>
      call(actor, null, Empty, input, () => ({
        ok: true as const,
        schemaVersion: schemaVersion(ctx.sql),
        revision: getRevision(ctx.sql),
        busy: llm.busy,
        nextWakeUp: nextWakeUp(ctx.sql),
      })),

    // People: sign-in, accounts, the team, suggestions, review and direct edits (Sprint 6).
    ...accountsMethods(ctx, call, {
      dev: options.dev ?? false,
      passwordIterations: options.passwordIterations,
    }),

    // Settings, languages, files, strings, renames, backups and the admin page.
    ...adminMethods(
      ctx,
      {
        scheduler: options.scheduler,
        version: options.version,
        setup: options.setup,
        databaseSize: options.databaseSize,
        provider: options.provider,
        models: llm.models,
        testLlm: llm.test,
        llmConfiguration: llm.configuration,
        afterLlmChange: llm.start,
        // Restored jobs go on, as after a restart.
        afterRestore: () => llm.start(),
      },
      call,
    ),

    // LLM jobs, usage and models (Sprint 5).
    ...llm.methods(call),
    ...laterMethods(ctx, call),
    ...emailMethods(
      {
        read: async (statements) =>
          ctx.sql.transaction(() =>
            statements.map((statement) =>
              ctx.sql.query(statement.sql, ...(statement.params ?? [])),
            ),
          ),
      },
      { model: ctx.defaultModel, logger: ctx.logger, fetch: options.emailFetch },
    ),
  };
}
