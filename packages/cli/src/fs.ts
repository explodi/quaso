// SPDX-License-Identifier: MIT
/**
 * Reading and writing files for the commands, with the safety rules of design §5.10
 * (CLI-5): reads, writes and deletions check the real path (after symbolic links), so a
 * link can't lead outside the project, or a write onto a source file.
 */
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { describeFsError, type Project } from "./config.ts";
import { CliError, EXIT, usageError } from "./errors.ts";
import { absolutePath, projectPath, type Sources } from "./files.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** UTF-8 bytes of a text. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** A file's bytes, or null when it doesn't exist (or a folder on its path is a file). */
export async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "EISDIR") throw usageError(`${path} is a folder, not a file.`);
    throw new CliError(EXIT.unexpected, `Can't read ${path}: ${describeFsError(error)}.`, {
      code: "io",
    });
  }
}

const projectRoots = new WeakMap<Project, Promise<string>>();

/** The project folder's real path (after symbolic links). */
function projectRoot(project: Project): Promise<string> {
  let root = projectRoots.get(project);
  if (root === undefined) {
    root = realpath(project.dir);
    projectRoots.set(project, root);
  }
  return root;
}

/**
 * A project file (a project path) as UTF-8 text, or null when it doesn't exist. Refuses
 * (exit code 2) a file that a symbolic link leads outside the project folder: what the CLI
 * sends to the instance comes from the project only (CLI-5).
 */
export async function readProjectText(project: Project, path: string): Promise<string | null> {
  const absolute = absolutePath(project, path);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new CliError(EXIT.unexpected, `Can't read ${path}: ${describeFsError(error)}.`, {
      code: "io",
    });
  }
  if (!inside(await projectRoot(project), real)) {
    throw usageError(
      `Refusing to read ${path}: a symbolic link leads outside the project folder.`,
      {
        code: "unsafe_path",
        hint:
          "The CLI only sends files that are inside the folder of " +
          `${project.configName}. Copy the file into the project instead of linking it.`,
      },
    );
  }
  return await readText(absolute, path);
}

/**
 * A file as UTF-8 text, or null when it doesn't exist. Invalid UTF-8 is an invalid source
 * file (exit code 5), named by `display`.
 */
export async function readText(path: string, display: string): Promise<string | null> {
  const bytes = await readBytes(path);
  if (bytes === null) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CliError(EXIT.invalidSource, `${display} isn't valid UTF-8.`, {
      code: "invalid_source",
      details: [{ file: display, message: "isn't valid UTF-8 text" }],
    });
  }
}

/** SHA-256 of bytes, as lowercase hex. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Checks the real location of files the CLI writes or deletes: inside the project folder
 * after following links, not a link itself, and not a source file under another name.
 */
export class RealPathGuard {
  readonly #project: Project;
  readonly #sources: Sources;
  #sourcePaths?: Set<string>;

  constructor(project: Project, sources: Sources) {
    this.#project = project;
    this.#sources = sources;
  }

  /** Throws a usage error (exit code 2) when `path` (a project path) isn't safe to change. */
  async check(path: string, language: string): Promise<void> {
    const refuse = (why: string) =>
      usageError(`Refusing to write ${path} (${language}): ${why}.`, { code: "unsafe_path" });
    const root = await projectRoot(this.#project);
    const target = absolutePath(this.#project, path);
    const folder = await realExisting(dirname(target));
    const real = join(folder.real, ...folder.missing, basename(target));
    if (!inside(root, real)) throw refuse("a linked folder leads outside the project folder");
    if (!(await stat(folder.real)).isDirectory()) {
      const name = projectPath(this.#project, folder.path) ?? folder.path;
      throw refuse(`${name} is a file, not a folder`);
    }
    try {
      const found = await lstat(target);
      if (found.isSymbolicLink()) throw refuse("it is a symbolic link");
      if (!found.isFile()) throw refuse("it isn't a file");
    } catch (error) {
      if (error instanceof CliError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "ENOTDIR") throw refuse("a folder on its path is a file");
      if (code !== "ENOENT") throw error;
    }
    if ((await this.#sourceRealPaths()).has(real.toLowerCase())) {
      throw refuse("a linked folder makes it a source file");
    }
  }

  async #sourceRealPaths(): Promise<Set<string>> {
    if (this.#sourcePaths === undefined) {
      const paths = new Set<string>();
      for (const source of this.#sources.files) {
        try {
          paths.add((await realpath(absolutePath(this.#project, source.local))).toLowerCase());
        } catch {
          // Gone meanwhile.
        }
      }
      this.#sourcePaths = paths;
    }
    return this.#sourcePaths;
  }
}

/**
 * The nearest existing path at or above `path` (which may be a file, where a folder was
 * expected), its real path, and the missing folders below it.
 */
async function realExisting(
  path: string,
): Promise<{ path: string; real: string; missing: string[] }> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      return { path: current, real: await realpath(current), missing };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Writes a file through a temporary file and a rename, so that it is never half-written,
 * creating its folders.
 */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${Math.random().toString(36).slice(2, 10)}.quaso-tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  } catch (error) {
    throw new CliError(EXIT.unexpected, `Can't write ${path}: ${describeFsError(error)}.`, {
      code: "io",
    });
  }
}

export async function removeFile(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    throw new CliError(EXIT.unexpected, `Can't delete ${path}: ${describeFsError(error)}.`, {
      code: "io",
    });
  }
}
