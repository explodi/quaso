// SPDX-License-Identifier: MIT
/**
 * A small router on `URLPattern` (design §3, "Standard APIs"): routes by method and path
 * pattern, such as `GET /api/v1/strings/:id`. HEAD requests use the GET routes.
 */

/** Path parameters by name, decoded. */
export type Params = Record<string, string>;

/** What `match` finds. */
export type RouteMatch<H> =
  | { found: true; handler: H; params: Params }
  /** The path exists, but not with this method. */
  | { found: false; allowed: string[] }
  /** No route has the path. */
  | null;

interface Route<H> {
  method: string;
  pattern: URLPattern;
  handler: H;
}

export class Router<H> {
  readonly #routes: Route<H>[] = [];

  /** Adds a route. `path` uses `URLPattern` syntax: `/strings/:id`. */
  add(method: string, path: string, handler: H): this {
    this.#routes.push({ method, pattern: new URLPattern({ pathname: path }), handler });
    return this;
  }

  /** The route for a method and path. */
  match(method: string, pathname: string): RouteMatch<H> {
    const wanted = method === "HEAD" ? "GET" : method;
    const allowed = new Set<string>();
    for (const route of this.#routes) {
      const result = route.pattern.exec({ pathname });
      if (!result) continue;
      if (route.method === wanted) {
        return { found: true, handler: route.handler, params: decodeParams(result) };
      }
      allowed.add(route.method);
      if (route.method === "GET") allowed.add("HEAD");
    }
    return allowed.size > 0 ? { found: false, allowed: [...allowed] } : null;
  }
}

function decodeParams(result: URLPatternResult): Params {
  const params: Params = {};
  for (const [name, value] of Object.entries(result.pathname.groups)) {
    if (value === undefined) continue;
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      params[name] = value;
    }
  }
  return params;
}
