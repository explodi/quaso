// SPDX-License-Identifier: MIT
/**
 * LLM translation in the service (design §5.6, Sprint 5): the job methods of `ServiceApi`,
 * the alarm that runs jobs, re-arming it at start-up, and the automatic job of an upload.
 * `service.ts` wires it in.
 */
import {
  CreateJobRequest,
  type CreateJobResult,
  Id,
  type JobInfo,
  JobsQuery,
  type JobsResult,
  LanguageTag,
  type LlmSuggestion,
  s,
  type Schema,
  UsageQuery,
  type UsageResult,
  type LlmTestResult,
} from "@quaso/core";
import type { Actor } from "../api.ts";
import type { Context } from "../context.ts";
import { deleteMeta, getMeta, setMeta, transaction } from "../db.ts";
import type { Sql } from "../ports.ts";
import type { TranslationProvider } from "../llm/provider.ts";
import type { Action } from "../permissions.ts";
import type { Scheduler } from "../ports.ts";
import { NEXT_ALARM, scheduleWakeUp } from "../wakeups.ts";
import { cancelJob, createJob, getJob, listJobs } from "./jobs.ts";
import { type JobsEnv, resumeJobs, runJobs } from "./runner.ts";
import { suggestWithLlm } from "./llm_suggestion.ts";
import { getUsage, recordRequest } from "./usage.ts";
import { StoredLlm, type LlmConfiguration } from "../llm/configuration.ts";

export interface LlmOptions {
  provider?: TranslationProvider | null;
  providerFactory?: (apiKey: string) => TranslationProvider;
  dev?: boolean;
  scheduler: Scheduler;
  /** Batches in parallel. Default: `DEFAULT_CONCURRENCY` (4). */
  concurrency?: number;
  /** Tokens per UTC month, or null (the default) for no budget. */
  monthlyTokenBudget?: number | null;
}

/** The LLM methods of `ServiceApi`. */
export interface LlmMethods {
  /** Managers, administrators and `upload` keys: a job, or a dry run's estimate. */
  createJob(actor: Actor, input: CreateJobRequest): Promise<CreateJobResult>;
  /** Managers, administrators and `upload` keys. */
  getJob(actor: Actor, input: { id: number }): Promise<JobInfo>;
  /** Managers, administrators and `upload` keys: the 50 newest, or all active jobs. */
  listJobs(actor: Actor, input: JobsQuery): Promise<JobsResult>;
  /** Managers and administrators, or the API key that started the job. */
  cancelJob(actor: Actor, input: { id: number }): Promise<JobInfo>;
  /** Managers, administrators and `upload` keys. */
  getUsage(actor: Actor, input: UsageQuery): Promise<UsageResult>;
  /** Managers, administrators and `upload` keys: the provider's models, or none. */
  listModels(actor: Actor, input: Record<string, never>): Promise<{ models: string[] }>;
  /** People who may edit the language: the LLM's translation of one string, not saved. */
  suggestWithLlm(actor: Actor, input: { id: number; language: string }): Promise<LlmSuggestion>;
}

/** The names of the LLM methods, for the internal API's allowlists. */
export const LLM_METHODS = [
  "createJob",
  "getJob",
  "listJobs",
  "cancelJob",
  "getUsage",
  "listModels",
  "suggestWithLlm",
] as const satisfies readonly (keyof LlmMethods)[];

/** The LLM methods that only read, and may be tried again. */
export const LLM_SAFE_METHODS = [
  "getJob",
  "listJobs",
  "getUsage",
  "listModels",
] as const satisfies readonly (keyof LlmMethods)[];

/** The service's `call`: checks the actor, permission and input, then runs `fn` in a transaction. */
export type Call = <I, O>(
  caller: Actor,
  action: Action | null,
  schema: Schema<I>,
  input: unknown,
  fn: (input: I, actor: Actor) => O,
) => Promise<O>;

const Empty = s.object({});
const IdInput = s.object({ id: Id });
const StringInput = s.object({ id: Id, language: LanguageTag });

export interface Llm {
  test(): Promise<LlmTestResult>;
  configuration(): LlmConfiguration;
  readonly busy: boolean;
  /** Whether LLM translation is available: a provider is configured. */
  readonly available: boolean;
  /** At start-up: resumes paused jobs, and wakes up now if any job may have work. */
  start(): Promise<void>;
  /** Runs due jobs; see `runJobs`. */
  alarm(): Promise<void>;
  /** After an upload that queued a job: wakes up now. */
  afterUpload(job: { id: number } | null): Promise<void>;
  /** The provider's models, kept for ten minutes: one list for the service. */
  models(): Promise<string[]>;
  methods(call: Call): LlmMethods;
}

