// SPDX-License-Identifier: MIT
/**
 * `quaso init` (design §5.10, S4.4): writes a starter `quaso.config.json` from flags. It
 * never overwrites a config file, and asks nothing.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidLanguageTag } from "@quaso/core";
import { option, values } from "../args.ts";
import {
  canonical,
  CONFIG_FILE,
  describeFsError,
  findConfig,
  normalizePattern,
  parseConfig,
  serverUrl,
} from "../config.ts";
import type { Command, Context } from "../context.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { glob, globBase, hasMagic } from "../glob.ts";
import { count } from "../output.ts";
import { convertCrowdin } from "../crowdin.ts";

export const DEFAULT_FILES = "src/locales/{source}/**/*.json";

export const init: Command = {
  name: "init",
  summary: "Write a starter quaso.config.json; never overwrites one",
  description: [
    "Writes quaso.config.json in the current folder (or --cwd) from the options. It never " +
      "overwrites an existing file. When QUASO_HOSTNAME is set, the file's $schema points at " +
      "the instance's JSON Schema, for completion in editors.",
  ],
  options: [
    {
      name: "from-crowdin",
      type: "optional-string",
      value: "[file]",
      description:
        "Convert Crowdin YAML (default: crowdin.yml); infer languages from local exports",
    },
    {
      name: "languages",
      type: "list",
      value: "<langs>",
      description: "The languages to translate into, such as de,fr,pl (required)",
    },
    {
      name: "language-mapping",
      type: "list",
      value: "<tag=folder,…>",
      description: "Existing translation folder names, such as zh-Hans=zh,pt-PT=pt; repeatable",
    },
    {
      name: "source",
      type: "string",
      value: "<lang>",
      description: "The language of the source files (default: en)",
    },
    {
      name: "files",
      type: "string",
      value: "<glob>",
      description: `Where the source files are; {source} is the source language (default: ${DEFAULT_FILES})`,
    },
    {
      name: "translation",
      type: "string",
      value: "<pattern>",
      description:
        "Where translations go, with {lang} and {path} (default: the source " +
        "language's folder of --files replaced by {lang}, such as src/locales/{lang}/{path})",
    },
  ],
  exitCodes: [0, 1, 2],
  examples: [
    "quaso init --languages de,fr,pl",
    "quaso init --source en --languages de,ja --files 'public/locales/{source}/*.json'",
  ],
  async run(ctx: Context) {
    const target = join(ctx.cwd, CONFIG_FILE);
    const existing = await findConfig(ctx.cwd);
    if (existing === target) {
      throw usageError(`${CONFIG_FILE} already exists in ${ctx.cwd}; init never overwrites it.`, {
        code: "config_exists",
        hint: "Edit it, or delete it and run quaso init again.",
      });
    }

    const source = option(ctx.args, "source") ?? "en";
    if (!isValidLanguageTag(source)) {
      throw usageError(`--source ${source} isn't a valid BCP 47 language tag.`);
    }
    const crowdinPath = option(ctx.args, "from-crowdin");
    const converted =
      crowdinPath === undefined
        ? undefined
        : await convertCrowdin(ctx.cwd, crowdinPath || "crowdin.yml", source);
    for (const message of [...(converted?.warnings ?? []), ...(converted?.proposals ?? [])])
      ctx.out.warn(message);
    if (
      converted &&
      (option(ctx.args, "files") !== undefined || option(ctx.args, "translation") !== undefined)
    )
      throw usageError("--from-crowdin supplies file patterns; omit --files and --translation.");
    const requested = values(ctx.args, "languages");
    const languages = requested.length > 0 ? requested : (converted?.languages ?? []);
    if (languages.length === 0) {
      throw usageError("--languages is required: the languages to translate into.", {
        hint: "For example: quaso init --languages de,fr,pl",
      });
    }
    for (const language of languages) {
      if (!isValidLanguageTag(language)) {
        throw usageError(`--languages: ${language} isn't a valid BCP 47 language tag.`);
      }
      if (canonical(language) === canonical(source)) {
        throw usageError(`--languages: ${language} is the source language.`);
      }
    }

    const files = (option(ctx.args, "files") ?? DEFAULT_FILES).replaceAll("{source}", source);
    const normalized = normalizePattern(files);
    if (typeof normalized !== "string") throw usageError(`--files ${files} ${normalized.problem}.`);
    const translation =
      converted?.files[0].translation ??
      option(ctx.args, "translation") ??
      defaultTranslation(normalized, source);
    if (translation === null) {
      throw usageError(
        `--files ${files} has no folder named ${source}, so --translation is needed.`,
        { hint: "For example: --translation 'locales/{lang}/{path}'" },
      );
    }

    const config: Record<string, unknown> = {};
    if (ctx.env.QUASO_HOSTNAME?.trim()) {
      config.$schema = `${serverUrl(ctx.env)}/schema/config-v1.json`;
    }
    config.sourceLanguage = source;
    config.languages = languages;
    const languageMapping: Record<string, string> = {};
    for (const [tag, folder] of Object.entries(converted?.languageMapping ?? {})) {
      if (languages.some((language) => canonical(language) === canonical(tag)))
        languageMapping[tag] = folder;
    }
    const mappings = values(ctx.args, "language-mapping");
    if (mappings.length > 0) {
      const mapped = new Set<string>();
      for (const mapping of mappings) {
        const equals = mapping.indexOf("=");
        const tag = mapping.slice(0, equals);
        const folder = mapping.slice(equals + 1);
        if (equals < 1 || folder === "" || !isValidLanguageTag(tag))
          throw usageError(
            `--language-mapping ${mapping} must be a language tag followed by =folder.`,
          );
        const language = canonical(tag);
        if (!languages.some((target) => canonical(target) === language))
          throw usageError(`--language-mapping ${tag} is not one of --languages.`);
        if (mapped.has(language))
          throw usageError(`--language-mapping has more than one folder for ${tag}.`);
        mapped.add(language);
        languageMapping[language] = folder;
      }
    }
    if (Object.keys(languageMapping).length > 0) config.languageMapping = languageMapping;
    const fileMappings = converted?.files ?? [{ source: normalized, translation }];
    config.files = fileMappings;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const { problems } = parseConfig(text);
    if (problems.length > 0) {
      throw usageError("These options don't make a valid config.", {
        code: "invalid_config",
        details: problems,
      });
    }

    let found: string[];
    try {
      found = [
        ...new Set(
          (
            await Promise.all(
              fileMappings.map((mapping) =>
                glob(ctx.cwd, mapping.source, { exclude: mapping.exclude }),
              ),
            )
          ).flat(),
        ),
      ];
    } catch (error) {
      throw usageError(`--files ${files}: ${error instanceof Error ? error.message : error}.`);
    }
    if (converted && !ctx.out.json) ctx.out.print(text.trimEnd());
    try {
      await writeFile(target, text, { flag: "wx" });
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw usageError(`${CONFIG_FILE} already exists in ${ctx.cwd}; init never overwrites it.`, {
          code: "config_exists",
        });
      }
      throw new CliError(EXIT.unexpected, `Can't write ${target}: ${describeFsError(error)}.`, {
        code: "io",
      });
    }
    const sourcePatterns = fileMappings.map((mapping) => mapping.source).join(", ");
    const translationPatterns = fileMappings.map((mapping) => mapping.translation).join(", ");
    if (found.length === 0) ctx.out.warn(`${sourcePatterns} matches no files yet.`);
    if (existing !== null) {
      ctx.out.warn(`A parent folder has ${existing}; in ${ctx.cwd}, the new file applies instead.`);
    }

    return {
      exitCode: EXIT.ok,
      json: {
        path: target,
        config,
        sourceFiles: found,
        ...(converted ? { warnings: converted.warnings, proposals: converted.proposals } : {}),
      },
      render(out) {
        out.print(`Wrote ${target}`);
        out.print(`  Source language: ${source}`);
        out.print(`  Languages:       ${languages.join(", ")}`);
        out.print(`  Source files:    ${sourcePatterns} (${count(found.length, "file")} found)`);
        out.print(`  Translations:    ${translationPatterns}`);
        if (mappings.length > 0) out.print(`  Language folders: ${mappings.join(", ")}`);
        out.print();
        out.print("Next: set QUASO_HOSTNAME and QUASO_API_KEY, then run quaso upload.");
      },
    };
  },
};

/**
 * The translation pattern for a source glob: its static folder with the source language's
 * segment replaced by `{lang}`, then `{path}` (`src/locales/en/**\/*.json` →
 * `src/locales/{lang}/{path}`); for a single file named after the source language
 * (`locales/en.json`), the same file name with `{lang}`. Null when neither applies.
 */
export function defaultTranslation(files: string, source: string): string | null {
  if (!hasMagic(files)) {
    const segments = files.split("/");
    if (segments[segments.length - 1] === `${source}.json`) {
      segments[segments.length - 1] = "{lang}.json";
      return segments.join("/");
    }
  }
  const base = globBase(files);
  const segments = base === "" ? [] : base.split("/");
  const index = segments.lastIndexOf(source);
  if (index === -1) return null;
  segments[index] = "{lang}";
  return [...segments, "{path}"].join("/");
}
