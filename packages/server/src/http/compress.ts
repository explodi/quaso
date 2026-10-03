// SPDX-License-Identifier: MIT
/**
 * Gzip for text responses (S2.5: a compressed download; design §5.12). `serveHttp` doesn't
 * compress responses itself, and neither does the Caddyfile, so the server does it: JSON,
 * HTML, JavaScript, CSS, SVG and other text, when the client accepts gzip.
 */
import { mergeVary } from "./headers.ts";

/** Bodies smaller than this aren't worth compressing. */
export const MIN_COMPRESS_SIZE = 1024;

const COMPRESSIBLE =
  /^(text\/|application\/(json|javascript|xml|manifest\+json|schema\+json)|image\/svg\+xml)/i;

/** Whether the request's `Accept-Encoding` allows gzip (and doesn't give it `q=0`). */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("Accept-Encoding");
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name.trim() !== "gzip" && name.trim() !== "*") return false;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * Compresses `body` with gzip when the client accepts it and the response is text that
 * isn't already encoded, partial, or known to be smaller than `MIN_COMPRESS_SIZE`. Updates
 * `headers` (Content-Encoding, Content-Length, a weak ETag, and `Vary: Accept-Encoding` on
 * every compressible response, so caches keep the two forms apart). Returns the body to send.
 */
export function compress(
  request: Request,
  status: number,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (!COMPRESSIBLE.test(headers.get("Content-Type") ?? "")) return body;
  if (headers.has("Content-Encoding") || headers.has("Content-Range") || status === 206) {
    return body;
  }
  headers.set("Vary", mergeVary(headers.get("Vary"), ["Accept-Encoding"]));
  if (body === null || !acceptsGzip(request)) return body;
  const length = headers.get("Content-Length");
  if (length !== null && Number(length) < MIN_COMPRESS_SIZE) return body;

  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  const etag = headers.get("ETag");
  if (etag && !etag.startsWith("W/")) headers.set("ETag", `W/${etag}`);
  const gzip = new CompressionStream("gzip");
  // A CompressionStream takes any BufferSource; response bodies are Uint8Arrays.
  return body.pipeThrough({
    writable: gzip.writable as WritableStream<Uint8Array>,
    readable: gzip.readable,
  });
}
