// SPDX-License-Identifier: MIT
/** File context generation runs outside SQL; usage and a still-current cache commit together. */
import type { ProjectSettings } from "@quaso/core";
import { SYSTEM, type Actor } from "../api.ts";
import { forbidden } from "../errors.ts";
import {
  NO_USAGE,
  ProviderError,
  type TextRequest,
  type TranslationProvider,
} from "../llm/provider.ts";
import { silentLogger, type Clock, type Logger, type Sql, type Statement } from "../ports.ts";
import { settingsFromData } from "../settings.ts";
import { withRetries } from "../write.ts";
import { BUDGET_ERROR, JOB_COLUMNS, type JobRow, scopeOf, pauseActiveAsync } from "./store.ts";
import { monthlyUsage, requestWriteStatements, type RequestRecord } from "./usage.ts";
import { fileEnglishFromRows, fileEnglishStatement } from "./prompts.ts";

export function fileContextRequest(
  settings: ProjectSettings,
  model: string,
  path: string,
  english: string,
): TextRequest {
  const about = settings.description.trim() === "" ? "" : `\n${settings.description.trim()}\n`;
  return {
    model,
    system: "You describe the text files of games and apps for their translators.",
    prompt:
      `The project: ${settings.name}.${about}\n` +
      `The first strings of the file ${path}, one JSON object per line:\n${english}\n\n` +
      "In two to four sentences, describe what this file holds and where its texts appear, " +
      "so that a translator knows their context. Answer with the description only.",
    safety: settings.llm.safety,
  };
}

type ContextFile = {
  path: string;
  context: string;
  generated_context: string | null;
  active: number;
};
const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

/** The runner serializes calls; a recorded attempt prevents retries in later runs. */
export async function generateFileContextAsync(
  sql: Sql,
  actor: Actor,
  jobId: number,
  fileId: number,
  options: {
    provider: TranslationProvider | null;
    model: string;
    monthlyTokenBudget: number | null;
    clock?: Clock;
    logger?: Logger;
  },
): Promise<number | null> {
  if (actor.type !== SYSTEM.type) throw forbidden("Only the server generates file context.");
  if (options.provider === null) return null;
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const [jobs, files, sources, settingsRows, asked, monthly] = await sql.read([
    { sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, params: [jobId] },
    {
      sql: "SELECT path, context, generated_context, active FROM files WHERE id = ?",
      params: [fileId],
    },
    fileEnglishStatement(fileId),
    { sql: "SELECT data FROM settings WHERE id = 1" },
    {
      sql: "SELECT 1 AS found FROM llm_requests WHERE job_id = ? AND file_id = ? AND language IS NULL AND created_at >= (SELECT created_at FROM jobs WHERE id = ?) LIMIT 1",
      params: [jobId, fileId, jobId],
    },
    monthlyUsage(clock()),
  ]);
  const job = jobs[0] as JobRow | undefined;
  const file = files[0] as ContextFile | undefined;
  if (job === undefined || (job.status !== "queued" && job.status !== "running")) return null;
  if (file === undefined || file.active !== 1) return null;
  const hasContext = file.context.trim() !== "" || file.generated_context !== null;
  if (hasContext || asked.length > 0) return null;
  const settings = settingsFromData(
    (settingsRows[0]?.data as string | undefined) ?? null,
    options.model,
  );
  if (!settings.llm.context.fileContext) return null;
  const english = fileEnglishFromRows(sources);
  if (english === "") return null;
  if (
    options.monthlyTokenBudget !== null &&
    Number(monthly[0].n ?? 0) >= options.monthlyTokenBudget
  ) {
    await pauseActiveAsync(sql, SYSTEM, BUDGET_ERROR, clock());
    return null;
  }
  const model = scopeOf(job).model ?? settings.llm.model;
  const started = clock();
  let text = "";
  let failure: ProviderError | null = null;
  let record: RequestRecord;
  try {
    const result = await options.provider.generateText(
      fileContextRequest(settings, model, file.path, english),
    );
    text = result.text.trim();
    record = {
      jobId,
      fileId,
      language: null,
      provider: options.provider.name,
      model: result.model ?? model,
      strings: 0,
      usage: result.usage,
      durationMs: result.durationMs ?? clock() - started,
      outcome: "ok",
      error: null,
    };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    failure = error;
    record = {
      jobId,
      fileId,
      language: null,
      provider: options.provider.name,
      model,
      strings: 0,
      usage: error.usage ?? NO_USAGE,
      durationMs: clock() - started,
      outcome: error.kind === "blocked" ? "blocked" : "failed",
      error: error.message,
    };
  }
  const now = clock();
  const id = await withRetries(
    sql,
    async () => {
      const [revision, next, currentFiles, currentSources, currentJobs] = await sql.read([
        REVISION,
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM llm_requests" },
        {
          sql: "SELECT path, context, generated_context, active FROM files WHERE id = ?",
          params: [fileId],
        },
        fileEnglishStatement(fileId),
        { sql: `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, params: [jobId] },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          id: Number(next[0].id),
          file: currentFiles[0] as ContextFile | undefined,
          english: fileEnglishFromRows(currentSources),
          job: currentJobs[0] as JobRow | undefined,
        },
      };
    },
    (state) => {
      const sameJob = state.job?.created_at === job.created_at;
      const statements = requestWriteStatements(
        state.id,
        { ...record, jobId: sameJob ? jobId : null },
        now,
      );
      const cacheAvailable =
        state.file?.active === 1 &&
        state.file.context.trim() === "" &&
        state.file.generated_context === null;
      const sourceMatches = state.file?.path === file.path && state.english === english;
      const jobActive =
        sameJob &&
        (state.job?.status === "queued" ||
          state.job?.status === "running" ||
          state.job?.status === "paused");
      if (text !== "" && cacheAvailable && sourceMatches && jobActive)
        statements.push({
          sql: "UPDATE files SET generated_context = ? WHERE id = ?",
          params: [text, fileId],
        });
      return { statements, result: state.id };
    },
  );
  if (failure !== null)
    logger.warn("Couldn't generate a file's context", { fileId, error: failure.message });
  return id;
}
