// SPDX-License-Identifier: MIT
/**
 * `quaso import` (design §5.10, S4.8, CLI-7): reads the translation files the config points
 * to and sends them, one language at a time, as green or blue. The instance skips values
 * identical to the English (unless `--keep-identical`), keeps blue translations (unless
 * `--overwrite`), and refuses values that fail the quality checks: they are listed, and the
 * exit code is 6.
 */
import type { CheckResult, ImportRequest, ImportResult, ProjectInfo } from "@quaso/core";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { flag, option, values } from "../args.ts";
import { canonical, describeFsError, type Project } from "../config.ts";
import { type Command, type Context, localizeError } from "../context.ts";
import { CliError, EXIT, type ExitCode, type Problem, usageError } from "../errors.ts";
import { selectTranslations, translationPath } from "../files.ts";
import { readProjectText } from "../fs.ts";
import { type ApiClient, LONG_TIMEOUT_MS } from "../http.ts";
import { count, formatProblem, type Output, sentenceFragment } from "../output.ts";

export interface LanguageImport extends ImportResult {
  /** The files sent: the server path and the local path. */
  files: { file: string; path: string }[];
}

export interface ImportSummary {
  server: string;
  dryRun: boolean;
  as: "green" | "blue";
  languages: LanguageImport[];
  /** Languages without any translation file. */
  withoutFiles: string[];
  /** Every refused value's error checks, with local paths. */
  refused: Problem[];
  /** Keys the English doesn't have, with local paths. */
  unknownKeys: Problem[];
  /** Translation files that aren't valid JSON (exit code 5). */
  invalid: Problem[];
  /**
   * Languages whose import failed after others were imported (exit code 6), with the
   * error; `not_sent` when an earlier failure stopped the import.
   */
  failed: {
    language: string;
    code: string;
    message: string;
    exitCode?: ExitCode;
    details?: Problem[];
  }[];
}

