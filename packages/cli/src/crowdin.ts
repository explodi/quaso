// SPDX-License-Identifier: MIT
/** Convert local Crowdin paths; credentials never enter the generated configuration. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load, JSON_SCHEMA } from "js-yaml";
import { canonicalLanguageTag } from "@quaso/core";
import { canonical, describeFsError, normalizePattern } from "./config.ts";
import { usageError } from "./errors.ts";
import { glob, globBase } from "./glob.ts";

export async function convertCrowdin(cwd: string, path: string, sourceLanguage: string) {
  let document: Record<string, unknown>;
  try {
    const parsed = load(await readFile(resolve(cwd, path), "utf8"), { schema: JSON_SCHEMA });
    if (!record(parsed)) throw new Error("expected a YAML object");
    document = parsed;
  } catch (error) {
    // YAML exceptions include source excerpts, which can contain the Crowdin token.
    const reason = (error as { code?: string }).code
      ? describeFsError(error)
      : "invalid YAML configuration";
    throw usageError(`Can't convert ${path}: ${reason}.`);
  }
  if (document.base_path !== undefined && document.base_path !== "." && document.base_path !== "")
    throw usageError("Crowdin base_path must be the current project folder (.).");
  if (!Array.isArray(document.files))
    throw usageError("Crowdin configuration needs a files array.");
  const files: { source: string; translation: string; exclude?: string[] }[] = [];
  const languages = new Set<string>();
  const languageMapping: Record<string, string> = {};
  const warnings: string[] = [];
  const proposals: string[] = [];
  for (const [index, entry] of document.files.entries()) {
    const label = `files[${index}]`;
    if (
      !record(entry) ||
      typeof entry.source !== "string" ||
      typeof entry.translation !== "string"
    ) {
      warnings.push(`${label}: source and translation must be strings; skipped.`);
      continue;
    }
    const source = normalizePattern(entry.source.replace(/^\/+/, ""));
    if (typeof source !== "string" || source.includes("%")) {
      warnings.push(`${label}: unsafe source pattern; skipped.`);
      continue;
    }
    const original = entry.translation.replace(/^\/+/, "");
    const placeholders = original.match(/%[^%]+%/g) ?? [];
    const languageTokens = placeholders.filter((token) =>
      ["%two_letters_code%", "%locale%", "%language%"].includes(token),
    );
    const unsupported = placeholders.filter(
      (token) => ![...languageTokens, "%original_path%", "%original_file_name%"].includes(token),
    );
    if (languageTokens.length !== 1 || unsupported.length > 0) {
      warnings.push(
        `${label}: unsupported placeholders ${unsupported.join(", ") || "(requires one language placeholder)"}; skipped.`,
      );
      continue;
    }
    const base = globBase(source);
    let translation = original.replace(languageTokens[0], "{lang}");
    if (translation.includes("%original_path%/%original_file_name%")) {
      if (document.preserve_hierarchy !== true) {
        warnings.push(`${label}: original_path requires preserve_hierarchy: true; skipped.`);
        continue;
      }
      translation = translation.replace(
        "%original_path%/%original_file_name%",
        [base, "{path}"].filter(Boolean).join("/"),
      );
    } else if (translation.includes("**/%original_file_name%")) {
      translation = translation.replace("**/%original_file_name%", "{path}");
    } else if (!source.slice(base === "" ? 0 : base.length + 1).includes("/")) {
      translation = translation.replace("%original_file_name%", "{path}");
    }
    if (translation.includes("%") || /[*?]/.test(translation)) {
      warnings.push(`${label}: file layout cannot be represented without changing paths; skipped.`);
      continue;
    }
    const normalized = normalizePattern(translation);
    if (typeof normalized !== "string") {
      warnings.push(`${label}: unsafe translation pattern; skipped.`);
      continue;
    }
    const folderMappings = record(entry.languages_mapping)
      ? entry.languages_mapping[languageTokens[0].slice(1, -1)]
      : undefined;
    const mappings = record(folderMappings) ? folderMappings : {};
    const remember = (tag: string, folder: string) => {
      const language = canonical(tag);
      if (language === canonical(sourceLanguage)) return;
      const existing = languageMapping[language];
      if (existing !== undefined && existing !== folder)
        throw usageError(
          `Crowdin uses different folder names for ${language} across file entries.`,
        );
      languages.add(language);
      languageMapping[language] = folder;
    };
    for (const [tag, folder] of Object.entries(mappings)) {
      if (canonicalLanguageTag(tag) === null || typeof folder !== "string") {
        warnings.push(
          `${label}: unsupported language mapping key; supply --language-mapping manually.`,
        );
        continue;
      }
      remember(tag, folder);
    }
    const languageIndex = normalized.split("/").indexOf("{lang}");
    if (languageIndex < 0) {
      warnings.push(
        `${label}: language placeholder must be a whole folder name; supply target languages manually.`,
      );
    } else {
      const candidates = await glob(
        cwd,
        normalized.replace("{lang}", "*").replace("{path}", "**/*.json"),
      );
      for (const candidate of candidates) {
        const folder = candidate.split("/")[languageIndex];
        const mapped = Object.entries(mappings).find(([, value]) => value === folder);
        if (mapped) continue;
        const proposed = folder === "zh" ? "zh-Hans" : canonicalLanguageTag(folder);
        if (proposed === null) {
          warnings.push(`${label}: folder ${folder} needs an explicit --language-mapping entry.`);
          continue;
        }
        if (folder === "zh")
          proposals.push(
            "Folder zh: proposed zh-Hans (Simplified Chinese); check this before uploading.",
          );
        remember(proposed, folder);
      }
    }
    const exclude = Array.isArray(entry.ignore)
      ? entry.ignore
          .filter((pattern): pattern is string => typeof pattern === "string")
          .map((pattern) => pattern.replace(/^\/+/, ""))
      : undefined;
    files.push({ source, translation: normalized, ...(exclude?.length ? { exclude } : {}) });
    for (const key of Object.keys(entry)) {
      if (!["source", "translation", "languages_mapping", "ignore"].includes(key))
        warnings.push(`${label}.${key}: not converted; review manually.`);
    }
  }
  if (files.length === 0)
    throw usageError("No Crowdin file patterns could be converted.", {
      details: warnings.map((message) => ({ file: path, message })),
    });
  for (const key of Object.keys(document)) {
    if (
      ![
        "files",
        "base_path",
        "preserve_hierarchy",
        "project_id",
        "project_id_env",
        "api_token",
        "api_token_env",
        "base_url",
        "base_url_env",
      ].includes(key)
    )
      warnings.push(`${key}: not converted; review manually.`);
  }
  return {
    files,
    languages: [...languages].sort(),
    languageMapping,
    warnings: [...new Set(warnings)],
    proposals: [...new Set(proposals)],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
