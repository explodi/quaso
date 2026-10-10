// SPDX-License-Identifier: MIT
/**
 * The LLM routes (design §5.6, §5.11; S5.6, S5.7): jobs for one string, a selection, a
 * file, a language or everything (`quaso translate`, the website's Auto-translate dialog),
 * their progress and cancelling, the usage per day or month, and the provider's models.
 * Managers, administrators and API keys with the `upload` scope; the service decides.
 * And the editor's LLM suggestion for one string, which nothing saves.
 */
import { CreateJobRequest, Id, JobsQuery, LanguageTag, s, UsageQuery } from "@quaso/core";
import type { ApiRoute } from "./api.ts";
import { route } from "./route.ts";

const JobParams = s.object({ id: Id });
const TranslationParams = s.object({ id: Id, lang: LanguageTag });

export const JOB_ROUTES: ApiRoute[] = [
  route({
    method: "POST",
    path: "/jobs",
    operationId: "createJob",
    summary:
      "Start an LLM translation job (quaso translate), or with dryRun, count the strings and estimate the tokens",
    tag: "LLM",
    access: "translate",
    body: CreateJobRequest,
    handle: ({ service, actor, body }) => service.createJob(actor, body),
  }),
  route({
    method: "GET",
    path: "/jobs",
    operationId: "listJobs",
    summary: "The 50 newest LLM jobs, or all queued and running jobs with active=true",
    tag: "LLM",
    access: "translate",
    query: JobsQuery,
    handle: ({ service, actor, query }) => service.listJobs(actor, query),
  }),
  route({
    method: "GET",
    path: "/jobs/:id",
    operationId: "getJob",
    summary: "An LLM job: its status, progress, tokens and failures",
    tag: "LLM",
    access: "translate",
    params: JobParams,
    handle: ({ service, actor, params }) => service.getJob(actor, { id: params.id }),
  }),
  route({
    method: "DELETE",
    path: "/jobs/:id",
    operationId: "cancelJob",
    summary: "Cancel an LLM job (an API key may cancel the jobs it started)",
    tag: "LLM",
    access: "translate",
    params: JobParams,
    handle: ({ service, actor, params }) => service.cancelJob(actor, { id: params.id }),
  }),
  route({
    method: "GET",
    path: "/usage",
    operationId: "getUsage",
    summary: "LLM requests and tokens per UTC day or month, by language and model, and the budget",
    tag: "LLM",
    access: "translate",
    query: UsageQuery,
    handle: ({ service, actor, query }) => service.getUsage(actor, query),
  }),
  route({
    method: "GET",
    path: "/models",
    operationId: "listModels",
    summary: "The models the LLM provider offers (none without a provider)",
    tag: "LLM",
    access: "translate",
    handle: ({ service, actor }) => service.listModels(actor, {}),
  }),
  route({
    method: "POST",
    path: "/strings/:id/translations/:lang/llm-suggestion",
    operationId: "suggestWithLlm",
    summary:
      "The LLM's translation of one string, for the editor to offer while someone types theirs; nothing is saved",
    tag: "LLM",
    access: "manager",
    params: TranslationParams,
    optionalBody: true,
    body: s.object({}),
    handle: ({ service, actor, params }) =>
      service.suggestWithLlm(actor, { id: params.id, language: params.lang }),
  }),
];
