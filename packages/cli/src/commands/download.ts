// SPDX-License-Identifier: MIT
/**
 * `quaso download` (design §5.5, §5.10, S4.6): asks for every language's rendered files,
 * maps each back to a local path with the config (never with a path from the server), and
 * writes only the files whose bytes differ. It refuses to write a source file, the source
 * language or anything outside the project folder, and checks every path before it writes
 * the first file. `--prune` deletes translation files whose source file is gone.
 */
import { DownloadState } from "../download_state.ts";
import { PublicationTime, validate, type ExportResult } from "@quaso/core";
import { flag, option, values } from "../args.ts";
import { canonical, languageFolder, type Project } from "../config.ts";
import type { Command, Context } from "../context.ts";
import { CliError, EXIT, usageError } from "../errors.ts";
import {
  absolutePath,
  checkOutputPath,
  selectTranslations,
  type Sources,
  translationPath,
} from "../files.ts";
import {
  readBytes,
  readProjectText,
  RealPathGuard,
  removeFile,
  sameBytes,
  sha256,
  utf8,
  writeAtomic,
} from "../fs.ts";
import { compareStrings, globBase, globToRegExp, walk } from "../glob.ts";
import { LONG_TIMEOUT_MS } from "../http.ts";
import { count, type Output } from "../output.ts";

export interface DownloadedFile {
  /** The local path, relative to the project folder. */
  path: string;
  /** The server's path of its source file. */
  file: string;
  language: string;
}

export interface DownloadResult {
  server: string;
  outdated: { file: string; key: string; language: string; sourceRevision: number }[];
  localEdits: (DownloadedFile & { key: string })[];
  dryRun: boolean;
  revision: number;
  languages: string[];
  /** Written (or, in a dry run, to be written). */
  written: (DownloadedFile & { created: boolean })[];
  unchanged: DownloadedFile[];
  /** Deleted by --prune (or, in a dry run, to be deleted). */
  pruned: { path: string; language: string }[];
  /** Files of the server that no local source file has. */
  skipped: { file: string; language: string; reason: string }[];
}

