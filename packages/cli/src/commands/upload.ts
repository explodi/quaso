// SPDX-License-Identifier: MIT
/**
 * `quaso upload` (design §5.5, §5.10, S4.5): sends the source files unchanged, each with its
 * server path, and reports what was added, changed and removed. The server parses them, so
 * a parser fix never needs a new CLI.
 */
import {
  readSource,
  readTranslation,
  entryKey,
  formatKeyPath,
  isTranslatable,
  type ImportResult,
  type JobInfo,
  type Rename,
  type UploadRequest,
  type UploadResult,
} from "@quaso/core";
import { flag, values } from "../args.ts";
import { canonical, type Project } from "../config.ts";
import { type Command, type Context, localizeError } from "../context.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import { resolveFileArgs, translationPath, type SourceFile, type Sources } from "../files.ts";
import { readProjectText } from "../fs.ts";
import { LONG_TIMEOUT_MS } from "../http.ts";
import { jobJson, localFailures, renderJob, type WaitedJob, waitForJob } from "../jobs.ts";
import { commandLine, count, type Output, table } from "../output.ts";

/** How many keys each list shows in text mode; `--json` has them all. */
const MAX_LISTED = 25;

export const upload: Command = {
  name: "upload",
  summary: "Send the source files and report what was added, changed and removed",
  description: [
    "Reads every source file that quaso.config.json points to and sends it to the instance, " +
      "with the config's languages (the instance adds those it lacks), length limits and " +
      "plural exclusions. Files missing from a full upload are hidden on the instance, never " +
      "deleted; with --file, only the files named are compared.",
    "When a removed key and an added key have the same English, the output suggests a " +
      "rename and prints the command that moves the translations and their history.",
    "When the instance translates new and changed strings automatically, the upload queues " +
      "a translation job; --wait waits for it like quaso translate, and exits with code 6 " +
      "when strings failed.",
  ],
  options: [
    {
      name: "import-translations",
      type: "list",
      value: "<lang[:blue|green]>",
      description: "Import selected local translation files in this run (default: blue)",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Compute and show the changes without saving them",
    },
    {
      name: "file",
      type: "multiple",
      value: "<path>",
      description:
        "Upload only this source file (a server path such as common.json, or a local path); " +
        "repeatable. Other files stay as they are",
    },
    {
      name: "rename",
      type: "multiple",
      value: "<old=new>",
      description:
        "Move a key's translations and history to its new name: old=new or " +
        "file:old=new; repeatable. Keys shared by several strings take #text, #plural, " +
        '#ordinal, or a JSON array key path such as ["a.b"]; a key with = in it is ' +
        'written as a JSON string, such as "x = y"',
    },
    {
      name: "wait",
      type: "boolean",
      description:
        "Wait for the automatic translation job the upload queues, if any, and " +
        "list the strings that failed (exit code 6)",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 5, 6],
  examples: [
    "quaso upload",
    "quaso upload --dry-run",
    "quaso upload --file common.json",
    "quaso upload --rename menu.start=menu.play",
    "quaso upload --wait",
    "quaso upload --json",
  ],
  async run(ctx: Context) {
    const project = await ctx.project();
    const sources = await ctx.sources();
    const dryRun = flag(ctx.args, "dry-run");
    const named = values(ctx.args, "file");
    const selected =
      named.length > 0 ? resolveFileArgs(project, sources, ctx.cwd, named) : sources.files;
    const renames = values(ctx.args, "rename").map((value) =>
      parseRename(value, (file) => resolveFileArgs(project, sources, ctx.cwd, [file])[0].server),
    );
    const client = ctx.client(project);

    const files: UploadRequest["files"] = [];
    const invalid: CliError[] = [];
    for (const source of selected) {
      try {
        const content = await readProjectText(project, source.local);
        if (content === null) {
          throw usageError(`${source.local} disappeared while the upload was being prepared.`);
        }
        const descriptions = await readProjectText(
          project,
          source.local.replace(/\.json$/, ".descriptions.json"),
        );
        files.push({
          path: source.server,
          repoPath: source.local,
          content,
          ...(descriptions === null ? {} : { descriptions }),
        });
      } catch (error) {
        if (error instanceof CliError && error.exitCode === EXIT.invalidSource) invalid.push(error);
        else throw error;
      }
    }
    if (invalid.length > 0) {
      throw new CliError(
        EXIT.invalidSource,
        `${count(invalid.length, "source file")} can't be read.`,
        {
          code: "invalid_source",
          details: invalid.flatMap((error) => error.details),
        },
      );
    }

    const repository = await repositoryTranslations(project, selected, files);
    const importLanguages = new Map<string, { as: "blue" | "green"; overwrite: boolean }>();
    for (const tag of project.config.translationsInRepository ?? [])
      importLanguages.set(canonical(tag), { as: "blue", overwrite: true });
    for (const option of values(ctx.args, "import-translations")) {
      const [tag, colour = "blue", extra] = option.split(":");
      const language = canonical(tag);
      const invalid =
        !project.languages.includes(language) ||
        (colour !== "blue" && colour !== "green") ||
        extra !== undefined;
      if (invalid)
        throw usageError(
          `--import-translations ${option}: use a configured language with :blue or :green.`,
        );
      if (!importLanguages.has(language))
        importLanguages.set(language, { as: colour as "blue" | "green", overwrite: false });
    }
    const { config } = project;
    const request: UploadRequest = {
      files,
      sourceLanguage: config.sourceLanguage,
      languages: config.languages,
    };
    if (named.length > 0) request.partial = true;
    if (dryRun) request.dryRun = true;
    if (renames.length > 0) request.renames = renames;
    if (config.limits) request.limits = config.limits;
    if (config.pluralExclusions) request.pluralExclusions = config.pluralExclusions;
    if (config.descriptionSuffix) request.descriptionSuffix = config.descriptionSuffix;

    ctx.out.info(
      `${dryRun ? "Comparing" : "Uploading"} ${count(files.length, "file")} ${
        dryRun ? "with" : "to"
      } ${client.baseUrl}…`,
    );
    let result: UploadResult;
    try {
      result = await client.post<UploadResult>("/sources", request, {
        timeoutMs: LONG_TIMEOUT_MS,
        retry: dryRun ? "safe" : renames.length > 0 ? "once" : "idempotent",
      });
    } catch (error) {
      throw uploadError(error, project, sources);
    }
    const localTranslations = localTranslationReport(repository, result);
    const imports: (
      | ImportResult
      | { language: string; as: string; dryRun: true; files: string[] }
    )[] = [];
    for (const [language, options] of importLanguages) {
      const local = repository.filter((file) => file.language === language);
      if (local.length === 0) continue;
      if (dryRun) {
        imports.push({
          language,
          as: options.as,
          dryRun: true,
          files: local.map((file) => file.path),
        });
        continue;
      }
      imports.push(
        await client.post<ImportResult>(
          "/imports",
          {
            language,
            as: options.as,
            overwrite: options.overwrite,
            keepIdentical: options.overwrite,
            files: local.map(({ path, content }) => ({ path, content })),
          },
          { timeoutMs: LONG_TIMEOUT_MS, retry: "idempotent" },
        ),
      );
    }
    const wait = flag(ctx.args, "wait");
    const json = uploadJson(result, sources);
    let waited: WaitedJob | null = null;
    if (wait && result.job !== null && !result.dryRun) {
      const first = await client.get<JobInfo>(`/jobs/${result.job.id}`);
      waited = await waitForJob(
        client,
        first,
        ctx.out,
        (ms) => ctx.sleep(ms),
        (job) => localFailures(job, project, sources),
      );
    }
    return {
      exitCode: imports.some((result) => "refused" in result && result.refused.length > 0)
        ? EXIT.refused
        : (waited?.exitCode ?? EXIT.ok),
      json: {
        server: client.baseUrl,
        ...json,
        localTranslations,
        imports,
        wait: wait ? (waited ? jobJson(waited) : { job: null, note: waitNote(result) }) : undefined,
      },
      render: (out) => {
        renderUpload(out, result, sources, wait);
        for (const report of localTranslations) {
          out.print(
            `${count(report.strings, "new or changed string")} already ${report.strings === 1 ? "has" : "have"} ${report.language} in repository files.`,
          );
          if (!importLanguages.has(report.language)) out.print(`Import them: ${report.command}`);
        }
        for (const imported of imports) {
          if ("imported" in imported) {
            out.print(
              `Imported ${imported.imported} ${imported.language} translations; ${imported.refused.length} refused.`,
            );
            for (const refusal of imported.refused)
              for (const check of refusal.checks)
                out.print(
                  `  ${refusal.language} ${refusal.file} › ${refusal.key}: ${check.message}`,
                );
          } else
            out.print(
              `Would import ${imported.language} as ${imported.as} from ${imported.files.length} files.`,
            );
        }
        if (waited) {
          out.print();
          renderJob(out, waited);
        }
      },
    };
  },
};

/** The upload's error with local paths, and a clearer message for invalid source files. */
function uploadError(error: unknown, project: Project, sources: Sources): unknown {
  const localized = localizeError(error, (file) => sources.byServer.get(file)?.local, {
    configName: project.configName,
  });
  if (localized instanceof CliError && localized.code === "invalid_source") {
    const files = new Set(localized.details.map((detail) => detail.file));
    return new CliError(
      EXIT.invalidSource,
      `${count(Math.max(files.size, 1), "source file")} can't be read.`,
      { code: "invalid_source", status: localized.status, details: localized.details },
    );
  }
  return localized;
}

/**
 * Parses `--rename`: `old=new` or `file:old=new`. A key may be a JSON array key path
 * (`["a.b"]`, then maybe `#plural`), or a JSON string (`"x = y"`) for a displayed key with
 * `=` in it; both may contain `=` and `:`. `resolveFile` turns a file argument into its
 * server path.
 */
export function parseRename(value: string, resolveFile: (file: string) => string): Rename {
  const invalid = () =>
    usageError(`--rename ${value} isn't old=new or file:old=new.`, {
      hint: "For example: --rename menu.start=menu.play, or --rename 'common.json:[\"a.b\"]=c'",
    });
  let rest = value;
  let file: string | undefined;
  const prefix = /^([^:=[\]"]+\.json):/.exec(value);
  if (prefix) {
    file = resolveFile(prefix[1]);
    rest = value.slice(prefix[0].length);
  }
  const quoted = quotedKeyEnd(rest);
  let from: string;
  let to: string;
  if (quoted !== -1) {
    if (rest[quoted + 1] !== "=") throw invalid();
    from = rest.slice(0, quoted + 1);
    to = rest.slice(quoted + 2);
  } else {
    const equals = rest.indexOf("=");
    if (equals === -1) throw invalid();
    from = rest.slice(0, equals);
    to = rest.slice(equals + 1);
  }
  from = checkRenameKey(from, invalid);
  to = checkRenameKey(to, invalid);
  return file === undefined ? { from, to } : { file, from, to };
}

const KIND_SUFFIX = /^#(text|plural|ordinal)$/;

/**
 * Where a key written as JSON at the start of `text` ends: a JSON array key path with an
 * optional kind (`["a.b"]#plural`), or a JSON string (`"x = y"`). -1 when it isn't one.
 */
function quotedKeyEnd(text: string): number {
  if (text.startsWith('"')) return jsonStringEnd(text);
  if (!text.startsWith("[")) return -1;
  const end = jsonArrayEnd(text);
  if (end === -1) return -1;
  const kind = /^#(text|plural|ordinal)/.exec(text.slice(end + 1));
  return kind ? end + kind[0].length : end;
}

/** A key of `--rename` as the instance takes it: a JSON string decoded; others checked. */
function checkRenameKey(key: string, invalid: () => Error): string {
  if (key === "") throw invalid();
  if (key.startsWith('"')) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(key);
    } catch {
      throw usageError(`--rename: ${key} isn't a valid JSON string.`);
    }
    if (typeof decoded !== "string" || decoded === "") throw invalid();
    return decoded;
  }
  if (key.startsWith("[")) {
    const end = jsonArrayEnd(key);
    const path = end === -1 ? key : key.slice(0, end + 1);
    const kind = end === -1 ? "" : key.slice(end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(path);
    } catch {
      throw usageError(`--rename: ${key} isn't a valid JSON array key path.`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((part) => typeof part === "string" || Number.isInteger(part)) ||
      (kind !== "" && !KIND_SUFFIX.test(kind))
    ) {
      throw usageError(`--rename: ${key} must be a JSON array of keys, such as ["a.b", "c"].`);
    }
  }
  return key;
}

/** The index of the `"` that ends the JSON string at the start of `text`, or -1. */
function jsonStringEnd(text: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
  }
  return -1;
}

/** The index of the `]` that ends the JSON array at the start of `text`, or -1. */
function jsonArrayEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The command that applies rename suggestions, quoted for the shell. A displayed key that
 * `parseRename` would read otherwise (with `=`, or starting with `"`) is written as a
 * JSON string, so that every suggestion reads back as it was made.
 */
export function renameCommand(
  ...suggestions: { file: string; from: string; to: string }[]
): string {
  const key = (text: string, first: boolean) =>
    text.startsWith('"') || (first && text.includes("=") && quotedKeyEnd(text) === -1)
      ? JSON.stringify(text)
      : text;
  return commandLine([
    "quaso",
    "upload",
    ...suggestions.flatMap((suggestion) => [
      "--rename",
      `${suggestion.file}:${key(suggestion.from, true)}=${key(suggestion.to, false)}`,
    ]),
  ]);
}

function localOf(sources: Sources, file: string): string {
  return sources.byServer.get(file)?.local ?? file;
}

function uploadJson(result: UploadResult, sources: Sources) {
  return {
    ...result,
    files: result.files.map((file) => ({ ...file, localPath: localOf(sources, file.path) })),
    renameSuggestions: result.renameSuggestions.map((suggestion) => ({
      ...suggestion,
      command: renameCommand(suggestion),
    })),
    /** One command that applies every rename suggestion. */
    renameCommand:
      result.renameSuggestions.length > 0 ? renameCommand(...result.renameSuggestions) : null,
  };
}

function waitNote(result: UploadResult): string {
  return result.dryRun
    ? "A dry run queues no translation job, so there was nothing to wait for."
    : "The upload queued no automatic translation job, so there was nothing to wait for.";
}

function renderUpload(out: Output, result: UploadResult, sources: Sources, wait: boolean): void {
  const { bold, dim, green, yellow, red, cyan } = out.out;
  if (result.dryRun) out.print(yellow("Dry run: nothing was saved."));

  const rows = result.files.map((file) => {
    const counts = [
      file.added > 0 ? green(`${file.added} added`) : "",
      file.changed > 0 ? yellow(`${file.changed} changed`) : "",
      file.removed > 0 ? red(`${file.removed} removed`) : "",
      file.restored > 0 ? `${file.restored} restored` : "",
      file.moved > 0 ? dim(`${file.moved} moved`) : "",
    ]
      .filter(Boolean)
      .join(", ");
    return [
      localOf(sources, file.path),
      file.status === "unchanged" ? dim(file.status) : file.status,
      counts,
    ];
  });
  for (const line of table(rows)) out.print(`  ${line}`.trimEnd());

  // The keys of new files aren't listed one by one: the table above counts them.
  const newFiles = new Set(
    result.files.filter((file) => file.status === "new").map((file) => file.path),
  );
  const list = (title: string, keys: { file: string; key: string }[], style = (s: string) => s) => {
    const shown = keys.filter((ref) => !newFiles.has(ref.file));
    if (shown.length === 0) return;
    out.print();
    out.print(bold(`${title}: ${shown.length}`));
    for (const ref of shown.slice(0, MAX_LISTED)) {
      out.print(`  ${style(`${localOf(sources, ref.file)} › ${ref.key}`)}`);
    }
    if (shown.length > MAX_LISTED) {
      out.print(dim(`  … and ${shown.length - MAX_LISTED} more (--json lists them all)`));
    }
  };
  list("Added", result.added, green);
  list("Changed", result.changed, yellow);
  list("Removed (hidden on the instance, with their translations)", result.removed, red);
  list("Restored", result.restored);
  if (result.renamed.length > 0) {
    out.print();
    out.print(bold(`Renamed (${result.renamed.length}):`));
    for (const rename of result.renamed) {
      out.print(`  ${localOf(sources, rename.file)} › ${rename.from} → ${rename.to}`);
    }
  }
  if (result.hiddenFiles.length > 0) {
    out.print();
    out.print(
      bold(
        `Files hidden on the instance, because this upload doesn't have them (${result.hiddenFiles.length}):`,
      ),
    );
    for (const file of result.hiddenFiles) out.print(`  ${file}`);
  }
  if (result.languagesAdded.length > 0) {
    out.print();
    out.print(`Languages added on the instance: ${result.languagesAdded.join(", ")}`);
  }
  if (result.renameSuggestions.length > 0) {
    out.print();
    out.print(bold("Possible renames (a removed key and an added key with the same English):"));
    for (const suggestion of result.renameSuggestions) {
      out.print(`  ${localOf(sources, suggestion.file)} › ${suggestion.from} → ${suggestion.to}`);
      out.print(`    ${cyan(renameCommand(suggestion))}`);
    }
    if (result.renameSuggestions.length > 1) {
      out.print("  All of them:");
      out.print(`    ${cyan(renameCommand(...result.renameSuggestions))}`);
    }
  }
  if (result.warnings.length > 0) {
    out.print();
    out.print(yellow(`Warnings (${result.warnings.length}):`));
    for (const warning of result.warnings) out.print(`  ${warning}`);
  }
  out.print();
  if (result.dryRun) {
    const changes =
      result.files.some((file) => file.status !== "unchanged") ||
      result.hiddenFiles.length > 0 ||
      result.languagesAdded.length > 0 ||
      result.renamed.length > 0;
    out.print(
      changes
        ? `${count(result.files.length, "file")} compared; run without --dry-run to save.`
        : "Nothing would change: the instance already has these files.",
    );
  } else if (result.uploadId === null) {
    out.print("Nothing changed: the instance already has these files.");
  } else {
    out.print(`${count(result.files.length, "file")} uploaded (revision ${result.revision}).`);
  }
  if (result.job !== null && !wait) {
    out.print(`Translation job ${result.job.id} is queued for the added and changed strings.`);
  }
  if (wait && (result.job === null || result.dryRun)) out.print(waitNote(result));
}

type RepositoryFile = { language: string; path: string; content: string; keys: string[] };
async function repositoryTranslations(
  project: Project,
  selected: SourceFile[],
  sources: UploadRequest["files"],
): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  for (const source of selected) {
    const content = sources.find((file) => file.path === source.server)!.content;
    for (const language of project.languages) {
      const path = translationPath(project, source, language);
      const translation = await readProjectText(project, path);
      if (translation === null) continue;
      let entries;
      let read;
      try {
        entries = readSource(content, { file: source.local }).entries;
        read = readTranslation(translation, entries, { language, file: path });
      } catch (error) {
        throw new CliError(
          EXIT.invalidSource,
          `Can't inspect ${path}: ${(error as Error).message}`,
          {
            code: "invalid_source",
            details: [{ file: path, language, message: (error as Error).message }],
          },
        );
      }
      const keys = entries
        .filter(
          (entry) =>
            isTranslatable(entry.kind) && read.values.has(entryKey(entry.kind, entry.keyPath)),
        )
        .map((entry) => formatKeyPath(entry.keyPath));
      files.push({ language, path: source.server, content: translation, keys });
    }
  }
  return files;
}
function localTranslationReport(files: RepositoryFile[], upload: UploadResult) {
  const affected = new Set(
    [...upload.added, ...upload.changed, ...upload.restored].map((ref) =>
      JSON.stringify([ref.file, ref.key]),
    ),
  );
  const reports = new Map<
    string,
    { language: string; strings: number; files: string[]; command: string }
  >();
  for (const file of files) {
    const strings = file.keys.filter((key) =>
      affected.has(JSON.stringify([file.path, key])),
    ).length;
    if (strings === 0) continue;
    const report = reports.get(file.language) ?? {
      language: file.language,
      strings: 0,
      files: [],
      command: "",
    };
    report.strings += strings;
    report.files.push(file.path);
    report.command = commandLine([
      "quaso",
      "import",
      "--as",
      "blue",
      "--language",
      file.language,
      ...report.files.flatMap((path) => ["--file", path]),
    ]);
    reports.set(file.language, report);
  }
  return [...reports.values()];
}
