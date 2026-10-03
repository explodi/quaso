// SPDX-License-Identifier: MIT
/**
 * A small glob implementation (design §5.10): `**`, `*`, `?`, `{a,b}` and character classes
 * (`[abc]`, `[a-z]`, `[!abc]`), over paths with `/` separators, relative to a folder.
 * Walking skips `node_modules`, folders whose name starts with a dot, and symbolic links
 * to folders (which could loop). Results are sorted, so every machine sends the same order.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Characters that make a path segment a pattern. */
const MAGIC = /[*?[\]{}]/;

/** The most patterns `{a,b}` groups may expand to. */
const MAX_EXPANSIONS = 1000;

/**
 * The folder where a glob starts: its segments before the first one with a wildcard, such
 * as `src/locales/en` for `src/locales/en/**\/*.json`. For a pattern without wildcards
 * (a single file), its folder. `""` for the project folder itself.
 */
export function globBase(pattern: string): string {
  const parts = pattern.split("/");
  const first = parts.findIndex((part) => MAGIC.test(part));
  return parts.slice(0, first === -1 ? parts.length - 1 : first).join("/");
}

/** Whether a pattern has wildcards. */
export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern);
}

/**
 * Expands `{a,b}` groups: `{en,de}/*.json` → `en/*.json`, `de/*.json`. Groups nest; a group
 * without a comma, or an unbalanced brace, stays literal.
 */
export function expandBraces(pattern: string): string[] {
  const results: string[] = [];
  const pending = [pattern];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = findGroup(current);
    if (group === null) {
      results.push(current);
    } else {
      const prefix = current.slice(0, group.start);
      const suffix = current.slice(group.end + 1);
      for (const alternative of group.alternatives.toReversed()) {
        pending.push(prefix + alternative + suffix);
      }
    }
    if (results.length + pending.length > MAX_EXPANSIONS) {
      throw new Error(`"${pattern}" expands to more than ${MAX_EXPANSIONS} patterns`);
    }
  }
  return results;
}

/** The first `{…}` group with at least two alternatives, outside character classes. */
function findGroup(pattern: string): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start < pattern.length; start++) {
    const char = pattern[start];
    if (char === "[") {
      const end = classEnd(pattern, start);
      if (end !== -1) start = end;
      continue;
    }
    if (char !== "{") continue;
    let depth = 0;
    const alternatives: string[] = [];
    let from = start + 1;
    for (let index = start; index < pattern.length; index++) {
      const inner = pattern[index];
      if (inner === "[") {
        const end = classEnd(pattern, index);
        if (end !== -1) index = end;
      } else if (inner === "{") {
        depth++;
      } else if (inner === "}") {
        depth--;
        if (depth === 0) {
          alternatives.push(pattern.slice(from, index));
          if (alternatives.length >= 2) return { start, end: index, alternatives };
          break;
        }
      } else if (inner === "," && depth === 1) {
        alternatives.push(pattern.slice(from, index));
        from = index + 1;
      }
    }
  }
  return null;
}

/** The index of the `]` that closes the class opened at `start`, or -1. */
function classEnd(pattern: string, start: number): number {
  let index = start + 1;
  if (pattern[index] === "!" || pattern[index] === "^") index++;
  if (pattern[index] === "]") index++;
  const end = pattern.indexOf("]", index);
  const slash = pattern.indexOf("/", start);
  return end === -1 || (slash !== -1 && slash < end) ? -1 : end;
}

/** A regular expression that matches the paths a glob matches (with `/` separators). */
export function globToRegExp(pattern: string): RegExp {
  const sources = expandBraces(pattern).map(patternSource);
  return new RegExp(`^(?:${sources.join("|")})$`);
}

function patternSource(pattern: string): string {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += segmentSource(segment) + (last ? "" : "/");
  });
  return source;
}

function segmentSource(segment: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char === "*") {
      source += "[^/]*";
      while (segment[index + 1] === "*") index++;
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[" && classEnd(segment, index) !== -1) {
      const end = classEnd(segment, index);
      let body = segment.slice(index + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      body = body.replace(/[\\\]^[]/g, "\\$&");
      source += negate ? `[^/${body}]` : `[${body}]`;
      index = end;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return source;
}

/**
 * A path that the glob matches, such as `src/locales/en/x.json` for
 * `src/locales/en/**\/*.json`, to test what a pattern would do with it; null when none is
 * found this simply.
 */
export function globSample(pattern: string): string | null {
  const [first] = expandBraces(pattern);
  const segments: string[] = [];
  for (const segment of first.split("/")) {
    if (segment === "**") continue;
    let sample = "";
    for (let index = 0; index < segment.length; index++) {
      const char = segment[index];
      if (char === "*") {
        sample += "x";
        while (segment[index + 1] === "*") index++;
      } else if (char === "?") {
        sample += "x";
      } else if (char === "[" && classEnd(segment, index) !== -1) {
        const end = classEnd(segment, index);
        const body = segment.slice(index + 1, end);
        sample += body.startsWith("!") || body.startsWith("^") ? "x" : body[0];
        index = end;
      } else {
        sample += char;
      }
    }
    segments.push(sample);
  }
  const sample = segments.join("/");
  return sample !== "" && globToRegExp(pattern).test(sample) ? sample : null;
}

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
  const excludes = (options.exclude ?? []).map(globToRegExp);
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
