// SPDX-License-Identifier: MIT
/**
 * The administrators' methods of the service (S8.4, S8.5, S8.9, S9.1, S9.2, S9.10,
 * S10.1): settings, languages, files, strings and renames, backups and restore, and the
 * admin page. `createService` adds them to the service; each checks the actor, the
 * permission and the input like every other method.
 */
import {
  AddLanguageRequest,
  ManagedSecretName,
  SetSecretRequest,
  type LlmTestResult,
  Id,
  LanguageTag,
  RenameRequest,
  s,
  type Schema,
  UpdateFileRequest,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateStringRequest,
} from "@quaso/core";
import { type AdminHost, getAdminInfo } from "./admin.ts";
import type { Actor, ServiceApi } from "./api.ts";
import {
  backupInfo,
  backupTables,
  beginRestore,
  finishRestore,
  MAX_BACKUP_CHUNK,
  recordBackup,
  restoreRows,
  restoreTokenValid,
} from "./backup.ts";
import type { Context } from "./context.ts";
import { transaction } from "./db.ts";
import { ModelList, SettingsModels } from "./jobs/models.ts";
import type { TranslationProvider } from "./llm/provider.ts";
import type { LlmConfiguration } from "./llm/configuration.ts";
import { forbidden, badRequest } from "./errors.ts";
import type { Action } from "./permissions.ts";
import type { Scheduler } from "./ports.ts";
import { renameKey } from "./rename.ts";
import {
  addProjectLanguage,
  getSettings,
  removeProjectLanguage,
  updateFile,
  updateProjectLanguage,
  updateSettings,
  updateString,
} from "./settings_api.ts";
import { validateInput } from "./validation.ts";
import { nextWakeUp } from "./wakeups.ts";
import { listSecrets, changeSecret } from "./secrets.ts";

/** The methods this module adds to the service. */
export type AdminMethods = Pick<
  ServiceApi,
  | "getSettings"
  | "listSecrets"
  | "testLlm"
  | "setSecret"
  | "removeSecret"
  | "updateSettings"
  | "addLanguage"
  | "updateLanguage"
  | "removeLanguage"
  | "updateFile"
  | "updateString"
  | "renameKey"
  | "backupInfo"
  | "backupTables"
  | "beginRestore"
  | "restoreRows"
  | "finishRestore"
  | "recordBackup"
  | "checkRestoreToken"
  | "getAdminInfo"
>;

/** `createService`'s `call`: checks the actor, the permission and the input, in a transaction. */
export type Call = <I, O>(
  caller: Actor,
  action: Action | null,
  schema: Schema<I>,
  input: unknown,
  fn: (input: I, actor: Actor) => O,
) => Promise<O>;

export interface AdminOptions {
  scheduler: Scheduler;
  version?: string;
  setup?: "local" | "cloudflare";
  databaseSize?: () => number | null;
  /** The LLM provider, when there is one. */
  provider?: TranslationProvider | null;
  llmConfiguration?: () => LlmConfiguration;
  afterLlmChange?: () => Promise<void>;
  testLlm?: () => Promise<LlmTestResult>;
  /** The provider's models, from the service's one cached list (`Llm.models`). */
  models?: () => Promise<string[]>;
  /** After a restore: what a start does for the restored data (the LLM jobs go on). */
  afterRestore?: () => Promise<void>;
}

export { SETTINGS_MODELS_WAIT_MS } from "./jobs/models.ts";

const Empty = s.object({});
const TagInput = s.object({ tag: LanguageTag });
const BackupTablesInput = s.object({
  table: s.string({ minLength: 1, maxLength: 128 }),
  after: s.integer({ min: 0 }).optional(),
  limit: s.integer({ min: 1, max: MAX_BACKUP_CHUNK }).optional(),
  state: s.string({ maxLength: 20_000 }).optional(),
});
const BeginRestoreInput = s.object({
  format: s.string({ maxLength: 100 }),
  version: s.integer(),
  schemaVersion: s.integer({ min: 1 }),
});
const RestoreRowsInput = s.object({
  table: s.string({ minLength: 1, maxLength: 128 }),
  rows: s.array(s.record(s.unknown())),
});
const FinishRestoreInput = s.object({
  counts: s.record(s.integer({ min: 0 })),
});
const RecordBackupInput = s.object({
  at: s.integer({ min: 0 }),
  file: s.string({ maxLength: 1000 }).nullable(),
});
const ActorInput = s.object({ type: s.string() }, { unknown: "strip" });

