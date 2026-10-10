// SPDX-License-Identifier: MIT
/**
 * Connecting and the config file (design §5.10, CLI-2, S4.2): `quaso.config.json` in the
 * current folder or the nearest parent, checked with the core schema and a few rules of
 * our own; `QUASO_HOSTNAME` (which wins over `hostname` in the config) and `QUASO_API_KEY`
 * (only ever from the environment).
 */
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalLanguageTag,
  formatPath,
  JsonSyntaxError,
  parseJson,
  QuasoConfig,
  toPlain,
  validate,
} from "@quaso/core";
import { CliError, EXIT, type Problem, usageError } from "./errors.ts";
import { globBase, globSample, globToRegExp } from "./glob.ts";
import { invalidKeyError } from "./http.ts";
import type { Env } from "./output.ts";

export const CONFIG_FILE = "quaso.config.json";

/** A project: its folder and its checked config. */
export interface Project {
  /** The folder of the config file, absolute. Nothing is ever written outside it. */
  dir: string;
  /** The config file, absolute. */
  configPath: string;
  /** The config file's name, for messages (it is in the project folder). */
  configName: string;
  /** The config, with its patterns normalized (no `./` segments). */
  config: QuasoConfig;
  /** The source language, canonical (`pt-BR`, `zh-Hans`). */
  sourceLanguage: string;
  /** The config's languages, canonical, in its order. */
  languages: string[];
  /**
   * What `{lang}` becomes, by canonical tag, for the source language and the config's
   * languages: the `languageMapping`, or the tag as the config spells it.
   */
  folders: Map<string, string>;
}

/** The config file in `start` or the nearest parent that has one, or null. */
export async function findConfig(start: string): Promise<string | null> {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, CONFIG_FILE);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Finds, reads and checks the config: `--config` if given, else the nearest one. */
export async function loadProject(cwd: string, configOption?: string): Promise<Project> {
  const path = configOption === undefined ? await findConfig(cwd) : resolve(cwd, configOption);
  if (path === null) {
    throw usageError(`No ${CONFIG_FILE} in ${cwd} or its parent folders.`, {
      code: "config_not_found",
      hint: "Create one with: quaso init --languages de,fr (or point to one with --config <path>).",
    });
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw usageError(`Can't read ${path}: ${describeFsError(error)}.`, {
      code: "config_not_found",
    });
  }
  const name = basename(path);
  const { config, problems } = parseConfig(text, name);
  if (config === null || problems.length > 0) {
    throw usageError(
      problems.length === 1 ? `${name} is invalid.` : `${name} has ${problems.length} problems.`,
      { code: "invalid_config", details: problems },
    );
  }
  return {
    dir: dirname(path),
    configPath: path,
    configName: name,
    config,
    sourceLanguage: canonical(config.sourceLanguage),
    languages: config.languages.map(canonical),
    folders: languageFolders(config),
  };
}

/** What `{lang}` becomes for the source language and each of the config's languages. */
function languageFolders(config: QuasoConfig): Map<string, string> {
  const mapping = new Map(
    Object.entries(config.languageMapping ?? {}).map(([tag, folder]) => [canonical(tag), folder]),
  );
  const folders = new Map<string, string>();
  for (const tag of [config.sourceLanguage, ...config.languages]) {
    folders.set(canonical(tag), mapping.get(canonical(tag)) ?? tag);
  }
  for (const [tag, folder] of mapping) if (!folders.has(tag)) folders.set(tag, folder);
  return folders;
}

/** A language tag's canonical form (the tag itself if it isn't valid). */
export function canonical(tag: string): string {
  return canonicalLanguageTag(tag) ?? tag;
}

/** What `{lang}` becomes for a language: its `languageMapping`, or its tag. */
export function languageFolder(project: Project, language: string): string {
  return project.folders.get(canonical(language)) ?? language;
}

/**
 * Parses and checks a config's text. Returns every problem at once, with the file, line and
 * column for syntax errors, and the property path (`files[0].translation`) for the rest.
 */
