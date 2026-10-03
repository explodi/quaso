// SPDX-License-Identifier: MIT
/**
 * Path patterns and query strings for the router, without React: `/languages/:lang`
 * matches `/languages/de`, `/translate/:lang/*file` matches `/translate/de/menus/main.json`
 * with `file` = `menus/main.json`.
 */

export type Params = Record<string, string>;

type Segment =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "splat"; name: string };

export interface CompiledPattern {
  pattern: string;
  segments: Segment[];
}

const compiled = new Map<string, CompiledPattern>();

/**
 * Compiles a pattern: `/` separated segments, each static text, `:name` (one segment) or,
 * last, `*name` (the rest of the path, at least one segment).
 */
export function compilePattern(pattern: string): CompiledPattern {
  let result = compiled.get(pattern);
  if (result) return result;
  const parts = splitPath(pattern);
  const segments = parts.map((part, index): Segment => {
    if (part.startsWith(":")) return { type: "param", name: part.slice(1) };
    if (part.startsWith("*")) {
      if (index !== parts.length - 1) throw new Error(`${pattern}: *${part} must come last`);
      return { type: "splat", name: part.slice(1) };
    }
    return { type: "static", value: part };
  });
  result = { pattern, segments };
  compiled.set(pattern, result);
  return result;
}

/** The path's segments, without empty ones (so a trailing slash doesn't matter). */
function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The parameters if the path matches the pattern, otherwise null. */
export function matchPath(pattern: string | CompiledPattern, pathname: string): Params | null {
  const { segments } = typeof pattern === "string" ? compilePattern(pattern) : pattern;
  const parts = splitPath(pathname);
  const params: Params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type === "splat") {
      const rest = parts.slice(i);
      if (rest.length === 0) return null;
      const value = decode(rest.join("/"));
      if (value === null) return null;
      params[segment.name] = value;
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    const value = decode(part);
    if (value === null) return null;
    if (segment.type === "static") {
      if (value !== segment.value) return null;
    } else {
      params[segment.name] = value;
    }
  }
  return parts.length === segments.length ? params : null;
}

/** The first route whose pattern matches, with its parameters. */
export function matchRoutes<R extends { path: string }>(
  routes: readonly R[],
  pathname: string,
): { route: R; params: Params } | null {
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

/** A query string's values by name (the last one wins), without the leading `?`. */
export function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(search)) query[name] = value;
  return query;
}

export type QueryInput = Record<string, string | number | boolean | null | undefined>;

/** A query string with a leading `?`, or "" if every value is empty. */
export function buildQuery(query: QueryInput): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(name, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** A path with a query: `href("/translate/de", { file: "a.json" })`. */
export function href(pathname: string, query: QueryInput = {}): string {
  return pathname + buildQuery(query);
}

/** A path with each parameter filled in and encoded: `/languages/:lang` → `/languages/pt-BR`. */
export function fillPattern(pattern: string, params: Params): string {
  const { segments } = compilePattern(pattern);
  const parts = segments.map((segment) => {
    if (segment.type === "static") return encodeURIComponent(segment.value);
    const value = params[segment.name];
    if (value === undefined) throw new Error(`${pattern}: no value for ${segment.name}`);
    if (segment.type === "splat") return value.split("/").map(encodeURIComponent).join("/");
    return encodeURIComponent(value);
  });
  return `/${parts.join("/")}`;
}

/** A stand-in origin to resolve paths against, where `location` may not exist. */
const HERE = "https://here.invalid";

/**
 * A safe place to go back to after signing in: a path on this site, or "/" otherwise.
 *
 * The candidate is resolved as the browser would resolve it, and kept only if it stays on
 * this origin. Checking the text alone isn't enough: the URL parser drops tabs and line
 * breaks (`/\t/evil.example` is `//evil.example`), turns `\` into `/`, and removes dot
 * segments (`/.//evil.example`), and any of these makes a path into another site's address.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, HERE);
  } catch {
    return "/";
  }
  if (url.origin !== HERE) return "/";
  const path = url.pathname + url.search + url.hash;
  // A path that normalizes to `//host` is another site's address wherever it is used.
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
