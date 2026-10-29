// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { ExportQuery, s, StringsQuery, UploadRequest } from "@quaso/core";
import { ServiceError } from "@quaso/service";
import { clientIp, parseQuery, readJson, requestId, validateInput } from "./request.ts";

function post(body: BodyInit | null, headers: HeadersInit = {}): Request {
  // Node's Request requires `duplex` for a streamed body.
  const init = { method: "POST", body, headers, duplex: "half" } as RequestInit;
  return new Request("http://quaso.test/api/v1/sources", init);
}

async function rejects(promise: () => Promise<unknown>, code: string): Promise<ServiceError> {
  const error = await Promise.try(promise).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toStrictEqual(code);
  return error;
}

test("readJson: parses a JSON body", async () => {
  expect(await readJson(post('{"files":[]}'), 100)).toStrictEqual({ files: [] });
});

test("readJson: 413 above the limit, declared or streamed", async () => {
  const big = "x".repeat(200);
  const declared = await rejects(
    () => readJson(post(big, { "Content-Length": "200" }), 100),
    "payload_too_large",
  );
  expect(declared.status).toBe(413);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  await rejects(() => readJson(post(stream), 1000), "payload_too_large");
});

test("readJson: 400 for a missing body, invalid UTF-8 or invalid JSON", async () => {
  await rejects(() => readJson(post(null), 100), "bad_request");
  await rejects(() => readJson(post("  "), 100), "bad_request");
  await rejects(() => readJson(post(new Uint8Array([0x7b, 0xff, 0x7d])), 100), "bad_request");
  const error = await rejects(() => readJson(post('{"files": [}'), 100), "bad_request");
  expect(error.message.startsWith("The request body isn't valid JSON")).toBe(true);
});

test("readJson: a body cut off is the client's problem, not the server's", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"files": ['));
      controller.error(new Error("Cannot read request body as underlying resource unavailable"));
    },
  });
  const error = await rejects(() => readJson(post(stream), 1000), "bad_request");
  expect(error.message).toBe("The request body didn't arrive in full.");
});

test("validateInput: 400 validation_failed with a detail per problem", async () => {
  const error = await Promise.try(() =>
    validateInput(UploadRequest, {
      files: [
        { path: "../common.json", repoPath: "common.json", content: "{}" },
        { path: "a.txt", repoPath: "src/a.json" },
      ],
      extra: true,
    }),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("validation_failed");
  expect(error.status).toBe(400);
  expect(error.details).toStrictEqual([
    { path: "files[0].path", message: "must not contain empty, . or .. segments" },
    { path: "files[1].path", message: "must end with .json, .md or .markdown" },
    { path: "files[1].content", message: "is required" },
    { path: "extra", message: "is not a known property" },
  ]);
  expect(error.message).toStrictEqual(
    "Invalid request: files[0].path: must not contain empty, . or .. segments (and 3 more).",
  );
});

test("validateInput: a problem with the whole body has no path", async () => {
  const error = await Promise.try(() => validateInput(UploadRequest, [])).catch(
    (error: unknown) => error,
  );
  assert(error instanceof ServiceError);
  expect(error.details).toStrictEqual([{ message: "must be an object, not an array" }]);
});

test("parseQuery: numbers, booleans and comma-separated lists", () => {
  const query = new URLSearchParams(
    "language=pt-BR&ids=3,4&ids=5&limit=50&state=untranslated&cursor=",
  );
  expect(parseQuery(StringsQuery, query)).toStrictEqual({
    language: "pt-BR",
    ids: [3, 4, 5],
    limit: 50,
    state: "untranslated",
  });
  expect(
    parseQuery(
      ExportQuery,
      new URLSearchParams("languages=de,fr&files=common.json,menus/main.json"),
    ),
  ).toStrictEqual({ languages: ["de", "fr"], files: ["common.json", "menus/main.json"] });
  const Flags = s.object({ dryRun: s.boolean().optional() });
  expect(parseQuery(Flags, new URLSearchParams("dryRun=true"))).toStrictEqual({ dryRun: true });
});

test("parseQuery: problems name the parameter", async () => {
  const error = await Promise.try(() =>
    parseQuery(StringsQuery, new URLSearchParams("ids=1,x&limit=0&colour=red")),
  ).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code).toBe("validation_failed");
  expect(error.details).toStrictEqual([
    { path: "language", message: "is required" },
    { path: "ids[1]", message: "must be an integer, not a string" },
    { path: "limit", message: "must be at least 1" },
    { path: "colour", message: "is not a known property" },
  ]);
});

test("requestId: the proxy's ID only when the proxy is trusted", () => {
  const request = new Request("http://quaso.test/", { headers: { "X-Request-Id": "abc-123" } });
  expect(requestId(request, true)).toBe("abc-123");
  expect(requestId(request, false) === "abc-123").toBe(false);
  const odd = new Request("http://quaso.test/", { headers: { "X-Request-Id": "a b<script>" } });
  expect(requestId(odd, true) === "a b<script>").toBe(false);
});

test("clientIp: X-Forwarded-For only when the proxy is trusted", () => {
  const request = new Request("http://quaso.test/", {
    headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.2" },
  });
  const info = { remoteAddr: { hostname: "10.0.0.2" } };
  expect(clientIp(request, info, true)).toBe("203.0.113.7");
  expect(clientIp(request, info, false)).toBe("10.0.0.2");
  expect(clientIp(new Request("http://quaso.test/"), undefined, true)).toBe(null);
});
