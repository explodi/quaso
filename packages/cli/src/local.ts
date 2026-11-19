// SPDX-License-Identifier: MIT
/**
 * Translating without an instance. The CLI starts the service an instance runs, on a database
 * in memory that lasts for one command, and takes it through an instance's steps: upload the
 * source files with the config's settings and context files, import the translations the
 * repository already has, run a translation job, and write the result. The prompts, checks
 * and retries are therefore the instance's own.
 *
 * The repository is the only store: the translation files hold the translations, and
 * `quaso.lock.json` the source text each one was made for.
 */
import {
  DEFAULT_SYNTAX,
  type ExportFile,
  type ImportRequest,
  type JobInfo,
  type LlmProviderName,
  type PluralOverride,
  readSource,
  readTranslation,
  renderFile,
  type SourceFile as ParsedSource,
  type UploadRequest,
} from "@quaso/core";
import {
  createService,
  type Scheduler,
  type Service,
  ServiceError,
  SYSTEM,
  type TranslationProvider,
} from "@quaso/service";
import { sqlOnDatabase } from "@quaso/service/node-sqlite-database";
import {
  readFolderContexts,
  readUploadFiles,
  uploadError,
  uploadRequest,
} from "./commands/upload.ts";
import { canonical, type Project } from "./config.ts";
import type { CommandResult, Context } from "./context.ts";
import { CliError, EXIT, type Problem } from "./errors.ts";
import {
  absolutePath,
  checkOutputPath,
  type SourceFile,
  type Sources,
  translationPath,
} from "./files.ts";
import {
  readBytes,
  readProjectText,
  RealPathGuard,
  removeFile,
  sameBytes,
  utf8,
  writeAtomic,
} from "./fs.ts";
import { apiError } from "./http.ts";
import { localFailures, progressLine, SETTLED } from "./jobs.ts";
import { Lock } from "./lock.ts";
import { count, formatProblem, type Output, sentenceFragment } from "./output.ts";
import { renderEstimate } from "./commands/translate.ts";

/** Builds the provider for a key; tests pass one that answers without a network. */
export type ProviderFactory = (apiKey: string, provider: LlmProviderName) => TranslationProvider;

/** The environment variable that holds each provider's key. */
const KEY_VARIABLES = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;

export interface LocalTranslation {
  /** Canonical tags, never the source language. */
  languages: string[];
  /** The source files to translate; null for all of them. */
  files: SourceFile[] | null;
  retranslate: boolean;
  qa: boolean;
  instruction?: string;
  model?: string;
  dryRun: boolean;
}

interface WrittenFile {
  /** The local path, relative to the project folder. */
  path: string;
  language: string;
  change: "created" | "updated" | "deleted";
}

/** Translates the project's strings with the LLM and writes the translation files. */
export async function translateLocally(
  ctx: Context,
  project: Project,
  sources: Sources,
  options: LocalTranslation,
): Promise<CommandResult> {
  const keys = llmKeys(ctx);
  const selected = options.files ?? sources.files;
  const paths = selected.map((file) => file.server);
  const uploaded = await readUploadFiles(project, sources.files);
  const request: UploadRequest = {
    ...uploadRequest(project, uploaded),
    folderContexts: await readFolderContexts(project, sources.files),
  };
  // The job below is the only one: it takes this run's languages, files and options.
  request.settings = {
    ...request.settings,
    llm: { ...request.settings?.llm, autoTranslate: false },
  };

  const instance = await startInstance(keys, ctx.llmProvider);
  const { service } = instance;
  try {
    try {
      await service.upload(SYSTEM, request);
    } catch (error) {
      throw uploadError(cliError(error), project, sources);
    }
    const english = parseSources(project, uploaded);
    const lock = await Lock.load(project);
    for (const language of options.languages) {
      const files = await currentTranslations(project, selected, english, lock, language);
      if (files.length === 0) continue;
      const imported: ImportRequest = {
        language,
        files,
        as: "green",
        keepIdentical: true,
        allowQaErrors: true,
      };
      await served(() => service.importTranslations(SYSTEM, imported));
    }

    const created = await served(() =>
      service.createJob(SYSTEM, {
        languages: options.languages,
        files: options.files === null ? undefined : paths,
        retranslate: options.retranslate || undefined,
        qa: options.qa || undefined,
        instruction: options.instruction,
        model: options.model,
        dryRun: options.dryRun || undefined,
      }),
    );
    if (created.estimate !== null) {
      const estimate = created.estimate;
      return {
        exitCode: EXIT.ok,
        json: { local: true, dryRun: true, estimate },
        render: (out) => renderEstimate(out, estimate),
      };
    }
    const settings = await served(() => service.getSettings(SYSTEM, {}));
    const model = options.model ?? settings.settings.llm.model;
    ctx.out.info(`Translating ${options.languages.join(", ")} with ${model}, without an instance…`);
    const job = await runJob(ctx, instance, created.job);

    const scope = { languages: options.languages, files: paths };
    const translated = await served(() =>
      service.exportFiles(SYSTEM, { ...scope, untranslated: "omit" }),
    );
    for (const file of translated.files) {
      const parsed = english.get(file.path)!;
      // An empty file is a document with nothing to write, not a blank translation.
      const values =
        file.content === ""
          ? new Map()
          : readTranslation(file.content, parsed.entries, {
              language: file.language,
              file: file.path,
              pluralOverride: pluralOverride(project, file.language),
            }).values;
      lock.record(file.language, file.path, parsed.entries, new Set(values.keys()));
    }
    const untranslated = project.config.untranslated ?? "source";
    const rendered =
      untranslated === "omit"
        ? translated
        : await served(() => service.exportFiles(SYSTEM, { ...scope, untranslated }));
    const { written, unchanged } = await writeTranslations(project, sources, rendered.files);
    await lock.save(
      project.languages,
      sources.files.map((file) => file.server),
    );

    const failures = localFailures(job, project, sources);
    const finished = job.status === "done" && job.progress.failed === 0;
    return {
      exitCode: finished ? EXIT.ok : EXIT.refused,
      json: { local: true, dryRun: false, model, job, failures, written, unchanged },
      render: (out) => renderLocal(out, job, failures, written, unchanged),
    };
  } finally {
    instance.close();
  }
}

