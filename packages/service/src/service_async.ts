// SPDX-License-Identifier: MIT
/** The complete service composed from async batch operations on SQLite or D1. */
import { refreshContextualChecks, withContextualChecks } from "./contextual_checks.ts";
import { UploadRequest } from "@quaso/core";
import { unfinishedRestoreAsync } from "./backup.ts";
import { FALLBACK_MODEL } from "./context.ts";
import { createAsyncLlm } from "./jobs/llm_async.ts";
import { readPermissions } from "./permissions.ts";
import { silentLogger, type Sql, type Store } from "./ports.ts";
import { createPublication, LLM_ALARM } from "./publication.ts";
import { asyncReadMethods } from "./read_methods.ts";
import type { Service, ServiceOptions } from "./service.ts";
import { initializeDatabase } from "./startup.ts";
import { uploadForActorAsync } from "./upload.ts";
import { validateActor, validateInput } from "./validation.ts";
import { asyncWriteMethods } from "./write_methods.ts";

export type AsyncServiceOptions = Omit<ServiceOptions, "sql"> & {
  sql: Sql;
  store?: Store;
  background?: { busy(): boolean; nextWakeUp(): number | null };
};

export function createAsyncService(options: AsyncServiceOptions): Service {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const model = options.defaultModel ?? FALLBACK_MODEL;
  const checkedSql = withContextualChecks(options.sql);
  const publication =
    options.store === undefined
      ? null
      : createPublication(checkedSql, options.store, options.scheduler, { clock, model, logger });
  const sql = publication?.sql ?? checkedSql;
  const llm = createAsyncLlm(sql, {
    provider: options.provider,
    providerFactory: options.providerFactory,
    dev: options.dev,
    scheduler: publication?.llmScheduler ?? options.scheduler,
    wakeUpKey: publication === null ? undefined : LLM_ALARM,
    concurrency: options.llmConcurrency,
    monthlyTokenBudget: options.monthlyTokenBudget,
    clock,
    logger,
    model,
  });
  const resume = async () => {
    if ((await unfinishedRestoreAsync(sql))?.resumable) return;
    await llm.start();
    await publication?.start();
  };
  return {
    ...asyncReadMethods({
      ...options,
      sql,
      clock,
      logger,
      models: llm.models,
      testLlm: llm.test,
      llmConfiguration: llm.configuration,
      busy: () => llm.busy || publication?.busy === true || options.background?.busy() === true,
    }),
    ...asyncWriteMethods({
      ...options,
      sql,
      clock,
      logger,
      models: llm.models,
      llmConfiguration: llm.configuration,
      afterCreateJob: llm.afterCreateJob,
      afterLlmChange: llm.start,
      afterRestore: resume,
    }),
    async start() {
      const migrated = await initializeDatabase(options.sql, options);
      await refreshContextualChecks(options.sql);
      await resume();
      logger.info("Service started", {
        schemaVersion: migrated.to,
        migratedFrom: migrated.from === migrated.to ? undefined : migrated.from,
        created: migrated.created,
      });
      return { schemaVersion: { from: migrated.from, to: migrated.to }, created: migrated.created };
    },
    async alarm() {
      if ((await unfinishedRestoreAsync(options.sql))?.resumable) return;
      const work: Promise<void>[] = [];
      if (publication === null || (await publication.llmDue())) work.push(llm.alarm());
      if (publication !== null) work.push(publication.alarm());
      await Promise.all(work);
    },
    async upload(caller, input) {
      const actor = validateActor(caller);
      let request: UploadRequest;
      try {
        request = validateInput(UploadRequest, input);
      } catch (error) {
        (await readPermissions(sql, actor)).require("upload");
        throw error;
      }
      const result = await uploadForActorAsync(sql, actor, request, {
        model,
        clock,
        llmAvailable: (await llm.configuration()).provider !== null,
      });
      await llm.afterUpload(result.job);
      if (!result.dryRun && result.uploadId !== null)
        logger.info("Upload", {
          uploadId: result.uploadId,
          added: result.added.length,
          changed: result.changed.length,
          removed: result.removed.length,
          restored: result.restored.length,
          revision: result.revision,
        });
      return result;
    },
  };
}
