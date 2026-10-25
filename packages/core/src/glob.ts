// SPDX-License-Identifier: MIT
/**
 * Glob patterns (design §5.10): `**`, `*`, `?`, `{a,b}` and character classes (`[abc]`,
 * `[a-z]`, `[!abc]`), over paths with `/` separators, or another separator such as the `.`
 * of a key path (`posts.*`). `*` and `?` stay within one segment; `**` spans segments. The
 * CLI walks folders with them; the service matches file and key paths.
 */

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
export function expandBraces(pattern: string, separator = "/"): string[] {
  const results: string[] = [];
  const pending = [pattern];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = findGroup(current, separator);
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
function findGroup(
  pattern: string,
  separator: string,
): { start: number; end: number; alternatives: string[] } | null {
  for (let start = 0; start < pattern.length; start++) {
    const char = pattern[start];
    if (char === "[") {
      const end = classEnd(pattern, start, separator);
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
        const end = classEnd(pattern, index, separator);
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
function classEnd(pattern: string, start: number, separator: string): number {
  let index = start + 1;
  if (pattern[index] === "!" || pattern[index] === "^") index++;
  if (pattern[index] === "]") index++;
  const end = pattern.indexOf("]", index);
  const boundary = pattern.indexOf(separator, start);
  return end === -1 || (boundary !== -1 && boundary < end) ? -1 : end;
}

/**
 * A regular expression that matches the paths a glob matches, with `/` separators, or the
 * given one: `.` for key paths, where `posts.*` matches `posts.welcome` but not
 * `posts.welcome.title`, and `posts.**` matches both.
 */
export function globToRegExp(pattern: string, separator = "/"): RegExp {
  const sources = expandBraces(pattern, separator).map((item) => patternSource(item, separator));
  return new RegExp(`^(?:${sources.join("|")})$`);
}

function patternSource(pattern: string, separator: string): string {
  const escaped = escapeRegExp(separator);
  const segments = pattern.split(separator);
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") source += last ? ".*" : `(?:[^${escaped}]+${escaped})*`;
    else source += segmentSource(segment, separator) + (last ? "" : escaped);
  });
  return source;
}

function segmentSource(segment: string, separator: string): string {
  const escaped = escapeRegExp(separator);
  let source = "";
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char === "*") {
      source += `[^${escaped}]*`;
      while (segment[index + 1] === "*") index++;
    } else if (char === "?") {
      source += `[^${escaped}]`;
    } else if (char === "[" && classEnd(segment, index, separator) !== -1) {
      const end = classEnd(segment, index, separator);
      let body = segment.slice(index + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      body = body.replace(/[\\\]^[]/g, "\\$&");
      source += negate ? `[^${escaped}${body}]` : `[${body}]`;
      index = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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
      } else if (char === "[" && classEnd(segment, index, "/") !== -1) {
        const end = classEnd(segment, index, "/");
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

/** Why a glob can't be used (such as `[z-a]`), or null. */
export function globProblem(pattern: string, separator = "/"): string | null {
  try {
    globToRegExp(pattern, separator);
    return null;
  } catch (error) {
    return `isn't a valid glob: ${error instanceof Error ? error.message : String(error)}`;
  }
}