/** The provider keys in the environment; at least one, or an error that says how to set one. */
function llmKeys(ctx: Context): { provider: LlmProviderName; key: string }[] {
  const keys = (["gemini", "anthropic"] as const).flatMap((provider) => {
    const key = ctx.env[KEY_VARIABLES[provider]]?.trim();
    return key ? [{ provider, key }] : [];
  });
  if (keys.length > 0) return keys;
  throw new CliError(
    EXIT.auth,
    "No LLM API key: GEMINI_API_KEY and ANTHROPIC_API_KEY aren't set.",
    {
      code: "missing_key",
      hint:
        "Set one of them to translate without an instance. To use an instance instead, set " +
        "QUASO_HOSTNAME and QUASO_API_KEY.",
    },
  );
}

interface Instance {
  service: Service;
  /** When the service asked to be woken up, in milliseconds since the epoch; null for never. */
  wakeUpAt: number | null;
  close(): void;
}

/** The service on an empty database in memory, with the provider keys stored as on an instance. */
async function startInstance(
  keys: { provider: LlmProviderName; key: string }[],
  providerFactory: ProviderFactory | undefined,
): Promise<Instance> {
  // Loaded here, so that commands that talk to an instance never load the database driver.
  const sqlite = await import("node:sqlite").catch(() => {
    throw new CliError(EXIT.usage, "Translating without an instance needs Node 22.13 or later.", {
      code: "unsupported_runtime",
      hint: `This is Node ${process.versions.node}: it has no node:sqlite module.`,
    });
  });
  const database = sqlOnDatabase(new sqlite.DatabaseSync(":memory:"));
  const scheduler: Scheduler = {
    schedule: (at) => void (instance.wakeUpAt = at),
    cancel: () => void (instance.wakeUpAt = null),
  };
  const instance: Instance = {
    service: createService({ sql: database.sql, scheduler, providerFactory }),
    wakeUpAt: null,
    close: () => database.close(),
  };
  await instance.service.start();
  for (const { provider, key } of keys) {
    await served(() =>
      instance.service.setSecret(SYSTEM, { name: `${provider}_api_key`, value: key }),
    );
  }
  return instance;
}

/** Wakes the service up each time it asks, until the job settles; progress goes to stderr. */
async function runJob(ctx: Context, instance: Instance, first: JobInfo): Promise<JobInfo> {
  let job = first;
  let reported = "";
  for (;;) {
    const line = progressLine(job);
    if (line !== reported) ctx.out.info(line);
    reported = line;
    if (SETTLED.has(job.status)) return job;
    if (instance.wakeUpAt === null) {
      throw new CliError(EXIT.unexpected, "The translation job stopped before it finished.");
    }
    const wait = instance.wakeUpAt - Date.now();
    instance.wakeUpAt = null;
    if (wait > 0) await ctx.sleep(wait);
    await instance.service.alarm();
    job = await served(() => instance.service.getJob(SYSTEM, { id: job.id }));
  }
}

/** The source files, read as the service reads them, by server path. */
function parseSources(project: Project, files: UploadRequest["files"]): Map<string, ParsedSource> {
  const { config } = project;
  const syntax = { ...DEFAULT_SYNTAX, ...config.settings?.syntax };
  const parsed = new Map<string, ParsedSource>();
  for (const file of files) {
    const pluralExclusions = (config.pluralExclusions ?? [])
      .filter((exclusion) => exclusion.file === file.path)
      .map((exclusion) => exclusion.key);
    parsed.set(file.path, readSource(file.content, { file: file.path, syntax, pluralExclusions }));
  }
  return parsed;
}