export function createLlm(ctx: Context, options: LlmOptions): Llm {
  const runtime = new StoredLlm({
    ...options,
    model: ctx.defaultModel,
    clock: ctx.clock,
    logger: ctx.logger,
  });
  const wakeUpNow = () => scheduleWakeUp(ctx.sql, options.scheduler, ctx.clock());
  let running = false;

  return {
    test: () => runtime.test(ctx),
    configuration: () => runtime.read(ctx),
    get available() {
      return runtime.read(ctx).provider !== null;
    },
    get busy() {
      return running;
    },

    async start() {
      if (transaction(ctx.sql, () => resumeJobs(ctx))) await wakeUpNow();
    },

    async alarm() {
      // One run at a time: the run in progress schedules what follows.
      if (running) return;
      running = true;
      try {
        const due = transaction(ctx.sql, () => getMeta(ctx.sql, NEXT_ALARM));
        const env: JobsEnv = { ctx, scheduler: options.scheduler, ...runtime.read(ctx) };
        const next = await runJobs(env);
        const arm = transaction(ctx.sql, () => {
          let at = next;
          // A job queued while the run finished (its wake-up found the due one stored).
          if (
            at === null &&
            ctx.sql.query("SELECT 1 AS found FROM jobs WHERE status = 'queued' LIMIT 1").length > 0
          ) {
            at = ctx.clock();
          }
          const stored = getMeta(ctx.sql, NEXT_ALARM);
          if (at === null) {
            if (stored === due) deleteMeta(ctx.sql, NEXT_ALARM);
            return null;
          }
          // Always after the wake-up that is due, so the host tells them apart.
          at = Math.max(at, due === null ? 0 : Number(due) + 1);
          if (stored !== null && stored !== due && Number(stored) <= at) return null;
          setMeta(ctx.sql, NEXT_ALARM, String(at));
          return at;
        });
        if (arm !== null) await options.scheduler.schedule(arm);
      } finally {
        running = false;
      }
    },

    models: () => {
      runtime.read(ctx);
      return runtime.models();
    },

    async afterUpload(job) {
      if (job === null) return;
      try {
        await wakeUpNow();
      } catch (error) {
        // The upload is saved, and so is the wake-up: start() arms it again.
        ctx.logger.error("Couldn't arm the wake-up for an upload's job", { job: job.id, error });
      }
    },

    methods: (call) => ({
      async createJob(actor, input) {
        const result = await call(
          actor,
          "translate",
          CreateJobRequest,
          input,
          (request, caller) => {
            const config = runtime.read(ctx);
            return createJob(ctx, caller, request, {
              llmAvailable: config.provider !== null,
              monthlyTokenBudget: config.monthlyTokenBudget,
            });
          },
        );
        if (result.job?.status === "queued") await wakeUpNow();
        return result;
      },
      getJob: (actor, input) =>
        call(actor, "translate", IdInput, input, ({ id }) => getJob(ctx, id)),
      listJobs: (actor, input) =>
        call(actor, "translate", JobsQuery, input, (query) => listJobs(ctx, query)),
      cancelJob: (actor, input) =>
        call(actor, null, IdInput, input, ({ id }, caller) => cancelJob(ctx, caller, id)),
      getUsage: (actor, input) =>
        call(actor, "usage", UsageQuery, input, (query) =>
          getUsage(ctx, query, runtime.read(ctx).monthlyTokenBudget),
        ),
      async listModels(actor, input) {
        await call(actor, "translate", Empty, input, () => null);
        runtime.read(ctx);
        return { models: await runtime.models() };
      },
      async suggestWithLlm(actor, input) {
        // The provider request can't wait inside a transaction: only the input is checked here.
        const checked = await call(actor, null, StringInput, input, (request, caller) => ({
          request,
          caller,
        }));
        const config = runtime.read(ctx);
        const read: Pick<Sql, "read"> = {
          read: (statements) =>
            Promise.resolve(
              transaction(ctx.sql, () =>
                statements.map((statement) =>
                  ctx.sql.query(statement.sql, ...(statement.params ?? [])),
                ),
              ),
            ),
        };
        return suggestWithLlm(read, checked.caller, checked.request, {
          provider: config.provider,
          model: ctx.defaultModel,
          monthlyTokenBudget: config.monthlyTokenBudget,
          clock: ctx.clock,
          logger: ctx.logger,
          record: (entry) => transaction(ctx.sql, () => recordRequest(ctx, entry)),
        });
      },
    }),
  };
}
