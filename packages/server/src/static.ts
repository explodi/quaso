// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The website's files (design §5.9, §5.12): the Vite build in `WEB_DIR`, served with
 * streamed file responses. Any other page path gets `index.html`, since the website is a single-page
 * app; a missing build file under `/assets/` stays a 404, and a path that can't be decoded
 * is a 400. Without a build, a placeholder page says how to make one.
 */
import { resolve, sep } from "node:path";
import { extname, join } from "node:path";
import { contentType } from "@std/media-types";
import { errorResponse } from "./http/errors.ts";

/** Serves `GET` and `HEAD` requests for the website. */
export function createWebHandler(webDir: string): (request: Request) => Promise<Response> {
  const index = join(webDir, "index.html");
  return async (request) => {
    if (!validPath(new URL(request.url).pathname)) {
      return errorResponse(400, "bad_request", "The address has invalid characters.");
    }
    if (!(await isFile(index))) return placeholder();
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const root = resolve(webDir);
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 404 });
    const response = await fileResponse(request, path);
    if (response.status !== 404 || new URL(request.url).pathname.startsWith("/assets/")) {
      return response;
    }
    return await fileResponse(request, index);
  };
}

async function fileResponse(request: Request, path: string): Promise<Response> {
  if (!(await isFile(path))) return new Response(null, { status: 404 });
  const info = await fs.stat(path);
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  const headers = new Headers({
    "Content-Type": contentType(extname(path)) ?? "application/octet-stream",
    "Content-Length": String(info.size),
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  });
  const matches = request.headers
    .get("If-None-Match")
    ?.split(",")
    .map((value) => value.trim());
  if (matches?.includes(etag) || matches?.includes("*")) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const file = await Deno.open(path);
  return new Response(file.readable, { headers });
}

/** Whether a path decodes and has no NUL. */
function validPath(pathname: string): boolean {
  try {
    return !decodeURIComponent(pathname).includes("\0");
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The page shown when the website hasn't been built. */
function placeholder(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Quaso</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
      code { background: #8882; padding: 0.1em 0.3em; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Quaso is running</h1>
    <p>The API works, but this server has no website to show: its folder has no
      <code>index.html</code>.</p>
    <p>In development, open the address <code>deno task dev</code> printed (Vite serves the
      website). To serve a build from here, run <code>deno task build:web</code>, or set
      <code>WEB_DIR</code> to the folder with the built website.</p>
    <p>Meanwhile: <a href="/healthz">/healthz</a> and
      <a href="/api/v1/openapi.json">the API's OpenAPI document</a>.</p>
  </body>
</html>
`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
