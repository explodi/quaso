// SPDX-License-Identifier: MIT
import {
  type ErrorDetail,
  formatKeyPath,
  JsonSyntaxError,
  MAX_LENGTH_LIMIT,
  type ProjectSettings,
  readSource,
  SourceError,
  type UploadRequest,
} from "@quaso/core";
import { toJson } from "./db.ts";
import { type EntryColumns, entryColumns } from "./entries.ts";
import { badRequest, ServiceError } from "./errors.ts";
import { validationFailed } from "./validation.ts";

export interface ParsedFile {
  path: string;
  repoPath: string;
  format: string;
  entries: EntryColumns[];
}

/** Reads every file, reporting every file's syntax error together. */
export function readUploadFiles(request: UploadRequest, settings: ProjectSettings): ParsedFile[] {
  if (request.files.length === 0 && !request.partial) {
    throw badRequest("The upload has no files. A full upload hides every file it doesn't include.");
  }
  const tooLong = (request.limits ?? []).flatMap((limit, index) =>
    limit.maxLength > MAX_LENGTH_LIMIT
      ? [{ path: ["limits", index, "maxLength"], message: `must be at most ${MAX_LENGTH_LIMIT}` }]
      : [],
  );
  if (tooLong.length > 0) throw validationFailed(tooLong);
  const seen = new Set<string>();
  for (const file of request.files) {
    if (seen.has(file.path)) throw badRequest(`The upload has ${file.path} twice.`);
    seen.add(file.path);
  }
  const exclusions = new Map<string, string[]>();
  for (const exclusion of request.pluralExclusions ?? []) {
    const list = exclusions.get(exclusion.file) ?? [];
    list.push(exclusion.key);
    exclusions.set(exclusion.file, list);
  }
  const options = {
    syntax: settings.syntax,
    locale: request.sourceLanguage ?? settings.sourceLanguage,
  };
  const parsed: ParsedFile[] = [];
  const problems: { detail: ErrorDetail; message: string }[] = [];
  for (const file of request.files) {
    try {
      const source = readSource(file.content, {
        file: file.path,
        syntax: settings.syntax,
        pluralExclusions: exclusions.get(file.path),
      });
      parsed.push({
        path: file.path,
        repoPath: file.repoPath,
        format: toJson(source.format),
        entries: source.entries.map((entry) => entryColumns(entry, options)),
      });
    } catch (error) {
      if (!(error instanceof JsonSyntaxError || error instanceof SourceError)) throw error;
      const detail: ErrorDetail = { file: file.path, message: error.detail };
      if (error.line !== undefined) detail.line = error.line;
      if (error.column !== undefined) detail.column = error.column;
      if (error.keyPath !== undefined) detail.key = formatKeyPath(error.keyPath);
      problems.push({ detail, message: error.message });
    }
  }
  if (problems.length > 0) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
    throw new ServiceError("invalid_source", `${problems[0].message}${more}`, {
      details: problems.map((problem) => problem.detail),
    });
  }
  return parsed;
}
