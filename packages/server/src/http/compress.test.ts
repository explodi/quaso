// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { acceptsGzip, compress, MIN_COMPRESS_SIZE } from "./compress.ts";

function request(acceptEncoding?: string): Request {
  const headers: HeadersInit = acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {};
  return new Request("http://quaso.test/api/v1/export", { headers });
}

function body(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function gunzip(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await new Response(stream).arrayBuffer();
  const plain = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(plain).text();
}

const BIG = JSON.stringify({ files: "x".repeat(MIN_COMPRESS_SIZE * 4) });

test("compress: Accept-Encoding with gzip, a wildcard, or q=0", () => {
  expect(acceptsGzip(request())).toBe(false);
  expect(acceptsGzip(request("gzip"))).toBe(true);
  expect(acceptsGzip(request("br, gzip;q=0.8"))).toBe(true);
  expect(acceptsGzip(request("GZIP"))).toBe(true);
  expect(acceptsGzip(request("*"))).toBe(true);
  expect(acceptsGzip(request("br"))).toBe(false);
  expect(acceptsGzip(request("gzip;q=0"))).toBe(false);
  expect(acceptsGzip(request("identity"))).toBe(false);
});

test("compress: JSON for a client that accepts gzip, with a weak ETag", async () => {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(BIG.length),
    ETag: '"abc"',
    Vary: "Authorization, Cookie",
  });
  const compressed = compress(request("gzip, deflate, br"), 200, headers, body(BIG))!;
  expect(headers.get("Content-Encoding")).toBe("gzip");
  expect(headers.has("Content-Length")).toBe(false);
  expect(headers.get("ETag")).toBe('W/"abc"');
  expect(headers.get("Vary")).toBe("Authorization, Cookie, Accept-Encoding");
  expect(await gunzip(compressed)).toStrictEqual(BIG);
});

test("compress: unchanged without gzip, but Vary names Accept-Encoding", async () => {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  const plain = compress(request(), 200, headers, body(BIG))!;
  expect(headers.has("Content-Encoding")).toBe(false);
  expect(headers.get("Vary")).toBe("Accept-Encoding");
  expect(await new Response(plain).text()).toStrictEqual(BIG);
});

test("compress: small, binary, encoded, partial and empty responses stay as they are", () => {
  const cases: [number, HeadersInit, ReadableStream<Uint8Array> | null][] = [
    [200, { "Content-Type": "application/json", "Content-Length": "40" }, body("{}")],
    [200, { "Content-Type": "image/png" }, body(BIG)],
    [200, { "Content-Type": "text/plain", "Content-Encoding": "br" }, body(BIG)],
    [206, { "Content-Type": "text/javascript", "Content-Range": "bytes 0-9/99" }, body(BIG)],
    [304, { "Content-Type": "text/css" }, null],
  ];
  for (const [status, init, stream] of cases) {
    const headers = new Headers(init);
    const result = compress(request("gzip"), status, headers, stream);
    expect(result).toStrictEqual(stream);
    expect(headers.get("Content-Encoding")).toStrictEqual(
      new Headers(init).get("Content-Encoding"),
    );
  }
});
