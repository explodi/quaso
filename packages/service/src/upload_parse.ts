// SPDX-License-Identifier: MIT
import {
  type ErrorDetail,
  formatKeyPath,
  parseJson,
  toPlain,
  type KeyPath,
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
  descriptions?: { key: string; description: string }[];
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
      const descriptions: NonNullable<ParsedFile["descriptions"]> = [];
      if (file.descriptions !== undefined) {
        const value = toPlain(
          parseJson(file.descriptions, { file: `${file.path} descriptions` }).root,
        );
        const visit = (node: unknown, path: KeyPath) => {
          if (typeof node === "string") {
            if (node.length > 4000)
              throw badRequest(
                `Description for ${file.path} › ${formatKeyPath(path)} exceeds 4000 characters.`,
              );
            descriptions.push({ key: JSON.stringify(path), description: node });
            return;
          }
          if (node === null || typeof node !== "object")
            throw badRequest(`Description for ${file.path} › ${formatKeyPath(path)} must be text.`);
          for (const [key, child] of Object.entries(node))
            visit(child, [...path, Array.isArray(node) ? Number(key) : key]);
        };
        visit(value, []);
      }
      const entries = source.entries.filter((entry) => {
        const last = entry.keyPath.at(-1);
        const annotation =
          request.descriptionSuffix &&
          typeof last === "string" &&
          last.endsWith(request.descriptionSuffix);
        if (!annotation) return true;
        const description =
          entry.kind === "text" || entry.kind === "reference"
            ? entry.value
            : entry.kind === "literal"
              ? JSON.parse(entry.raw)
              : null;
        if (typeof description !== "string" || description.length > 4000)
          throw badRequest(
            `Description ${file.path} › ${formatKeyPath(entry.keyPath)} must be text of at most 4000 characters.`,
          );
        const path = [
          ...entry.keyPath.slice(0, -1),
          last.slice(0, -request.descriptionSuffix!.length),
        ];
        descriptions.push({ key: JSON.stringify(path), description });
        return false;
      });
      parsed.push({
        path: file.path,
        repoPath: file.repoPath,
        format: toJson(source.format),
        entries: entries.map((entry) => entryColumns(entry, options)),
        ...(descriptions.length > 0 ? { descriptions } : {}),
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
