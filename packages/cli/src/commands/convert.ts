// SPDX-License-Identifier: MIT
/**
 * `quaso convert-to-icu`: moves a project from i18next to ICU MessageFormat on the instance
 * and in the source files together. The instance converts its strings, translations and
 * suggestions (`POST /conversions/icu`); the CLI converts the source files in place with the
 * same core function (`sourceFileToIcu`), so `quaso upload` afterwards changes nothing.
 *
 * Both sides convert alike only from the same English, so the source files must match the
 * instance's first: an upload's dry run compares them, before writing and after. A project
 * converted already, whose files weren't (an interrupted run, another checkout), gets its
 * files converted when that makes them match.
 */
import {
  type IcuConversionResult,
  type InterpolationSyntax,
  type ProjectInfo,
  sourceFileToIcu,
  type UploadRequest,
  type UploadResult,
} from "@quaso/core";
import { flag } from "../args.ts";
import type { Project } from "../config.ts";
import { type Command, type Context, localizeError } from "../context.ts";
import { CliError, EXIT, type Problem, usageError } from "../errors.ts";
import { absolutePath, type Sources } from "../files.ts";
import { utf8, writeAtomic } from "../fs.ts";
import { type ApiClient, LONG_TIMEOUT_MS, problemFromDetail } from "../http.ts";
import { count, formatProblem, type Output, table } from "../output.ts";
import { readUploadFiles, uploadRequest } from "./upload.ts";

/** How many items each list shows in text mode; `--json` has them all. */
const MAX_LISTED = 25;

const KEY_HINT =
  "Converting needs an API key with the upload scope that an administrator created " +
  "(Account → API keys), or one from quaso token create on the server.";

