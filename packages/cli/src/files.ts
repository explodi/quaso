// SPDX-License-Identifier: MIT
/**
 * Local files and the server's paths (design §5.5, §5.10, CLI-5). A source file's server
 * path is its path below the folder where its glob starts (`common.json`,
 * `menus/main.json`); a translation's local path comes from the config's `translation`
 * pattern. The CLI computes every local path itself: a path from the server is only a key
 * to find the local source file, and every output path is checked before anything is
 * written.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isValidLanguageTag } from "@quaso/core";
import { canonical, languageFolder, type Project } from "./config.ts";
import { usageError } from "./errors.ts";
import { compareStrings, glob, globBase, globToRegExp } from "./glob.ts";

export interface SourceFile {
  /** The local path, relative to the project folder, with `/` separators. */
  local: string;
  /** The server's path: below the folder where its glob starts, with `/` separators. */
  server: string;
  /** The index of its entry in the config's `files`. */
  mapping: number;
}

export interface Sources {
  /** Sorted by server path. */
  files: SourceFile[];
  byServer: Map<string, SourceFile>;
  byLocal: Map<string, SourceFile>;
  /** Globs that matched nothing, for a warning. */
  warnings: string[];
}

/**
 * Finds the source files of every `files` entry. Fails (exit code 2) when a match isn't a
 * `.json` file, when two files would have the same server path, or when there are none.
 */
export async function collectSources(project: Project): Promise<Sources> {
  const byServer = new Map<string, SourceFile>();
  const byLocal = new Map<string, SourceFile>();
  const warnings: string[] = [];
  const problems: { key: string; message: string }[] = [];
  for (const [index, mapping] of project.config.files.entries()) {
    const base = globBase(mapping.source);
    let matches: string[];
    try {
      matches = await glob(project.dir, mapping.source, { exclude: mapping.exclude });
    } catch (error) {
      throw usageError(`files[${index}].source: ${(error as Error).message}.`);
    }
    if (matches.length === 0) {
      warnings.push(`files[${index}].source (${mapping.source}) matches no files.`);
    }
    for (const local of matches) {
      const server = base === "" ? local : local.slice(base.length + 1);
      const key = `files[${index}].source`;
      if (!server.endsWith(".json")) {
        problems.push({
          key,
          message: `${local} isn't a .json file: narrow the glob, or add it to exclude`,
        });
        continue;
      }
      const sameLocal = byLocal.get(local);
      if (sameLocal) {
        if (sameLocal.server !== server) {
          problems.push({
            key,
            message:
              `${local} is also matched by files[${sameLocal.mapping}].source, ` +
              `with another path (${sameLocal.server})`,
          });
        }
        continue;
      }
      const sameServer = byServer.get(server);
      if (sameServer) {
        problems.push({
          key,
          message: `${local} and ${sameServer.local} would both be ${server} on the server`,
        });
        continue;
      }
      const file = { local, server, mapping: index };
      byServer.set(server, file);
      byLocal.set(local, file);
    }
  }
  if (problems.length > 0) {
    throw usageError(`The source files in ${project.configName} can't be used as they are.`, {
      code: "invalid_config",
      details: problems.map((problem) => ({ file: project.configName, ...problem })),
    });
  }
  if (byServer.size === 0) {
    throw usageError(
      `No source files: ${project.config.files
        .map((mapping) => mapping.source)
        .join(", ")} matches nothing in ${project.dir}.`,
      { code: "no_source_files" },
    );
  }
  const files = [...byServer.values()].sort((a, b) => compareStrings(a.server, b.server));
  return { files, byServer, byLocal, warnings };
}

/**
 * A translation's local path, relative to the project folder: the `translation` pattern
 * with `{lang}` (after `languageMapping`) and `{path}` (the server path) filled in.
 */
export function translationPath(project: Project, source: SourceFile, language: string): string {
  const pattern = project.config.files[source.mapping].translation;
  return pattern
    .replaceAll("{lang}", languageFolder(project, language))
    .replaceAll("{path}", source.server);
}

/** A path relative to the project folder with `/` separators, or null when it's outside. */
export function projectPath(project: Project, absolute: string): string | null {
  const path = relative(project.dir, absolute);
  if (path === "" || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    return null;
  }
  return path.split(sep).join("/");
}

/** A project path as an absolute path of this system. */
export function absolutePath(project: Project, path: string): string {
  return resolve(project.dir, ...path.split("/"));
}

/**
 * Checks an output path before anything is written (CLI-5): never the source language,
 * never a source file or the config file, never outside the project folder. Paths compare
 * without case, as on macOS and Windows. Throws a usage error (exit code 2).
 */
export function checkOutputPath(
  project: Project,
  sources: Sources,
  path: string,
  language: string,
): void {
  const refuse = (why: string) =>
    usageError(`Refusing to write ${path} (${language}): ${why}.`, {
      code: "unsafe_path",
      hint: `Check files[].translation and languageMapping in ${project.configName}.`,
    });
  if (canonical(language) === project.sourceLanguage) {
    throw refuse("it is the source language, which is never written");
  }
  if (
    path.split("/").some((segment) => segment === ".." || segment === "") ||
    projectPath(project, absolutePath(project, path)) !== path
  ) {
    throw refuse("it is outside the project folder");
  }
  const lower = path.toLowerCase();
  if (lower === project.configName.toLowerCase()) throw refuse("it is the config file");
  for (const source of sources.files) {
    if (source.local.toLowerCase() === lower) throw refuse("it is a source file");
  }
  const glob = sourceGlobMatching(project, path);
  if (glob !== -1) {
    throw refuse(
      `files[${glob}].source matches it, so quaso upload would send it as a source file; ` +
        `add its folder to files[${glob}].exclude, or change the patterns`,
    );
  }
}

