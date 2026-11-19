// SPDX-License-Identifier: MIT
/**
 * Settings in `quaso.config.json`: an upload stores each one the config gives, over the value on
 * the instance. The repository is where they are reviewed, so the config always wins; settings
 * the config leaves out stay as they are.
 */
import {
  canonicalLanguageTag,
  type ProjectSettings,
  type RepositorySettings,
  type UploadRequest,
} from "@quaso/core";
import { toJson } from "./db.ts";
import { badRequest } from "./errors.ts";
import type { Language } from "./languages.ts";
import type { Statement } from "./ports.ts";
import { checkOverride, orderedSettingsValue, planSettingsChange } from "./settings_api.ts";

/** The project's settings after the upload, and the paths that changed, such as `llm.model`. */
export function planUploadSettings(
  current: ProjectSettings,
  request: UploadRequest,
): { settings: ProjectSettings; changed: string[] } {
  if (request.settings === undefined) return { settings: current, changed: [] };
  // A partial upload reads only some strings, so it can't run the checks a new syntax needs.
  if (request.partial) throw badRequest("An upload of some files can't change the settings.");
  const { languages: _languages, ...project } = request.settings;
  const { next } = planSettingsChange(current, project);
  const changed = changedPaths(current, next, "");
  return { settings: changed.length === 0 ? current : next, changed };
}

/**
 * Each language's instructions and plural override after the upload. `languages` already holds
 * the languages the upload adds.
 */
export function planUploadLanguages(
  languages: readonly Language[],
  requested: RepositorySettings["languages"],
): { languages: Language[]; statements: Statement[]; changed: string[]; pluralsChanged: boolean } {
  const next = languages.map((language) => ({ ...language }));
  const statements: Statement[] = [];
  const changed: string[] = [];
  let pluralsChanged = false;
  for (const [tag, patch] of Object.entries(requested ?? {})) {
    const language = next.find((entry) => entry.tag === (canonicalLanguageTag(tag) ?? tag));
    if (language === undefined) {
      throw badRequest(`settings.languages names ${tag}, which isn't a language of the project.`, [
        { path: `settings.languages.${tag}`, message: "must be one of the project's languages" },
      ]);
    }
    const before = changed.length;
    if (patch.instructions !== undefined && patch.instructions !== language.instructions) {
      language.instructions = patch.instructions;
      changed.push(`languages.${language.tag}.instructions`);
    }
    if (patch.pluralOverride !== undefined) {
      const override = checkOverride(patch.pluralOverride);
      if (toJson(override) !== toJson(language.pluralOverride ?? null)) {
        language.pluralOverride = override ?? undefined;
        changed.push(`languages.${language.tag}.pluralOverride`);
        pluralsChanged = true;
      }
    }
    if (changed.length === before) continue;
    statements.push({
      sql: "UPDATE languages SET instructions = ?, plural_override = ? WHERE tag = ?",
      params: [
        language.instructions,
        language.pluralOverride === undefined ? null : toJson(language.pluralOverride),
        language.tag,
      ],
    });
  }
  return { languages: next, statements, changed, pluralsChanged };
}

/** The paths of the values that differ; objects are compared field by field, arrays whole. */
function changedPaths(before: unknown, after: unknown, path: string): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    return Object.keys(after).flatMap((key) =>
      changedPaths(before[key], after[key], path === "" ? key : `${path}.${key}`),
    );
  }
  const same = toJson(orderedSettingsValue(before)) === toJson(orderedSettingsValue(after));
  return same ? [] : [path];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