export const convertToIcu: Command = {
  name: "convert-to-icu",
  summary: "Convert the project and its source files from i18next to ICU MessageFormat",
  description: [
    "Converts the instance, then the source files in place: {{name}} becomes {name}, plural " +
      "keys such as coins_one and coins_other become one coins string with a plural block, " +
      "and braces, # and apostrophes are quoted where ICU would read them as syntax. Every " +
      "translation and pending suggestion is converted too, keeping its colour, author and " +
      "history, and the project's ICU MessageFormat setting is turned on.",
    "The source files must match the instance's (quaso upload would change nothing); " +
      "afterwards they still do. Then run quaso download for the converted translations, " +
      "and commit both with your app's switch to an ICU formatter.",
    "Text that ICU MessageFormat can't say, such as $t() nesting or {{price, number}}, is " +
      "refused: nothing changes until it is fixed. --dry-run lists the refusals and " +
      "everything else that would change, and changes nothing.",
    "It needs an API key with the upload scope that an administrator created.",
  ],
  options: [
    {
      name: "dry-run",
      type: "boolean",
      description: "Report what would change on the instance and in the files; change nothing",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 5, 6],
  examples: ["quaso convert-to-icu --dry-run", "quaso convert-to-icu", "quaso convert-to-icu --json"],
  async run(ctx: Context) {
    const project = await ctx.project();
    const sources = await ctx.sources();
    const dryRun = flag(ctx.args, "dry-run");
    const client = ctx.client(project);
    const files = await readUploadFiles(project, sources.files);
    ctx.out.info(
      `${dryRun ? "Checking" : "Converting"} ${client.baseUrl} and ` +
        `${count(files.length, "source file")} for ICU MessageFormat…`,
    );
    const instance = new Instance(client, project, sources);
    const { syntax } = await instance.project();
    if (syntax.icu) return convertedBefore(project, sources, instance, files, syntax, dryRun);

    if (differences(await instance.compare(files)) > 0) {
      throw sourcesDiffer("The source files differ from the instance's.");
    }
    const local = convertFiles(project, sources, files, syntax);
    const ready = local.refusals.length === 0 && !dryRun;
    const result = await instance.convert(!ready);
    // Someone else converted the instance meanwhile.
    if (result.alreadyIcu) return convertedBefore(project, sources, instance, files, syntax, dryRun);
    if (result.converted) {
      await writeConverted(project, local, "Run quaso convert-to-icu again to convert them.");
      warnAboutRepositoryTranslations(ctx, project);
    }
    const sourcesMatch = result.converted
      ? differences(await instance.compare(local.files)) === 0
      : null;
    const refusals = [
      ...local.refusals,
      ...result.refusals.map((detail) => instance.problem(detail)),
    ];
    const report: ConversionReport = {
      server: client.baseUrl,
      dryRun,
      converted: result.converted,
      alreadyIcu: false,
      instance: result,
      files: local.report,
      refusals,
      sourcesMatch,
    };
    return {
      exitCode: refusals.length > 0 ? EXIT.refused : EXIT.ok,
      json: report,
      render: (out) => renderConversion(out, report, instance),
    };
  },
};

/** What the command reports: the instance's result, and the files'. */
interface ConversionReport {
  server: string;
  dryRun: boolean;
  /** Whether this run converted the instance, or the files to match an instance converted before. */
  converted: boolean;
  /** The instance was on ICU MessageFormat before this run. */
  alreadyIcu: boolean;
  /** The instance's result; null when it was on ICU MessageFormat already. */
  instance: IcuConversionResult | null;
  files: FileReport[];
  /** What stops the conversion, in the files and on the instance, by local path. */
  refusals: Problem[];
  /** Whether `quaso upload` would change nothing now; null when nothing was converted. */
  sourcesMatch: boolean | null;
}

interface FileReport {
  /** The local path. */
  file: string;
  /** Whether the conversion rewrites it. */
  changed: boolean;
  /** The plural groups merged into one string each, by their key. */
  merged: string[];
  escapes: number;
}

/**
 * A project the instance converted before: done when the files match it as they are;
 * otherwise the files are converted, if that makes them match.
 */
async function convertedBefore(
  project: Project,
  sources: Sources,
  instance: Instance,
  files: UploadRequest["files"],
  syntax: InterpolationSyntax,
  dryRun: boolean,
) {
  const report: ConversionReport = {
    server: instance.baseUrl,
    dryRun,
    converted: false,
    alreadyIcu: true,
    instance: null,
    files: [],
    refusals: [],
    sourcesMatch: true,
  };
  const done = {
    exitCode: EXIT.ok,
    json: report,
    render: (out: Output) => renderConversion(out, report, instance),
  };
  if (differences(await instance.compare(files)) === 0) return done;
  const local = convertFiles(project, sources, files, { ...syntax, icu: false });
  const matching = local.refusals.length === 0 && differences(await instance.compare(local.files)) === 0;
  if (!matching) {
    throw sourcesDiffer(
      "The project is on ICU MessageFormat already, but the source files differ from the instance's, converted or not.",
    );
  }
  if (!dryRun) await writeConverted(project, local, "Run quaso convert-to-icu again.");
  report.converted = !dryRun;
  report.files = local.report;
  return done;
}

/** Upload imports these languages' files, which keep i18next syntax until a download. */
function warnAboutRepositoryTranslations(ctx: Context, project: Project): void {
  const languages = project.config.translationsInRepository ?? [];
  if (languages.length === 0) return;
  ctx.out.warn(
    `Run quaso download before the next quaso upload: upload imports the translation files of ` +
      `${languages.join(", ")} from the repository, which are in i18next syntax until then.`,
  );
}

/** The instance, as this command calls it: errors name local paths. */
class Instance {
  readonly #client: ApiClient;
  readonly #project: Project;
  readonly #sources: Sources;

  constructor(client: ApiClient, project: Project, sources: Sources) {
    this.#client = client;
    this.#project = project;
    this.#sources = sources;
  }

  get baseUrl(): string {
    return this.#client.baseUrl;
  }

  project(): Promise<ProjectInfo> {
    return this.#call(() => this.#client.get<ProjectInfo>("/project"));
  }

  /** An upload's dry run of these files: what `quaso upload` would change. */
  compare(files: UploadRequest["files"]): Promise<UploadResult> {
    const request = { ...uploadRequest(this.#project, files), dryRun: true };
    return this.#call(() =>
      this.#client.post<UploadResult>("/sources", request, {
        timeoutMs: LONG_TIMEOUT_MS,
        retry: "safe",
      }),
    );
  }

  convert(dryRun: boolean): Promise<IcuConversionResult> {
    return this.#call(() =>
      this.#client.post<IcuConversionResult>(
        "/conversions/icu",
        { dryRun },
        { timeoutMs: LONG_TIMEOUT_MS, retry: dryRun ? "safe" : "once" },
      ),
    );
  }

  /** The local path of a file the instance names. */
  local(file: string): string {
    return this.#sources.byServer.get(file)?.local ?? file;
  }

  /** A detail of the instance's result as a problem, with its local path. */
  problem(detail: Parameters<typeof problemFromDetail>[0]): Problem {
    const problem = problemFromDetail(detail);
    if (problem.file !== undefined) problem.file = this.local(problem.file);
    return problem;
  }

  async #call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const localized = localizeError(error, (file) => this.local(file), {
        configName: this.#project.configName,
      });
      if (localized instanceof CliError && localized.code === "forbidden") {
        throw new CliError(EXIT.auth, localized.message, {
          code: localized.code,
          status: localized.status,
          details: localized.details,
          hint: KEY_HINT,
        });
      }
      throw localized;
    }
  }
}

/** The source files converted in memory, as upload files, and what changed in each. */
interface LocalConversion {
  files: UploadRequest["files"];
  report: FileReport[];
  refusals: Problem[];
}

