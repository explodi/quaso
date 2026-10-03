// SPDX-License-Identifier: MIT
/**
 * `GET /project` (WEB-1): the project, its languages with their progress, and a few facts.
 */
import {
  languageName,
  type ProjectInfo,
  type ProjectSettings,
  type LanguageProgress,
} from "@quaso/core";
import type { Context } from "./context.ts";
import { getRevision } from "./db.ts";
import { loadLanguages } from "./languages.ts";
import { loadSettings } from "./settings.ts";
import {
  type Counting,
  currentCounting,
  languageProgress,
  readProgressSnapshot,
} from "./status.ts";
import type { Sql } from "./ports.ts";

/** The project; `llmAvailable` says whether a provider is configured. */
export function getProject(ctx: Context, llmAvailable = false): ProjectInfo {
  const { sql } = ctx;
  const settings = loadSettings(ctx);
  const counting = currentCounting(ctx);
  const languages = loadLanguages(sql).map((language) => languageProgress(ctx, language).progress);
  const members = sql.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role <> 'none' AND deleted_at IS NULL",
  )[0].n;
  const lastActivity = sql.query<{ at: number | null }>(
    "SELECT MAX(created_at) AS at FROM activity",
  )[0].at;
  return projectInfo(
    { settings, counting, languages, members, lastActivity, revision: getRevision(sql) },
    llmAvailable,
  );
}

export async function getProjectAsync(
  sql: Sql,
  model: string,
  llmAvailable = false,
): Promise<ProjectInfo> {
  const snapshot = await readProgressSnapshot(sql, model);
  const languages = snapshot.languages.map(({ files: _files, ...progress }) => progress);
  return projectInfo({ ...snapshot, languages }, llmAvailable);
}

function projectInfo(
  state: {
    settings: ProjectSettings;
    counting: Counting;
    languages: LanguageProgress[];
    members: number;
    lastActivity: number | null;
    revision: number;
  },
  llmAvailable: boolean,
): ProjectInfo {
  const { settings, counting, languages, members, lastActivity, revision } = state;
  return {
    languageRequestsEnabled: settings.languageRequestsEnabled,
    name: settings.name,
    description: settings.description,
    sourceLanguage: settings.sourceLanguage,
    sourceLanguageName: languageName(settings.sourceLanguage),
    logoUrl: settings.logoUrl,
    links: settings.links,
    syntax: settings.syntax,
    languages,
    details: {
      strings: counting.strings.length,
      words: counting.strings.reduce((sum, string) => sum + string.words, 0),
      files: counting.files.length,
      members,
      lastActivity,
    },
    llmAvailable,
    referenceLanguages: settings.llm.context.otherLanguages,
    revision,
  };
}