/** The administrators' methods, on the service's context and `call`. */
export function adminMethods(ctx: Context, options: AdminOptions, call: Call): AdminMethods {
  const startedAt = ctx.clock();
  const provider = options.provider ?? null;
  /** The provider's models, kept for ten minutes (the same list as `listModels`). */
  const models =
    options.models ??
    (() => {
      const list = new ModelList(provider, ctx.clock, ctx.logger);
      return () => list.list();
    })();

  function host(): AdminHost {
    return {
      version: options.version ?? "unknown",
      setup: options.setup ?? "local",
      startedAt,
      databaseSize: options.databaseSize,
      provider: (options.llmConfiguration?.().provider ?? provider)?.name ?? null,
    };
  }

  const extras = (list: string[]) => ({
    models: list,
    llmAvailable: (options.llmConfiguration?.().provider ?? provider) !== null,
  });

  const settingsModels = new SettingsModels(models);

  /** Refuses anyone but the system (the server), before an input is even read. */
  function systemOnly(caller: unknown): void {
    const actor = validateInput(ActorInput, caller);
    if (actor.type !== "system") {
      throw forbidden("Only the server may do that (quaso restore, or POST /restore at setup).");
    }
  }

  return {
    async testLlm(actor, input) {
      await call(actor, "settings", Empty, input, () => null);
      try {
        if (!options.testLlm) throw badRequest("Gemini testing is not configured.");
        const result = await options.testLlm();
        return await call(actor, "settings", Empty, input, () => result);
      } catch (error) {
        await call(actor, "settings", Empty, input, () => null);
        throw error;
      }
    },
    listSecrets: (actor, input) => call(actor, "settings", Empty, input, () => listSecrets(ctx)),
    setSecret: async (actor, input) => {
      const status = await call(
        actor,
        "settings",
        SetSecretRequest.extend({ name: ManagedSecretName }),
        input,
        ({ name, value }, caller) => changeSecret(ctx, caller, name, value),
      );
      if (status.name === "gemini_api_key") await options.afterLlmChange?.();
      return status;
    },
    removeSecret: async (actor, input) => {
      const status = await call(
        actor,
        "settings",
        s.object({ name: ManagedSecretName }),
        input,
        ({ name }, caller) => changeSecret(ctx, caller, name, null),
      );
      if (status.name === "gemini_api_key") await options.afterLlmChange?.();
      return status;
    },
    async getSettings(actor, input) {
      await call(actor, "settings", Empty, input, () => null);
      const list = await settingsModels.list();
      return await call(actor, "settings", Empty, input, () => getSettings(ctx, extras(list)));
    },
    async updateSettings(actor, input) {
      // Saved first: a change never waits for the provider.
      const saved = await call(
        actor,
        "settings",
        UpdateSettingsRequest,
        input,
        (request, caller) => {
          updateSettings(ctx, caller, request);
          return getSettings(ctx, extras([]));
        },
      );
      await options.afterLlmChange?.();
      return { ...saved, models: await settingsModels.list() };
    },
    addLanguage: (actor, input) =>
      call(actor, "settings", AddLanguageRequest, input, ({ tag }, caller) =>
        addProjectLanguage(ctx, caller, tag),
      ),
    updateLanguage: (actor, input) =>
      call(
        actor,
        "settings",
        UpdateLanguageRequest.extend({ tag: LanguageTag }),
        input,
        ({ tag, ...request }, caller) => updateProjectLanguage(ctx, caller, tag, request),
      ),
    removeLanguage: (actor, input) =>
      call(actor, "settings", TagInput, input, ({ tag }, caller) =>
        removeProjectLanguage(ctx, caller, tag),
      ),
    updateFile: (actor, input) =>
      call(actor, "context", UpdateFileRequest.extend({ id: Id }), input, ({ id, ...request }) =>
        updateFile(ctx, id, request),
      ),
    updateString: (actor, input) =>
      call(actor, "settings", UpdateStringRequest.extend({ id: Id }), input, ({ id, ...request }) =>
        updateString(ctx, id, request),
      ),
    renameKey: (actor, input) =>
      call(actor, "settings", RenameRequest, input, (request, caller) => {
        const result = renameKey(ctx, caller, request);
        if (result.renamed.length > 0) ctx.logger.info("Key renamed", { ...result.renamed[0] });
        return result;
      }),

    backupInfo: (actor, input) => call(actor, "backup", Empty, input, () => backupInfo(ctx)),
    backupTables: (actor, input) =>
      call(actor, "backup", BackupTablesInput, input, (request) => backupTables(ctx, request)),
    async beginRestore(actor, input) {
      systemOnly(actor);
      const request = validateInput(BeginRestoreInput, input);
      return await beginRestore(ctx, actor, request);
    },
    restoreRows: (actor, input) =>
      call(actor, null, RestoreRowsInput, input, (request, caller) => {
        systemOnly(caller);
        return restoreRows(ctx, caller, request);
      }),
    async finishRestore(actor, input) {
      systemOnly(actor);
      const request = validateInput(FinishRestoreInput, input);
      const result = await finishRestore(ctx, actor, request);
      const next = transaction(ctx.sql, () => nextWakeUp(ctx.sql));
      if (next !== null) await options.scheduler.schedule(next);
      await options.afterRestore?.();
      return result;
    },
    recordBackup: (actor, input) =>
      call(actor, null, RecordBackupInput, input, (request, caller) => {
        systemOnly(caller);
        recordBackup(ctx, request);
        return { ok: true as const };
      }),
    checkRestoreToken: (actor, input) =>
      call(
        actor,
        null,
        s.object({ token: s.string({ maxLength: 500 }) }),
        input,
        (request, caller) => {
          systemOnly(caller);
          return { ok: restoreTokenValid(ctx, request.token) };
        },
      ),
    getAdminInfo: (actor, input) =>
      call(actor, "settings", Empty, input, () => getAdminInfo(ctx, host())),
  };
}
