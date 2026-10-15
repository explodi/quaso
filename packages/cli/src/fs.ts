// SPDX-License-Identifier: MIT
/**
 * Reading and writing files for the commands, with the safety rules of design §5.10
 * (CLI-5): reads, writes and deletions refuse a project path with a symbolic link on it, so
 * a committed link can't send an ignored file (`.env`) to the instance, or have a download
 * write somewhere else (`.git/hooks`).
 */
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * (exit code 2) a path with a symbolic link on it, even a link that stays inside the
 * project: what the CLI sends to the instance is what the repository holds as regular files.
 */
export async function readProjectText(project: Project, path: string): Promise<string | null> {
  const refuse = (why: string, hint: string) =>
    usageError(`Refusing to read ${path}: ${why}.`, { code: "unsafe_path", hint });
  if (projectPath(project, absolutePath(project, path)) !== path) {
    throw refuse(
      "it is outside the project folder",
      `The CLI only sends files inside the folder of ${project.configName}.`,
    );
  }
  const obstacle = await firstObstacle(project, path);
  if (obstacle?.kind === "file") return null;
  if (obstacle?.kind === "link") {
    throw refuse(
      `${obstacle.path} is a symbolic link`,
      `Replace ${obstacle.path} with a regular file or folder: the CLI doesn't follow ` +
        "symbolic links in the project.",
    );
  }
  return await readText(absolutePath(project, path), path);
}

/**
 * What stands in the way on a project path, from the project folder down to the file: the
 * first symbolic link, or the first file where a folder should be. Null when there is
 * neither, also when the end of the path doesn't exist yet.
 */
async function firstObstacle(
  project: Project,
  path: string,
): Promise<{ path: string; kind: "link" | "file" } | null> {
  const segments = path.split("/");
  for (let count = 1; count <= segments.length; count++) {
    const partial = segments.slice(0, count).join("/");
    let found;
    try {
      found = await lstat(absolutePath(project, partial));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new CliError(EXIT.unexpected, `Can't read ${partial}: ${describeFsError(error)}.`, {
        code: "io",
      });
    }
    if (found.isSymbolicLink()) return { path: partial, kind: "link" };
    const isFolderOnPath = count < segments.length;
    if (isFolderOnPath && !found.isDirectory()) return { path: partial, kind: "file" };
  }
  return null;
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
 * Checks files the CLI writes or deletes: no symbolic link on their path, a file (or
 * nothing yet) at its end, and not a source file under another name.
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
    const refuse = (why: string, hint?: string) =>
      usageError(`Refusing to write ${path} (${language}): ${why}.`, { code: "unsafe_path", hint });
    const obstacle = await firstObstacle(this.#project, path);
    if (obstacle?.kind === "link") {
      throw refuse(
        `${obstacle.path} is a symbolic link`,
        `Replace ${obstacle.path} with a regular file or folder: the CLI doesn't write ` +
          "through symbolic links.",
      );
    }
    if (obstacle?.kind === "file") throw refuse(`${obstacle.path} is a file, not a folder`);
    try {
      const found = await lstat(absolutePath(this.#project, path));
      if (!found.isFile()) throw refuse("it isn't a file");
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    // A source glob's base folder may be a link (only reading the source refuses it), and
    // then this very file may be a source file.
    const real = join(await projectRoot(this.#project), ...path.split("/"));
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