export const download: Command = {
  name: "download",
  summary: "Write every language's files, skipping files that haven't changed",
  description: [
    "Asks the instance for the translations of every source file in every language of " +
      "quaso.config.json, and writes them where the config's translation pattern says. " +
      "Untranslated strings are written in the source language. Files whose content hasn't " +
      "changed are left alone, so a second download writes nothing.",
    "The CLI computes every path itself and refuses to write a source file, the source " +
      "language or anything outside the folder of quaso.config.json.",
  ],
  options: [
    {
      name: "overwrite-local",
      type: "boolean",
      description: "Replace local edits after reviewing or importing them",
    },
    {
      name: "at",
      type: "string",
      value: "<UTC time>",
      description: "Download published files as they were at this time",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "List what would be written or deleted, without changing anything",
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
      name: "prune",
      type: "boolean",
      description:
        "Also delete translation files whose source file no longer exists " +
        "(only files the translation pattern could have written)",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 6],
  examples: [
    "quaso download",
    "quaso download --dry-run",
    "quaso download --language de,fr",
    "quaso download --prune",
    "quaso download --at 2026-09-01T00:00Z",
  ],
  async run(ctx: Context) {
    const at = option(ctx.args, "at");
    if (at !== undefined && !validate(PublicationTime, at).ok)
      throw usageError("--at must be a valid UTC timestamp, such as 2026-09-01T00:00Z.");
    const project = await ctx.project();
    const sources = await ctx.sources();
    const dryRun = flag(ctx.args, "dry-run");
    const prune = flag(ctx.args, "prune");
    const named = values(ctx.args, "file");
    if (prune && named.length > 0) {
      throw usageError("--prune works on every file, so it can't be combined with --file.");
    }
    const selection = selectTranslations(
      project,
      sources,
      ctx.cwd,
      values(ctx.args, "language"),
      named,
    );
    const { languages } = selection;
    const client = ctx.client(project);
    const result: DownloadResult = {
      server: client.baseUrl,
      dryRun,
      revision: 0,
      languages,
      written: [],
      unchanged: [],
      pruned: [],
      skipped: [],
      outdated: [],
      localEdits: [],
    };
    if (languages.length === 0) {
      ctx.out.warn(`${project.configName} lists no languages, so there is nothing to download.`);
      return downloadResult(result);
    }

    // The instance splits the files query at commas, so a name with one can't be asked
    // for: then every file is asked for, and the others are left out here.
    const wanted = selection.files?.map((file) => file.server) ?? null;
    const askFiles = wanted !== null && !wanted.some((path) => path.includes(","));
    ctx.out.info(`Downloading ${count(languages.length, "language")} from ${client.baseUrl}…`);
    let exported: ExportResult;
    try {
      exported = await client.get<ExportResult>("/export", {
        query: {
          languages,
          files: askFiles ? wanted : undefined,
          at,
          untranslated: project.config.untranslated,
          outdated: project.config.outdated,
        },
        timeoutMs: LONG_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.usage) {
        throw new CliError(error.exitCode, error.message, {
          code: error.code,
          status: error.status,
          details: error.details,
          hint:
            error.hint ??
            (error.details.some((detail) => detail.language)
              ? "quaso upload adds the languages of quaso.config.json to the instance."
              : wanted !== null
                ? "quaso upload sends new source files to the instance first."
                : undefined),
        });
      }
      throw error;
    }
    result.revision = exported.revision;

    // Plan and check every path first: nothing is written if one of them is refused.
    const planned: { target: DownloadedFile; bytes: Uint8Array; sha256: string }[] = [];
    const byPath = new Map<string, DownloadedFile>();
    for (const file of exported.files) {
      // Only what was asked for, and paths from the config and the tag asked for: never
      // a language or a path the server made up (CLI-5).
      const language = languages.find((tag) => tag === canonical(file.language));
      if (language === undefined || (askFiles && !wanted.includes(file.path))) {
        throw new CliError(
          EXIT.network,
          `The instance sent ${file.path} (${file.language}), which wasn't asked for.`,
          {
            code: "bad_response",
            hint:
              `Nothing was written. Asked for ${languages.join(", ")}` +
              `${askFiles ? ` and ${wanted.join(", ")}` : ""}: is QUASO_HOSTNAME right?`,
          },
        );
      }
      if (!selection.wants(file.path, language)) continue;
      const source = sources.byServer.get(file.path);
      if (!source) {
        result.skipped.push({
          file: file.path,
          language,
          reason: "the instance has this file, but none of the local source files maps to it",
        });
        continue;
      }
      const path = translationPath(project, source, language);
      checkOutputPath(project, sources, path, language);
      const other = byPath.get(path.toLowerCase());
      if (other) {
        throw usageError(
          `${other.file} (${other.language}) and ${file.path} (${language}) would both be ` +
            `written to ${path}.`,
          {
            code: "unsafe_path",
            hint:
              `Give files[${source.mapping}].translation in ${project.configName} ` +
              "a {path}, or a folder per language.",
          },
        );
      }
      const target = { path, file: file.path, language };
      const bytes = utf8(file.content);
      if ((await sha256(bytes)) !== file.sha256) {
        throw new CliError(
          EXIT.network,
          `The download of ${file.path} (${language}) arrived damaged: its SHA-256 differs.`,
          { code: "bad_response", hint: "Nothing was written. It is safe to try again." },
        );
      }
      byPath.set(path.toLowerCase(), target);
      planned.push({ target, bytes, sha256: file.sha256 });
      for (const entry of file.outdated ?? [])
        result.outdated.push({ ...entry, file: file.path, language });
    }
    const guard = new RealPathGuard(project, sources);
    for (const { target } of planned) await guard.check(target.path, target.language);
    const prunable = prune ? await findPrunable(project, sources, languages, byPath) : [];
    for (const file of prunable) await guard.check(file.path, file.language);

    const state = await DownloadState.load(project, sources, client.baseUrl);
    const overwriteLocal = flag(ctx.args, "overwrite-local");
    for (const { target, bytes, sha256: expected } of planned) {
      const absolute = absolutePath(project, target.path);
      const local = await readBytes(absolute);
      if (local !== null && (await sha256(local)) === expected && sameBytes(local, bytes)) {
        result.unchanged.push(target);
        if (!dryRun) state.remember(target.path, bytes);
        continue;
      }
      if (local !== null && !overwriteLocal) {
        const source = sources.byServer.get(target.file)!;
        const sourceText = await readProjectText(project, source.local);
        const conflicts = state.conflicts(target.path, local, bytes, sourceText ?? "{}");
        if (conflicts.length > 0) {
          result.localEdits.push(...conflicts.map((key) => ({ ...target, key })));
          continue;
        }
      }
      if (!dryRun) {
        const latest = await readBytes(absolute);
        const changedMeanwhile =
          local === null ? latest !== null : latest === null || !sameBytes(local, latest);
        if (changedMeanwhile)
          throw usageError(`${target.path} changed during download; run the command again.`);
        await writeAtomic(absolute, bytes);
        state.remember(target.path, bytes);
      }
      result.written.push({ ...target, created: local === null });
    }
    for (const file of prunable) {
      if (!dryRun) await removeFile(absolutePath(project, file.path));
      result.pruned.push(file);
    }
    if (!dryRun) await state.save();
    return downloadResult(result);
  },
};

function downloadResult(result: DownloadResult) {
  return {
    exitCode: result.localEdits.length > 0 && !result.dryRun ? EXIT.refused : EXIT.ok,
    json: result,
    render: (out: Output) => renderDownload(out, result),
  };
}

/**
 * Translation files that `--prune` deletes: files of the given languages that a
 * `translation` pattern could have written, from a path the `source` glob could match, but
 * whose source file doesn't exist. Patterns without `{path}` name one file, which is
 * never pruned. Files that are written now, source files and the config are never pruned.
 */
export async function findPrunable(
  project: Project,
  sources: Sources,
  languages: readonly string[],
  written: ReadonlyMap<string, unknown>,
): Promise<{ path: string; language: string }[]> {
  const keep = new Set<string>([project.configName.toLowerCase()]);
  for (const source of sources.files) {
    keep.add(source.local.toLowerCase());
    for (const language of [...project.languages, ...languages]) {
      keep.add(translationPath(project, source, language).toLowerCase());
    }
  }
  for (const path of written.keys()) keep.add(path.toLowerCase());

  const found = new Map<string, { path: string; language: string }>();
  for (const mapping of project.config.files) {
    const parts = mapping.translation.split("{path}");
    if (parts.length !== 2) continue;
    const base = globBase(mapping.source);
    const sourceMatch = globToRegExp(mapping.source);
    const excludes = (mapping.exclude ?? []).map(globToRegExp);
    for (const language of languages) {
      if (canonical(language) === project.sourceLanguage) continue;
      const folder = languageFolder(project, language);
      const [before, after] = parts.map((part) => part.replaceAll("{lang}", folder));
      const pattern = new RegExp(`^${escapeRegExp(before)}(.+)${escapeRegExp(after)}$`);
      const start = before.includes("/") ? before.slice(0, before.lastIndexOf("/")) : "";
      const candidates: string[] = [];
      await walk(
        project.dir,
        start,
        start === "" ? 0 : start.split("/").length,
        Infinity,
        (path) => {
          candidates.push(path);
        },
      );
      for (const path of candidates) {
        const match = pattern.exec(path);
        if (!match) continue;
        const server = match[1];
        if (!server.endsWith(".json") || server.split("/").some((part) => part === "..")) continue;
        const sourcePath = base === "" ? server : `${base}/${server}`;
        if (!sourceMatch.test(sourcePath) || excludes.some((exclude) => exclude.test(sourcePath))) {
          continue;
        }
        if (sources.byServer.has(server) || keep.has(path.toLowerCase())) continue;
        checkOutputPath(project, sources, path, language);
        found.set(path, { path, language });
      }
    }
  }
  return [...found.values()].sort((a, b) => compareStrings(a.path, b.path));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function renderDownload(out: Output, result: DownloadResult): void {
  const { dim, green, red, yellow } = out.out;
  if (result.dryRun) out.print(yellow("Dry run: nothing was written or deleted."));
  for (const file of result.written) {
    const verb = result.dryRun
      ? file.created
        ? "would create"
        : "would update"
      : file.created
        ? "created"
        : "updated";
    out.print(`  ${green(verb.padEnd(12))} ${file.path}`);
  }
  for (const file of result.pruned) {
    out.print(`  ${red((result.dryRun ? "would delete" : "deleted").padEnd(12))} ${file.path}`);
  }
  for (const skipped of result.skipped) {
    out.print(
      `  ${dim("skipped".padEnd(12))} ${skipped.file} (${skipped.language}): ${skipped.reason}`,
    );
  }
  for (const entry of result.outdated) {
    out.print(
      `  ${yellow("outdated".padEnd(12))} ${entry.language}  ${entry.file} › ${entry.key}  Source file changed in revision ${entry.sourceRevision}`,
    );
  }
  if (result.outdated.length > 0)
    out.warn(
      `${count(result.outdated.length, "translation")} are of an older source: run quaso translate, or review them on the website.`,
    );
  for (const edit of result.localEdits)
    out.print(`  ${yellow("local edit".padEnd(12))} ${edit.language}  ${edit.file} › ${edit.key}`);
  if (result.localEdits.length > 0)
    out.warn(
      "Files with local edits were kept. Import them with quaso import --as blue, or pass --overwrite-local after reviewing the changes.",
    );
  if (result.written.length === 0 && result.pruned.length === 0 && result.localEdits.length === 0) {
    out.print(`Everything is up to date (${count(result.unchanged.length, "file")}).`);
    return;
  }
  const parts = [
    `${result.dryRun ? "Would write" : "Wrote"} ${count(result.written.length, "file")}`,
    `${result.unchanged.length} unchanged`,
  ];
  if (result.pruned.length > 0) {
    parts.push(`${result.dryRun ? "would delete" : "deleted"} ${result.pruned.length}`);
  }
  if (result.localEdits.length > 0)
    parts.push(
      `${new Set(result.localEdits.map((edit) => edit.path)).size} files kept for local edits`,
    );
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  out.print(`${parts.join(", ")}.`);
}