const sourceGlobs = new WeakMap<Project, { source: RegExp; exclude: RegExp[] }[]>();

/**
 * The index of the first `files` entry whose source glob matches a project path (and none
 * of whose exclude globs does), or -1. Without case, as paths compare on macOS and Windows.
 */
export function sourceGlobMatching(project: Project, path: string): number {
  let globs = sourceGlobs.get(project);
  if (globs === undefined) {
    const compile = (pattern: string) => new RegExp(globToRegExp(pattern).source, "i");
    globs = project.config.files.map((mapping) => ({
      source: compile(mapping.source),
      exclude: (mapping.exclude ?? []).map(compile),
    }));
    sourceGlobs.set(project, globs);
  }
  return globs.findIndex(
    (glob) => glob.source.test(path) && !glob.exclude.some((exclude) => exclude.test(path)),
  );
}

/**
 * The source files that `--file` arguments name: server paths (`common.json`), or local
 * paths (relative to the current folder) of source files.
 */
export function resolveFileArgs(
  project: Project,
  sources: Sources,
  cwd: string,
  args: readonly string[],
): SourceFile[] {
  const found = new Map<string, SourceFile>();
  for (const arg of args) {
    for (const { file } of resolveFileArg(project, sources, cwd, arg, [])) {
      found.set(file.server, file);
    }
  }
  return sortFiles(found.values());
}

/** A source file that `--file` named, in one language (its translation's) or all (null). */
export interface NamedFile {
  file: SourceFile;
  language: string | null;
}

/**
 * What `--language` and `--file` select for `download` and `import`: the languages, the
 * source files (null for all of them), and whether a file is wanted in a language. A
 * translation file's path (`src/locales/fr/common.json`) names that file in its language
 * only; a server path or a source file's path names it in every language.
 */
export interface Selection {
  /** Canonical tags, never the source language. */
  languages: string[];
  files: SourceFile[] | null;
  wants(server: string, language: string): boolean;
}

export function selectTranslations(
  project: Project,
  sources: Sources,
  cwd: string,
  languageArgs: readonly string[],
  fileArgs: readonly string[],
): Selection {
  for (const tag of languageArgs) {
    if (!isValidLanguageTag(tag)) {
      throw usageError(`--language ${tag} isn't a valid BCP 47 language tag.`);
    }
  }
  const requested = [...new Set(languageArgs.map(canonical))];
  for (const language of requested) {
    if (language === project.sourceLanguage) {
      throw usageError(`${language} is the source language: it has no translation files.`);
    }
  }
  if (fileArgs.length === 0) {
    return {
      languages: requested.length > 0 ? requested : project.languages,
      files: null,
      wants: () => true,
    };
  }

  const candidates = [...new Set([...project.languages, ...requested])];
  const everyLanguage = new Set<string>();
  const byFile = new Map<string, Set<string>>();
  const files = new Map<string, SourceFile>();
  for (const arg of fileArgs) {
    let named = resolveFileArg(project, sources, cwd, arg, candidates);
    if (requested.length > 0 && named.every((item) => item.language !== null)) {
      const inRequested = named.filter((item) => requested.includes(item.language!));
      if (inRequested.length === 0) {
        const its = [...new Set(named.map((item) => item.language))].join(", ");
        throw usageError(
          `${arg} is a translation file of ${its}, but --language is ${requested.join(",")}.`,
          { hint: "Leave out --language: a translation file's path says its language." },
        );
      }
      named = inRequested;
    }
    for (const { file, language } of named) {
      files.set(file.server, file);
      if (language === null) everyLanguage.add(file.server);
      else byFile.set(file.server, (byFile.get(file.server) ?? new Set()).add(language));
    }
  }
  const named = new Set([...byFile.values()].flatMap((languages) => [...languages]));
  const languages =
    requested.length > 0
      ? requested
      : everyLanguage.size > 0
        ? project.languages
        : candidates.filter((language) => named.has(language));
  return {
    languages,
    files: sortFiles(files.values()),
    wants: (server, language) =>
      everyLanguage.has(server) || (byFile.get(server)?.has(language) ?? false),
  };
}

function sortFiles(files: Iterable<SourceFile>): SourceFile[] {
  return [...files].sort((a, b) => compareStrings(a.server, b.server));
}

/**
 * What one `--file` argument names: a source file in every language, or the translation
 * files of `languages` that it is. Throws a usage error when it names nothing.
 */
function resolveFileArg(
  project: Project,
  sources: Sources,
  cwd: string,
  arg: string,
  languages: readonly string[],
): NamedFile[] {
  const server = sources.byServer.get(arg.replaceAll("\\", "/").replace(/^(\.\/)+/, ""));
  if (server) return [{ file: server, language: null }];
  const local = projectPath(project, resolve(cwd, arg));
  const source = local === null ? undefined : sources.byLocal.get(local);
  if (source) return [{ file: source, language: null }];
  const found: NamedFile[] = [];
  if (local !== null) {
    const lower = local.toLowerCase();
    for (const file of sources.files) {
      for (const language of languages) {
        if (translationPath(project, file, language).toLowerCase() === lower) {
          found.push({ file, language });
        }
      }
    }
  }
  if (found.length > 0) return found;
  const known = sources.files
    .slice(0, 10)
    .map((source) => source.server)
    .join(", ");
  const more = sources.files.length > 10 ? ", …" : "";
  throw usageError(`${arg} isn't one of the source files of ${project.configName}.`, {
    code: "unknown_file",
    hint: `Name a file by its server path (${known}${more}) or by its local path.`,
  });
}