export function parseConfig(
  text: string,
  name = CONFIG_FILE,
): { config: QuasoConfig | null; problems: Problem[] } {
  let plain: unknown;
  try {
    plain = toPlain(parseJson(text, { file: name }).root);
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    return {
      config: null,
      problems: [{ file: name, line: error.line, column: error.column, message: error.detail }],
    };
  }
  const result = validate(QuasoConfig, plain);
  if (!result.ok) {
    return {
      config: null,
      problems: result.issues.map((issue) => {
        const key = formatPath(issue.path);
        const message = /^(api_?key|token|secret)$/i.test(key)
          ? `${issue.message}: the API key only ever comes from QUASO_API_KEY`
          : issue.message;
        return key === "" ? { file: name, message } : { file: name, key, message };
      }),
    };
  }
  const config = result.value;
  const problems: Problem[] = [];
  const problem = (key: string, message: string) => problems.push({ file: name, key, message });

  // Languages.
  const source = canonical(config.sourceLanguage);
  const seen = new Map<string, number>();
  config.languages.forEach((tag, index) => {
    const tagCanonical = canonical(tag);
    if (tagCanonical === source) {
      problem(`languages[${index}]`, `${tag} is the source language; it is never a target`);
    }
    const previous = seen.get(tagCanonical);
    if (previous !== undefined) {
      problem(`languages[${index}]`, `${tag} is the same language as languages[${previous}]`);
    }
    seen.set(tagCanonical, index);
  });
  for (const [index, tag] of (config.translationsInRepository ?? []).entries()) {
    if (!seen.has(canonical(tag)))
      problem(
        `translationsInRepository[${index}]`,
        `${tag} must be a target language in languages`,
      );
  }
  for (const [tag, folder] of Object.entries(config.languageMapping ?? {})) {
    const key = formatPath(["languageMapping", tag]);
    if (canonicalLanguageTag(tag) === null) {
      problem(key, `"${tag}" is not a valid BCP 47 language tag`);
    }
    if (/[/\\{}]/.test(folder) || folder === "." || folder === ".." || folder.trim() !== folder) {
      problem(key, `"${folder}" can't be a folder or file name: no /, \\, { or }, and not . or ..`);
    }
  }
  const byFolder = new Map<string, string>();
  for (const [tag, folder] of languageFolders(config)) {
    const other = byFolder.get(folder.toLowerCase());
    if (other !== undefined) {
      problem("languageMapping", `${other} and ${tag} would share the name "${folder}"`);
    }
    byFolder.set(folder.toLowerCase(), tag);
  }

  // Patterns.
  const files = config.files.map((mapping, index) => {
    const sourceKey = `files[${index}].source`;
    const translationKey = `files[${index}].translation`;
    const sourcePattern = normalizePattern(mapping.source);
    if (typeof sourcePattern !== "string") problem(sourceKey, sourcePattern.problem);
    else if (/\{(lang|path)\}/.test(sourcePattern)) {
      problem(sourceKey, "is a glob of the source files: {lang} and {path} go in translation");
    } else {
      const invalid = globProblem(sourcePattern);
      if (invalid) problem(sourceKey, invalid);
    }
    const translation = normalizePattern(mapping.translation);
    if (typeof translation !== "string") problem(translationKey, translation.problem);
    else {
      for (const token of translation.match(/\{[^{}]*\}/g) ?? []) {
        if (token !== "{lang}" && token !== "{path}") {
          problem(translationKey, `has an unknown placeholder ${token}: use {lang} and {path}`);
        }
      }
    }
    const exclude = (mapping.exclude ?? []).map((pattern, excludeIndex) => {
      const normalized = normalizePattern(pattern);
      const invalid = typeof normalized === "string" ? globProblem(normalized) : normalized.problem;
      if (invalid) problem(`files[${index}].exclude[${excludeIndex}]`, invalid);
      return typeof normalized === "string" ? normalized : pattern;
    });
    return {
      ...mapping,
      source: typeof sourcePattern === "string" ? sourcePattern : mapping.source,
      translation: typeof translation === "string" ? translation : mapping.translation,
      ...(mapping.exclude ? { exclude } : {}),
    };
  });
  const checked = { ...config, files };
  if (problems.length === 0) {
    for (const found of translationsInSources(checked)) problem(found.key, found.message);
  }
  return { config: checked, problems };
}