export const importCommand: Command = {
  name: "import",
  summary: "Import existing translation files as green or blue",
  description: [
    "Reads the translation files that quaso.config.json points to and sends them to the " +
      "instance, one language at a time, as green (translated, not proofread) or blue " +
      "(proofread). Run it after quaso upload: keys the English doesn't have are skipped and " +
      "listed.",
    "Values identical to the English are skipped, because tools such as Crowdin write the " +
      "English into untranslated entries; --keep-identical keeps them. Blue translations on " +
      "the instance stay unless --overwrite is given. Values that fail the quality checks " +
      "are refused and listed, and the exit code is 6.",
  ],
  options: [
    {
      name: "from",
      type: "string",
      value: "<folder>",
      description: "Read translation patterns under this existing folder instead of the project",
    },
    {
      name: "as",
      type: "string",
      value: "<colour>",
      choices: ["green", "blue"],
      description: "green (translated, not proofread) or blue (proofread); required",
    },
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
        "Only this file: a server path or a source file's local path (in every " +
        "language), or a translation file's local path (in its language); repeatable",
    },
    {
      name: "overwrite",
      type: "boolean",
      description: "Also replace blue (proofread) translations",
    },
    {
      name: "keep-identical",
      type: "boolean",
      description: "Keep values identical to the English instead of skipping them",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Show what would be imported without saving anything",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 5, 6],
  examples: [
    "quaso import --as blue --language de",
    "quaso import --as blue --from /tmp/crowdin-approved",
    "quaso import --as green --dry-run",
    "quaso import --as green --file src/locales/fr/common.json --keep-identical",
  ],
  async run(ctx: Context) {
    const as = option(ctx.args, "as") as "green" | "blue" | undefined;
    if (as === undefined) {
      throw usageError("--as is required: green (translated) or blue (proofread).", {
        hint: "For example: quaso import --as green",
      });
    }
    const project = await ctx.project();
    const from = option(ctx.args, "from");
    let inputProject = project;
    if (from !== undefined) {
      const dir = resolve(ctx.cwd, from);
      let folder;
      try {
        folder = await stat(dir);
      } catch (error) {
        throw usageError(`Can't read --from ${from}: ${describeFsError(error)}.`);
      }
      if (!folder.isDirectory()) throw usageError(`--from ${from} is not a folder.`);
      // Keep discovery and identity in the project; only translation reads use this root.
      inputProject = { ...project, dir };
    }
    const sources = await ctx.sources();
    const selection = selectTranslations(
      project,
      sources,
      ctx.cwd,
      values(ctx.args, "language"),
      values(ctx.args, "file"),
    );
    const dryRun = flag(ctx.args, "dry-run");
    const client = ctx.client(project);
    const summary: ImportSummary = {
      server: client.baseUrl,
      dryRun,
      as,
      languages: [],
      withoutFiles: [],
      refused: [],
      unknownKeys: [],
      invalid: [],
      failed: [],
    };

    // Read every language's files first: one that can't be read safely (a link out of the
    // project) stops the command before anything is sent.
    const batches: {
      language: string;
      files: ImportRequest["files"];
      local: Map<string, string>;
    }[] = [];
    for (const language of selection.languages) {
      const files: ImportRequest["files"] = [];
      const local = new Map<string, string>();
      for (const source of selection.files ?? sources.files) {
        if (!selection.wants(source.server, language)) continue;
        const path = translationPath(project, source, language);
        try {
          const content = await readProjectText(inputProject, path);
          if (content === null) continue;
          files.push({ path: source.server, content });
          local.set(source.server, from === undefined ? path : resolve(inputProject.dir, path));
        } catch (error) {
          if (!(error instanceof CliError) || error.exitCode !== EXIT.invalidSource) throw error;
          summary.invalid.push(...error.details.map((detail) => ({ ...detail, language })));
        }
      }
      if (files.length === 0) summary.withoutFiles.push(language);
      else batches.push({ language, files, local });
    }
    if (batches.length > 0)
      await checkLanguages(
        client,
        project,
        batches.map((b) => b.language),
      );

    const sent = new Set<string>();
    for (const { language, files, local } of batches) {
      sent.add(language);
      ctx.out.info(
        `${dryRun ? "Checking" : "Importing"} ${language} (${count(
          files.length,
          "file",
        )}) as ${as}…`,
      );
      const request: ImportRequest = { language, files, as };
      if (flag(ctx.args, "overwrite")) request.overwrite = true;
      if (flag(ctx.args, "keep-identical")) request.keepIdentical = true;
      if (dryRun) request.dryRun = true;
      let result: ImportResult;
      try {
        result = await client.post<ImportResult>("/imports", request, {
          timeoutMs: LONG_TIMEOUT_MS,
          retry: dryRun ? "safe" : "idempotent",
        });
      } catch (error) {
        localizeError(error, (file) => local.get(file), { language });
        if (!(error instanceof CliError)) throw error;
        if (error.code === "invalid_source") {
          summary.invalid.push(...error.details);
          continue;
        }
        // Languages already imported stay imported: the summary says which, and which failed.
        if (summary.languages.length === 0 && summary.failed.length === 0) throw error;
        summary.failed.push(failure(language, error));
        ctx.out.error(error);
        // The next languages would fail the same way.
        if (error.exitCode === EXIT.auth || error.exitCode === EXIT.network) break;
        continue;
      }
      const pathOf = (file: string) => local.get(file) ?? file;
      summary.languages.push({
        ...result,
        files: files.map((file) => ({ file: file.path, path: pathOf(file.path) })),
      });
      for (const refused of result.refused) {
        for (const check of errorChecks(refused.checks)) {
          summary.refused.push({
            file: pathOf(refused.file),
            key: refused.key,
            language: refused.language,
            check: check.check,
            message: checkMessage(check),
          });
        }
      }
      for (const unknown of result.unknownKeys) {
        summary.unknownKeys.push({
          file: pathOf(unknown.file),
          key: unknown.key,
          language: result.language,
          message: "not in the English, so it was skipped (upload the English first)",
        });
      }
    }
    for (const { language } of batches) {
      if (sent.has(language)) continue;
      summary.failed.push({
        language,
        code: "not_sent",
        message: "Not sent, because of the error before it.",
      });
    }

    const exitCode: ExitCode =
      summary.invalid.length > 0
        ? EXIT.invalidSource
        : summary.refused.length > 0 || summary.failed.length > 0
          ? EXIT.refused
          : EXIT.ok;
    return { exitCode, json: summary, render: (out: Output) => renderImport(out, summary) };
  },
};

/** A language whose import failed, for the summary. */
function failure(language: string, error: CliError): ImportSummary["failed"][number] {
  const failed: ImportSummary["failed"][number] = {
    language,
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
  };
  if (error.details.length > 0) failed.details = error.details;
  return failed;
}

/**
 * Checks that the instance has every language to import, before importing any (so that a
 * missing one doesn't stop the import halfway): exit code 2 when it lacks one.
 */
async function checkLanguages(
  client: ApiClient,
  project: Project,
  languages: string[],
): Promise<void> {
  const info = await client.get<ProjectInfo>("/project");
  const available = new Set(info.languages.map((language) => canonical(language.tag)));
  const missing = languages.filter((language) => !available.has(language));
  if (missing.length === 0) return;
  const inConfig = missing.every((language) => project.languages.includes(language));
  throw usageError(`The instance has no language ${missing.join(", ")}, so nothing was imported.`, {
    code: "unknown_language",
    details: missing.map((language) => ({
      language,
      message: "the instance doesn't have this language",
    })),
    hint: inConfig
      ? `quaso upload adds the languages of ${project.configName} to the instance.`
      : `Add ${missing.join(", ")} to languages in ${project.configName}, then run ` +
        "quaso upload, which adds them to the instance.",
  });
}

/** The checks that refused a value: its errors (all of them, if none is marked an error). */
function errorChecks(checks: CheckResult[]): CheckResult[] {
  const errors = checks.filter((check) => check.severity === "error");
  return errors.length > 0 ? errors : checks;
}

/** A check's message, naming the plural form when it isn't already named. */
function checkMessage(check: CheckResult): string {
  if (check.form && !check.message.includes(check.form)) {
    return `${check.form} form: ${check.message}`;
  }
  return check.message;
}

function renderImport(out: Output, summary: ImportSummary): void {
  const { bold, dim, red, yellow } = out.out;
  if (summary.dryRun) out.print(yellow("Dry run: nothing was saved."));
  for (const result of summary.languages) {
    const parts = [
      `${result.imported} ${summary.dryRun ? "to import" : "imported"} as ${summary.as}`,
      `${result.unchanged} unchanged`,
    ];
    if (result.skippedIdentical > 0) {
      parts.push(`${result.skippedIdentical} identical to the English (skipped)`);
    }
    if (result.droppedForms > 0) {
      parts.push(`${result.droppedForms} unused plural forms dropped`);
    }
    if (result.skippedBlue > 0) parts.push(`${result.skippedBlue} proofread kept`);
    if (result.refused.length > 0) parts.push(red(`${result.refused.length} refused`));
    if (result.unknownKeys.length > 0) parts.push(`${result.unknownKeys.length} unknown keys`);
    out.print(`${bold(result.language.padEnd(6))} ${parts.join(", ")}`);
    for (const file of result.unknownFiles) {
      out.print(dim(`       ${file}: the instance has no such file, so it was skipped`));
    }
  }
  if (summary.withoutFiles.length > 0) {
    out.print(dim(`No translation files for ${summary.withoutFiles.join(", ")}.`));
  }
  const section = (title: string, problems: Problem[]) => {
    if (problems.length === 0) return;
    out.print();
    out.print(bold(`${title} (${problems.length}):`));
    for (const problem of problems) out.print(`  ${formatProblem(problem)}`);
  };
  if (summary.failed.length > 0) {
    out.print();
    out.print(red(bold(`Languages not imported (${summary.failed.length}):`)));
    for (const failed of summary.failed) {
      out.print(`  ${failed.language}: ${sentenceFragment(failed.message)}`);
    }
    out.print(dim("The other languages were imported; import these again with --language."));
  }
  section("Refused by the quality checks", summary.refused);
  section("Keys the English doesn't have", summary.unknownKeys);
  section("Files that can't be read (fix them and import again)", summary.invalid);
  if (summary.refused.length > 0 && !summary.dryRun) {
    out.print(dim("The other values were imported; fix these and import again."));
  }
}
