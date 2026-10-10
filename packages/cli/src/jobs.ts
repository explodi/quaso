// SPDX-License-Identifier: MIT
/**
 * Waiting for an LLM job (design §5.10, S5.6): `quaso translate` and `quaso upload --wait`
 * poll `GET /jobs/{id}` every 2 seconds, report progress on stderr, and end with the job's
 * outcome. Strings that failed are listed with local paths, as `file › key (lang): reason`,
 * and make the exit code 6, like a job that failed, was cancelled or paused.
 */
import type { JobInfo } from "@quaso/core";
import type { Project } from "./config.ts";
import { CliError, EXIT, type ExitCode, type Problem } from "./errors.ts";
import { type Sources, translationPath } from "./files.ts";
import type { ApiClient } from "./http.ts";
import { count, formatProblem, type Output, sentenceFragment } from "./output.ts";

/** How often the CLI asks for the job's progress. */
export const POLL_INTERVAL_MS = 2_000;

/** Statuses after which a job does nothing more (until someone resumes a paused one). */
const SETTLED = new Set(["done", "failed", "cancelled", "paused"]);

/** A job the CLI waited for, and its failures with local paths. */
export interface WaitedJob {
  job: JobInfo;
  /** Strings that stayed untranslated, with the translation file's local path. */
  failures: Problem[];
  /** 6 when strings failed or the job didn't finish; 0 otherwise. */
  exitCode: ExitCode;
}

/**
 * Polls the job until it settles, printing its progress on stderr when it changes.
 * `sleep` waits between polls (tests pass one that doesn't).
 */
export async function waitForJob(
  client: ApiClient,
  first: JobInfo,
  out: Output,
  sleep: (ms: number) => Promise<void>,
  mapFailures: (job: JobInfo) => Problem[],
): Promise<WaitedJob> {
  let job = first;
  let reported = "";
  for (;;) {
    if (typeof job?.status !== "string" || typeof job.progress !== "object") {
      throw new CliError(EXIT.unexpected, "The server's answer about the job isn't a job.", {
        code: "bad_response",
        hint: "Is QUASO_HOSTNAME a Quaso instance? It didn't answer like one.",
      });
    }
    const line = progressLine(job);
    if (line !== reported) {
      out.info(line);
      reported = line;
    }
    if (SETTLED.has(job.status)) break;
    await sleep(POLL_INTERVAL_MS);
    job = await client.get<JobInfo>(`/jobs/${job.id}`);
  }
  const failures = mapFailures(job);
  const exitCode = job.status === "done" && job.progress.failed === 0 ? EXIT.ok : EXIT.refused;
  return { job, failures, exitCode };
}

/** `Translating: 40 of 120 (33%), 2 failed`, or the final status. */
export function progressLine(job: JobInfo): string {
  const { total, done, failed } = job.progress;
  const percent = total > 0 ? Math.floor((done * 100) / total) : 100;
  const failures = failed > 0 ? `, ${failed} failed` : "";
  switch (job.status) {
    case "queued":
      return `Translation job ${job.id} is queued (${count(total, "string")}).`;
    case "running":
      return `Translating: ${done} of ${total} (${percent}%)${failures}.`;
    default:
      return `Translation job ${job.id} ${job.status}: ${done} of ${total}${failures}.`;
  }
}

/**
 * A job's failures as problems with local paths: the translation file the string would be
 * written to, in the language that failed.
 */
export function localFailures(job: JobInfo, project: Project, sources: Sources): Problem[] {
  return job.failures.map((failure) => {
    const source = sources.byServer.get(failure.file);
    return {
      file: source ? translationPath(project, source, failure.language) : failure.file,
      key: failure.key,
      language: failure.language,
      message: failure.reason,
    };
  });
}

/** The job's outcome in text: counts, tokens, failures and what to do. */
export function renderJob(out: Output, waited: WaitedJob): void {
  const { bold, dim, green, red, yellow } = out.out;
  const { job, failures } = waited;
  const { translated, proposed, failed, skipped } = job.progress;
  if (job.status === "done" && job.progress.total === 0) {
    out.print("Nothing to translate: every string in scope is translated.");
    return;
  }
  const parts = [green(`${translated} translated`)];
  if (job.progress.reused) parts.push(`${job.progress.reused} reused`);
  if (proposed > 0) parts.push(`${proposed} proposed for proofread strings`);
  if (skipped > 0) parts.push(dim(`${skipped} skipped (changed meanwhile)`));
  if (failed > 0) parts.push(red(`${failed} failed`));
  const tokens = job.tokens.input + job.tokens.output + job.tokens.thinking;
  const status = job.status === "done" ? "done" : yellow(job.status);
  out.print(
    `Translation job ${job.id} ${status}: ${parts.join(", ")} (${tokens.toLocaleString(
      "en",
    )} tokens).`,
  );
  if (job.error) out.print(yellow(sentenceFragment(job.error)));
  if (failures.length > 0) {
    out.print();
    out.print(bold(`Strings that stayed untranslated (${failed}):`));
    for (const failure of failures) out.print(`  ${formatProblem(failure)}`);
    if (failed > failures.length) {
      out.print(
        dim(`  … and ${failed - failures.length} more; the instance shows them on each string`),
      );
    }
  }
  if (job.status === "paused") {
    out.print(
      dim("The job resumes on its own when the instance can go on (a new month, or a new key)."),
    );
  }
}

/** The job's outcome as JSON. */
export function jobJson(waited: WaitedJob): { job: JobInfo; failures: Problem[] } {
  return { job: waited.job, failures: waited.failures };
}