/** Why a glob can't be used (such as `[z-a]`), or null. */
function globProblem(pattern: string): string | null {
  try {
    globToRegExp(pattern);
    return null;
  } catch (error) {
    return `isn't a valid glob: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Translation patterns that write into a source glob (CLI-5), such as `locales/{lang}/{path}`
 * with the source `locales/**\/*.json`: the next upload would send the translations as
 * source files. Tried with a file each source glob matches, in each of the config's
 * languages; `download` checks every real path again before writing.
 */
function translationsInSources(config: QuasoConfig): { key: string; message: string }[] {
  const globs = config.files.map((mapping) => ({
    source: globToRegExp(mapping.source),
    exclude: (mapping.exclude ?? []).map(globToRegExp),
  }));
  const folders = languageFolders(config);
  const source = canonical(config.sourceLanguage);
  const found: { key: string; message: string }[] = [];
  config.files.forEach((mapping, index) => {
    const sample = globSample(mapping.source);
    if (sample === null || globs[index].exclude.some((glob) => glob.test(sample))) return;
    const base = globBase(mapping.source);
    const server = base === "" ? sample : sample.slice(base.length + 1);
    for (const [tag, folder] of folders) {
      if (tag === source) continue;
      const output = mapping.translation.replaceAll("{lang}", folder).replaceAll("{path}", server);
      const other = globs.findIndex(
        (glob) => glob.source.test(output) && !glob.exclude.some((exclude) => exclude.test(output)),
      );
      if (other === -1) continue;
      found.push({
        key: `files[${index}].translation`,
        message:
          `writes translations such as ${output}, which files[${other}].source also ` +
          "matches, so quaso upload would send them as source files: add the translations' " +
          `folders to files[${other}].exclude, or change the patterns`,
      });
      return;
    }
  });
  return found;
}

/**
 * A pattern relative to the project folder, with `/` separators: `./` segments removed;
 * absolute paths, `\`, `..` and empty segments refused.
 */
export function normalizePattern(pattern: string): string | { problem: string } {
  if (pattern.includes("\\")) return { problem: "must use / as the separator, not \\" };
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) {
    return { problem: "must be relative to the folder of quaso.config.json" };
  }
  const segments = pattern.split("/").filter((segment) => segment !== ".");
  if (segments.includes("..")) {
    return { problem: "must stay inside the folder of quaso.config.json (no ..)" };
  }
  if (segments.length === 0 || segments.includes("")) {
    return { problem: "must not have empty segments (//) or end with /" };
  }
  return segments.join("/");
}

/**
 * The instance's base URL, from `QUASO_HOSTNAME` or else the config's `hostname`:
 * `https://` + a hostname, or a full URL such as `http://localhost:8000`.
 */
export function serverUrl(env: Env, project?: Project | null): string {
  const fromEnv = env.QUASO_HOSTNAME?.trim();
  if (fromEnv) return parseServerUrl(fromEnv, "QUASO_HOSTNAME");
  const fromConfig = project?.config.hostname?.trim();
  if (fromConfig) return parseServerUrl(fromConfig, `hostname in ${CONFIG_FILE}`);
  throw usageError("Which Quaso instance? QUASO_HOSTNAME isn't set.", {
    code: "missing_hostname",
    hint:
      `Set QUASO_HOSTNAME to the instance's hostname, such as translate.yourgame.com, ` +
      `or add "hostname" to ${CONFIG_FILE}.`,
  });
}

/** Parses a hostname or a URL into a base URL without a trailing slash. */
export function parseServerUrl(value: string, source: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw usageError(`${source} is neither a hostname nor a URL: "${value}".`, {
      code: "invalid_hostname",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usageError(`${source} must be an http:// or https:// address, not "${value}".`, {
      code: "invalid_hostname",
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw usageError(`${source} must not contain a user name or password.`, {
      code: "invalid_hostname",
      hint: "The API key goes in QUASO_API_KEY.",
    });
  }
  if (url.search !== "" || url.hash !== "") {
    throw usageError(`${source} must not have a query or a fragment: "${value}".`, {
      code: "invalid_hostname",
    });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The API key, from `QUASO_API_KEY` only: printable ASCII without spaces, as every key is.
 * Anything else (a smart quote, a line break) is refused without echoing it.
 */
export function apiKey(env: Env): string {
  const key = env.QUASO_API_KEY?.trim();
  if (key) {
    if (!/^[\x21-\x7e]+$/.test(key)) throw invalidKeyError();
    return key;
  }
  throw new CliError(EXIT.auth, "QUASO_API_KEY isn't set.", {
    code: "missing_key",
    hint:
      "Set QUASO_API_KEY to an API key of the instance: the upload scope for upload and " +
      "import, read for download and status. An administrator creates keys.",
  });
}

/** A file system error for people: `no such file`, or the error's message. */
export function describeFsError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case "ENOENT":
      return "no such file or folder";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "it is a folder";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
