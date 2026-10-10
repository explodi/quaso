// SPDX-License-Identifier: MIT
/** The complete service composed from async batch operations on SQLite or D1. */
import { refreshContextualChecks, withContextualChecks } from "./contextual_checks.ts";
import { createQualityJobs } from "./quality_jobs.ts";
import { SYSTEM } from "./api.ts";
import { settingsFromData } from "./settings.ts";
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
  const quality = createQualityJobs(sql, {
    clock,
    logger,
    model,
    configuration: llm.configuration,
    schedule: llm.schedule,
  });
  const writes = asyncWriteMethods({
    ...options,
    sql,
    clock,
    logger,
    models: llm.models,
    llmConfiguration: llm.configuration,
    afterCreateJob: llm.afterCreateJob,
    afterLlmChange: async () => {
      await llm.start();
      await quality.start();
    },
    afterRestore: () => resume(),
  });
  const resume = async () => {
    if ((await unfinishedRestoreAsync(sql))?.resumable) return;
    await llm.start();
    await publication?.start();
    await quality.start();
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
      busy: () =>
        llm.busy ||
        quality.busy ||
        publication?.busy === true ||
        options.background?.busy() === true,
    }),
    ...writes,
    createQualityJob: quality.create,
    reviewTerminology: quality.reviewTerminology,
    async saveTranslation(actor, input) {
      const result = await writes.saveTranslation(actor, input);
      if (result.translation?.revision !== input.baseRevision)
        await quality.afterTranslation("save", input.id, input.language);
      return result;
    },
    async importTranslations(actor, input) {
      const result = await writes.importTranslations(actor, input);
      const [stored] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
      const policy = settingsFromData((stored[0]?.data as string | undefined) ?? null, model).llm
        .meaningCheck;
      const eligible =
        policy?.enabled && policy.onSave && (policy.colours === "all" || input.as === "blue");
      if (result.imported > 0 && !input.dryRun && eligible) {
        try {
          await quality.create(SYSTEM, {
            kind: "meaning",
            languages: [input.language],
            files: input.files.map((file) => file.path),
          });
        } catch {
          logger.warn("Couldn't queue imported translations for a meaning check");
        }
      }
      return result;
    },
    async approveTranslation(actor, input) {
      const result = await writes.approveTranslation(actor, input);
      if (result.translation?.revision !== input.baseRevision)
        await quality.afterTranslation("approval", input.id, input.language);
      return result;
    },
    async suggest(actor, input) {
      const result = await writes.suggest(actor, input);
      await quality.afterTranslation("save", input.id, input.language, result.id);
      return result;
    },
    async reviewSuggestions(actor, input) {
      const result = await writes.reviewSuggestions(actor, input);
      if (result.approved.length > 0) {
        const [rows] = await sql.read([
          {
            sql: "SELECT string_id, language FROM suggestions WHERE id IN (SELECT value FROM json_each(?))",
            params: [JSON.stringify(result.approved)],
          },
        ]);
        for (const row of rows)
          await quality.afterTranslation("approval", Number(row.string_id), String(row.language));
      }
      return result;
    },
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
      const [before] = await sql.read([
        { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
      ]);
      const work: Promise<void>[] = [];
      if (publication === null || (await publication.llmDue())) work.push(llm.alarm());
      if (publication !== null) work.push(publication.alarm());
      await Promise.all(work);
      const [stored] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
      const policy = settingsFromData((stored[0]?.data as string | undefined) ?? null, model).llm
        .meaningCheck;
      if (policy?.enabled && policy.onSave && policy.colours === "all") {
        const [written] = await sql.read([
          {
            sql: "SELECT string_id, language FROM translations WHERE revision > ? AND (author_type = 'llm' OR author_label = 'Translation memory')",
            params: [Number(before[0].revision)],
          },
        ]);
        const languages = new Map<string, number[]>();
        for (const row of written) {
          const tag = String(row.language);
          const ids = languages.get(tag) ?? [];
          ids.push(Number(row.string_id));
          languages.set(tag, ids);
        }
        for (const [language, ids] of languages)
          for (let offset = 0; offset < ids.length; offset += 500) {
            try {
              await quality.create(SYSTEM, {
                kind: "meaning",
                languages: [language],
                strings: ids.slice(offset, offset + 500),
              });
            } catch {
              logger.warn("Couldn't queue generated translations for a meaning check", {
                language,
              });
            }
          }
      }
      await quality.alarm();
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
