// SPDX-License-Identifier: MIT
/**
 * `quaso translate` (design §5.6, §5.10, S5.6; LLM-2): asks the instance's LLM to translate
 * the untranslated strings (and, with `--retranslate`, the green ones again) of the config's
 * languages or `--language`, in every file or `--file`. By default it waits for the job,
 * with its progress on stderr, and exits with code 6 when strings failed; `--no-wait` only
 * starts it, and `--dry-run` counts the strings and estimates the tokens.
 */
import {
  type CreateJobRequest,
  type CreateJobResult,
  isValidLanguageTag,
  type JobEstimate,
  type JobInfo,
} from "@quaso/core";
import { flag, option, values } from "../args.ts";
import { canonical } from "../config.ts";
import type { Command, Context } from "../context.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { resolveFileArgs } from "../files.ts";
import { jobJson, localFailures, renderJob, waitForJob } from "../jobs.ts";
import { count, type Output, table } from "../output.ts";

export const translate: Command = {
  name: "translate",
  summary: "Ask the LLM to translate untranslated strings, and wait for it",
  description: [
    "Starts an LLM translation job on the instance for the untranslated strings of the " +
      "config's languages (or --language), in every file (or --file). Outdated translations " +
      "are updated too, and outdated proofread (blue) ones get a proposal to review instead. " +
      "--retranslate also translates green (not yet proofread) strings again; proofread " +
      "strings never change.",
    "Every result goes through the quality checks. By default the command waits for the " +
      "job, with its progress on stderr, and lists the strings that failed as " +
      "file › key (lang): reason, with exit code 6. --no-wait only starts the job. --dry-run " +
      "counts the strings and words, and estimates the requests and tokens.",
  ],
  options: [
    {
      name: "language",
      type: "list",
      value: "<lang>",
      description: "Only these languages (repeatable, or a comma list); default: the config's",
    },
    {
      name: "file",
      type: "multiple",
      value: "<path>",
      description:
        "Only this source file (a server path such as common.json, or a local " +
        "path); repeatable",
    },
    {
      name: "retranslate",
      type: "boolean",
      description: "Also translate green (not proofread) strings again; blue ones never change",
    },
    {
      name: "qa",
      type: "boolean",
      description:
        "Also translate again the green strings that fail the quality checks, such as imported ones",
    },
    {
      name: "instruction",
      type: "string",
      value: "<text>",
      description: 'An instruction for this run, such as "Use the informal you"',
    },
    {
      name: "model",
      type: "string",
      value: "<name>",
      description: "The model for this run, instead of the instance's (such as gemini-2.5-pro)",
    },
    {
      name: "no-wait",
      type: "boolean",
      description: "Start the job and exit, without waiting for it",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Count the strings and words, and estimate the requests and tokens",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 6],
  examples: [
    "quaso translate",
    "quaso translate --language de,fr --file common.json",
    "quaso translate --dry-run",
    'quaso translate --retranslate --instruction "Address the player informally"',
    "quaso translate --no-wait --json",
  ],
  async run(ctx: Context) {
    for (const tag of values(ctx.args, "language")) {
      if (!isValidLanguageTag(tag)) {
        throw usageError(`--language ${tag} isn't a valid BCP 47 language tag.`);
      }
    }
    const project = await ctx.project();
    const sources = await ctx.sources();
    const requested = [...new Set(values(ctx.args, "language").map(canonical))];
    for (const language of requested) {
      if (language === project.sourceLanguage) {
        throw usageError(`${language} is the source language: it isn't translated.`);
      }
    }
    const named = values(ctx.args, "file");
    const files =
      named.length > 0
        ? resolveFileArgs(project, sources, ctx.cwd, named).map((file) => file.server)
        : undefined;
    const dryRun = flag(ctx.args, "dry-run");
    const request: CreateJobRequest = {
      languages: requested.length > 0 ? requested : project.languages,
    };
    if (files) request.files = files;
    if (flag(ctx.args, "retranslate")) request.retranslate = true;
    if (flag(ctx.args, "qa")) request.qa = true;
    const instruction = option(ctx.args, "instruction");
    if (instruction !== undefined && instruction.trim() !== "") request.instruction = instruction;
    const model = option(ctx.args, "model");
    if (model !== undefined && model.trim() !== "") request.model = model.trim();
    if (dryRun) request.dryRun = true;

    const client = ctx.client(project);
    ctx.out.info(
      `${dryRun ? "Estimating" : "Starting"} the translation of ${request.languages!.join(
        ", ",
      )} on ${client.baseUrl}…`,
    );
    let created: CreateJobResult;
    try {
      created = await client.post<CreateJobResult>("/jobs", request, {
        retry: dryRun ? "safe" : "once",
      });
    } catch (error) {
      throw withHint(error, project.configName);
    }
    const server = client.baseUrl;
    if (created.estimate !== null) {
      const estimate = created.estimate;
      return {
        exitCode: EXIT.ok,
        json: { server, dryRun: true, estimate },
        render: (out) => renderEstimate(out, estimate),
      };
    }
    const job = created.job;
    if (flag(ctx.args, "no-wait")) {
      return {
        exitCode: EXIT.ok,
        json: { server, dryRun: false, waited: false, job, failures: [] },
        render: (out) => renderQueued(out, job),
      };
    }
    const waited = await waitForJob(
      client,
      job,
      ctx.out,
      (ms) => ctx.sleep(ms),
      (final) => localFailures(final, project, sources),
    );
    return {
      exitCode: waited.exitCode,
      json: { server, dryRun: false, waited: true, ...jobJson(waited) },
      render: (out) => renderJob(out, waited),
    };
  },
};

/** Adds what to do to the instance's refusals that people can fix. */
function withHint(error: unknown, configName: string): unknown {
  if (
    error instanceof CliError &&
    error.code === "bad_request" &&
    !error.hint &&
    /has no language/.test(error.message)
  ) {
    return new CliError(error.exitCode, error.message, {
      code: error.code,
      status: error.status,
      details: error.details,
      hint: `quaso upload adds the languages of ${configName} to the instance.`,
    });
  }
  return error;
}

function renderEstimate(out: Output, estimate: JobEstimate): void {
  const { dim, yellow } = out.out;
  out.print(yellow("Dry run: nothing was translated."));
  const rows = estimate.languages.map((language) => [
    language.language,
    count(language.strings, "string"),
    count(language.words, "word"),
  ]);
  for (const line of table(rows, { right: [1, 2] })) out.print(`  ${line}`);
  out.print();
  if (estimate.strings === 0) {
    out.print("Nothing to translate: every string in scope is translated.");
    return;
  }
  out.print(
    `${count(estimate.strings, "string")} (${count(estimate.words, "word")}) in ${count(
      estimate.requests,
      "request",
    )}: about ${estimate.estimatedTokens.input.toLocaleString("en")} input and ${estimate.estimatedTokens.output.toLocaleString(
      "en",
    )} output tokens.`,
  );
  out.print(workSummary(estimate.work));
  out.print(dim("Thinking models use more tokens than this; retries add some too."));
}

/** "Of these: 3 untranslated, 2 outdated green to update…", leaving out what is zero. */
function workSummary(work: JobEstimate["work"]): string {
  const parts: string[] = [];
  if (work.translate > 0) parts.push(`${work.translate} untranslated`);
  if (work.retranslate > 0) parts.push(`${work.retranslate} green to translate again`);
  if (work.update > 0) parts.push(`${work.update} outdated green to update`);
  if (work.propose > 0)
    parts.push(`${work.propose} outdated proofread to get a proposal for review`);
  return `Of these: ${parts.join(", ")}.`;
}

function renderQueued(out: Output, job: JobInfo): void {
  if (job.status === "done") {
    out.print("Nothing to translate: every string in scope is translated.");
    return;
  }
  out.print(
    `Translation job ${job.id} is queued for ${count(job.progress.total, "string")}. ` +
      "The instance runs it; quaso status shows the result.",
  );
}
