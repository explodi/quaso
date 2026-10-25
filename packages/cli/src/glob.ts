// SPDX-License-Identifier: MIT
/**
 * Walking folders with a glob (design §5.10; the patterns are core's `globToRegExp`).
 * Walking skips `node_modules`, folders whose name starts with a dot, and symbolic links
 * to folders (which could loop). Links to files are listed, so that reading one is a clear
 * error (`readProjectText`). Results are sorted, so every machine sends the same order.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expandBraces, globBase, globToRegExp } from "@quaso/core";

/**
 * The files below `root` that match `pattern`, and none of `exclude`: paths relative to
 * `root` with `/` separators, sorted.
 */
export async function glob(
  root: string,
  pattern: string,
  options: { exclude?: readonly string[] } = {},
): Promise<string[]> {
  const match = globToRegExp(pattern);
  const excludes = (options.exclude ?? []).map((pattern) => globToRegExp(pattern));
  const patterns = expandBraces(pattern);
  const deep = patterns.some((item) => item.split("/").includes("**"));
  const maxDepth = deep ? Infinity : Math.max(...patterns.map((item) => item.split("/").length));
  const base = globBase(pattern);
  const found: string[] = [];
  await walk(root, base, base === "" ? 0 : base.split("/").length, maxDepth, (path) => {
    if (match.test(path) && !excludes.some((exclude) => exclude.test(path))) found.push(path);
  });
  return found.sort(compareStrings);
}

/** Code-unit order: the same on every machine and locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Calls `visit` with every file below `dir` (relative to `root`), down to `maxDepth`
 * segments, skipping `node_modules`, dot folders and linked folders.
 */
export async function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  visit: (path: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir === "" ? root : join(root, ...dir.split("/")), {
      withFileTypes: true,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    let isFile = entry.isFile();
    let isFolder = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isFile = (await stat(join(root, ...path.split("/")))).isFile();
      } catch {
        isFile = false;
      }
      isFolder = false;
    }
    if (isFolder) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (depth + 1 < maxDepth) await walk(root, path, depth + 1, maxDepth, visit);
    } else if (isFile) {
      visit(path);
    }
  }
}