function convertFiles(
  project: Project,
  sources: Sources,
  files: UploadRequest["files"],
  syntax: InterpolationSyntax,
): LocalConversion {
  const { config } = project;
  const local: LocalConversion = { files: [], report: [], refusals: [] };
  for (const file of files) {
    const path = sources.byServer.get(file.path)!.local;
    const exclusions = (config.pluralExclusions ?? []).filter((item) => item.file === file.path);
    const converted = sourceFileToIcu(file.content, {
      file: path,
      syntax,
      language: config.sourceLanguage,
      pluralExclusions: exclusions.map((item) => item.key),
      descriptionSuffix: config.descriptionSuffix,
    });
    local.files.push({ ...file, content: converted.text });
    local.report.push({
      file: path,
      changed: converted.text !== file.content,
      merged: converted.merged,
      escapes: converted.escapes,
    });
    for (const refusal of converted.refusals) local.refusals.push({ file: path, ...refusal });
  }
  return local;
}

/** Writes the converted files; a failure says what the instance has, and `again` what to do. */
async function writeConverted(project: Project, local: LocalConversion, again: string) {
  try {
    for (const [index, file] of local.files.entries()) {
      if (!local.report[index].changed) continue;
      await writeAtomic(absolutePath(project, file.repoPath), utf8(file.content));
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(error.exitCode, error.message, {
      code: error.code,
      hint: `The instance is on ICU MessageFormat, but some source files aren't. ${again}`,
    });
  }
}

/** How many strings and files an upload's dry run would change. */
function differences(result: UploadResult): number {
  let changes = result.hiddenFiles.length;
  for (const file of result.files) {
    changes += file.added + file.changed + file.removed + file.restored + file.moved;
  }
  return changes;
}

function sourcesDiffer(message: string): CliError {
  return usageError(message, {
    code: "sources_differ",
    hint:
      "Both convert alike only from the same English: quaso upload --dry-run lists the " +
      "differences. Upload the files, or check out the ones the instance has, then convert.",
  });
}

function renderConversion(out: Output, report: ConversionReport, instance: Instance): void {
  const { bold, dim, yellow, red, green } = out.out;
  if (report.dryRun) {
    out.print(yellow("Dry run: nothing was changed."));
    out.print();
  }
  const list = (title: string, problems: Problem[]) => {
    if (problems.length === 0) return;
    out.print();
    out.print(bold(`${title} (${problems.length}):`));
    for (const problem of problems.slice(0, MAX_LISTED)) out.print(`  ${formatProblem(problem)}`);
    if (problems.length > MAX_LISTED) {
      out.print(dim(`  … and ${problems.length - MAX_LISTED} more (--json lists them all)`));
    }
  };
  const result = report.instance;
  if (result !== null) {
    out.print(bold("On the instance:"));
    out.print(
      `  ${result.converted ? "Changed" : "Would change"}: ${count(result.strings, "string")}, ` +
        `${count(result.translations, "translation")}, ` +
        `${count(result.suggestions, "pending suggestion")}`,
    );
    out.print(`  Plural groups merged into one string each: ${result.merged.length}`);
    out.print(`  Characters quoted or doubled to stay text: ${result.escapes}`);
    list(
      "Texts with quoted characters, to review",
      result.escaped.map((text) => instance.problem({ ...text, message: "" })),
    );
    list(
      "Translations that fail the ICU checks: they stay, with their errors",
      result.failing.map((detail) => instance.problem(detail)),
    );
  }
  const rows = report.files.map((file) => [
    file.file,
    file.changed ? "converted" : dim("unchanged"),
    file.merged.length > 0 ? `${count(file.merged.length, "plural group")} merged` : "",
  ]);
  if (rows.length > 0) {
    out.print();
    out.print(bold("Source files:"));
    for (const line of table(rows)) out.print(`  ${line}`.trimEnd());
  }
  list("Refused: fix these, then convert", report.refusals);
  out.print();
  if (report.refusals.length > 0) {
    out.print(red("Nothing was converted."));
    return;
  }
  const filesLeft = report.files.some((file) => file.changed);
  if (report.alreadyIcu && !filesLeft) {
    out.print("Nothing to do: the project and its source files are on ICU MessageFormat already.");
    return;
  }
  if (report.dryRun) {
    out.print("Run without --dry-run to convert.");
    return;
  }
  if (report.alreadyIcu) {
    out.print(green("Converted the source files to match the instance, on ICU MessageFormat already."));
  } else {
    out.print(green(`Converted to ICU MessageFormat (revision ${result!.revision}).`));
  }
  if (report.sourcesMatch === false) {
    out.print(yellow("quaso upload --dry-run still finds changes: check them before uploading."));
  }
  out.print(
    "Next: run quaso download, then commit the source files and translations together with " +
      "your app's switch to an ICU formatter.",
  );
}
