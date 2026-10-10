// SPDX-License-Identifier: MIT
/**
 * The website from the Worker's static assets (the Vite build), with the server's security
 * headers, so that it is on screen at once while a sleeping container starts. As on the
 * server, any page path that isn't a file gets `index.html`, and a missing build file under
 * `/assets/` stays a 404.
 */
import { CACHE, setSecurityHeaders } from "../../server/src/http/headers.ts";

export async function serveWebsite(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const buildFile = url.pathname.startsWith("/assets/");
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && !buildFile) {
    await response.body?.cancel();
    response = await env.ASSETS.fetch(new Request(new URL("/", url), request));
  }
  const headers = new Headers(response.headers);
  const turnstile = (env as unknown as Record<string, unknown>).TURNSTILE_SITE_KEY;
  setSecurityHeaders(headers, {
    hsts: env.PUBLIC_URL.startsWith("https:"),
    turnstile: typeof turnstile === "string" && turnstile.trim() !== "",
  });
  // The HTML is revalidated every time: a page kept from before a deployment would ask
  // for build files that the deployment removed.
  const immutable = buildFile && response.ok;
  headers.set("Cache-Control", immutable ? CACHE.immutable : "no-cache");
  return new Response(response.body, { status: response.status, headers });
}