/**
 * A language's translation files, each with only the values that translate the current source
 * text (`Lock.current`): the others are left out, so the job translates them.
 */
async function currentTranslations(
  project: Project,
  selected: readonly SourceFile[],
  english: ReadonlyMap<string, ParsedSource>,
  lock: Lock,
  language: string,
): Promise<ImportRequest["files"]> {
  const files: ImportRequest["files"] = [];
  const override = pluralOverride(project, language);
  for (const source of selected) {
    const path = translationPath(project, source, language);
    const text = await readProjectText(project, path);
    if (text === null) continue;
    const { entries, format } = english.get(source.server)!;
    let values;
    try {
      values = readTranslation(text, entries, {
        language,
        file: path,
        pluralOverride: override,
      }).values;
    } catch (error) {
      const message = (error as Error).message;
      throw new CliError(EXIT.invalidSource, `Can't read ${path}: ${message}`, {
        code: "invalid_source",
        details: [{ file: path, language, message }],
      });
    }
    const content = renderFile(entries, lock.current(language, source.server, entries, values), {
      language,
      format,
      pluralOverride: override,
      untranslated: "omit",
    });
    if (content !== "") files.push({ path: source.server, content });
  }
  return files;
}

/** The plural override the config's settings give a language, if any. */
function pluralOverride(project: Project, language: string): PluralOverride | undefined {
  for (const [tag, settings] of Object.entries(project.config.settings?.languages ?? {})) {
    if (canonical(tag) === language) return settings.pluralOverride ?? undefined;
  }
  return undefined;
}

/**
 * Writes the rendered files where the config's `translation` pattern says, after checking
 * every path. A file whose bytes are the same is left alone; an empty one (a document with
 * nothing to write) is deleted.
 */
async function writeTranslations(
  project: Project,
  sources: Sources,
  files: readonly ExportFile[],
): Promise<{ written: WrittenFile[]; unchanged: number }> {
  const guard = new RealPathGuard(project, sources);
  const planned: { path: string; language: string; bytes: Uint8Array }[] = [];
  for (const file of files) {
    const path = translationPath(project, sources.byServer.get(file.path)!, file.language);
    checkOutputPath(project, sources, path, file.language);
    await guard.check(path, file.language);
    planned.push({ path, language: file.language, bytes: utf8(file.content) });
  }
  const written: WrittenFile[] = [];
  let unchanged = 0;
  for (const { path, language, bytes } of planned) {
    const absolute = absolutePath(project, path);
    const local = await readBytes(absolute);
    const nothingToWrite = bytes.length === 0;
    const same = nothingToWrite ? local === null : local !== null && sameBytes(local, bytes);
    if (same) {
      unchanged++;
      continue;
    }
    if (nothingToWrite) await removeFile(absolute);
    else await writeAtomic(absolute, bytes);
    const change = nothingToWrite ? "deleted" : local === null ? "created" : "updated";
    written.push({ path, language, change });
  }
  return { written, unchanged };
}

function renderLocal(
  out: Output,
  job: JobInfo,
  failures: Problem[],
  written: WrittenFile[],
  unchanged: number,
): void {
  const { bold, green, red, yellow } = out.out;
  for (const file of written) {
    const colour = file.change === "deleted" ? red : green;
    out.print(`  ${colour(file.change.padEnd(8))} ${file.path}`);
  }
  if (job.progress.total === 0) {
    out.print("Nothing to translate: every string in scope is translated.");
  } else {
    const { translated, failed } = job.progress;
    const parts = [green(`${translated} translated`)];
    if (job.progress.reused) parts.push(`${job.progress.reused} reused`);
    if (failed > 0) parts.push(red(`${failed} failed`));
    const tokens = job.tokens.input + job.tokens.output + job.tokens.thinking;
    out.print(`${parts.join(", ")} (${tokens.toLocaleString("en")} tokens).`);
  }
  if (job.status !== "done") {
    out.print(yellow(`The translation ${job.status}: ${sentenceFragment(job.error ?? "")}`));
  }
  if (failures.length > 0) {
    out.print();
    out.print(bold(`Strings that stayed untranslated (${job.progress.failed}):`));
    for (const failure of failures) out.print(`  ${formatProblem(failure)}`);
  }
  out.print(`Wrote ${count(written.length, "file")}, ${unchanged} unchanged.`);
}

/** Runs a call to the service; its errors become the CLI's, as an instance's answers do. */
async function served<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw cliError(error);
  }
}

function cliError(error: unknown): unknown {
  if (!(error instanceof ServiceError)) return error;
  return apiError(error.status, JSON.stringify(error.toBody()), "", "");
}
