// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ExportQuery, s, StringsQuery, UploadRequest } from "@quaso/core";
import { ServiceError } from "@quaso/service";
import { clientIp, parseQuery, readJson, requestId, validateInput } from "./request.ts";

function post(body: BodyInit | null, headers: HeadersInit = {}): Request {
  return new Request("http://quaso.test/api/v1/sources", { method: "POST", body, headers });
}

async function rejects(promise: () => Promise<unknown>, code: string): Promise<ServiceError> {
  const error = await assertRejects(promise, ServiceError);
  assertEquals(error.code, code);
  return error;
}

test("readJson: parses a JSON body", async () => {
  assertEquals(await readJson(post('{"files":[]}'), 100), { files: [] });
});

test("readJson: 413 above the limit, declared or streamed", async () => {
  const big = "x".repeat(200);
  const declared = await rejects(
    () => readJson(post(big, { "Content-Length": "200" }), 100),
    "payload_too_large",
  );
  assertEquals(declared.status, 413);
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
  assertEquals(error.message.startsWith("The request body isn't valid JSON"), true);
});

test("readJson: a body cut off is the client's problem, not the server's", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"files": ['));
      controller.error(new Error("Cannot read request body as underlying resource unavailable"));
    },
  });
  const error = await rejects(() => readJson(post(stream), 1000), "bad_request");
  assertEquals(error.message, "The request body didn't arrive in full.");
});

test("validateInput: 400 validation_failed with a detail per problem", () => {
  const error = assertThrows(
    () =>
      validateInput(UploadRequest, {
        files: [{ path: "../common.json", content: "{}" }, { path: "a.txt" }],
        extra: true,
      }),
    ServiceError,
  );
  assertEquals(error.code, "validation_failed");
  assertEquals(error.status, 400);
  assertEquals(error.details, [
    { path: "files[0].path", message: "must not contain empty, . or .. segments" },
    { path: "files[1].path", message: "must end with .json" },
    { path: "files[1].content", message: "is required" },
    { path: "extra", message: "is not a known property" },
  ]);
  assertEquals(
    error.message,
    "Invalid request: files[0].path: must not contain empty, . or .. segments (and 3 more).",
  );
});

test("validateInput: a problem with the whole body has no path", () => {
  const error = assertThrows(() => validateInput(UploadRequest, []), ServiceError);
  assertEquals(error.details, [{ message: "must be an object, not an array" }]);
});

test("parseQuery: numbers, booleans and comma-separated lists", () => {
  const query = new URLSearchParams(
    "language=pt-BR&ids=3,4&ids=5&limit=50&state=untranslated&cursor=",
  );
  assertEquals(parseQuery(StringsQuery, query), {
    language: "pt-BR",
    ids: [3, 4, 5],
    limit: 50,
    state: "untranslated",
  });
  assertEquals(
    parseQuery(
      ExportQuery,
      new URLSearchParams("languages=de,fr&files=common.json,menus/main.json"),
    ),
    { languages: ["de", "fr"], files: ["common.json", "menus/main.json"] },
  );
  const Flags = s.object({ dryRun: s.boolean().optional() });
  assertEquals(parseQuery(Flags, new URLSearchParams("dryRun=true")), { dryRun: true });
});

test("parseQuery: problems name the parameter", () => {
  const error = assertThrows(
    () => parseQuery(StringsQuery, new URLSearchParams("ids=1,x&limit=0&colour=red")),
    ServiceError,
  );
  assertEquals(error.code, "validation_failed");
  assertEquals(error.details, [
    { path: "language", message: "is required" },
    { path: "ids[1]", message: "must be an integer, not a string" },
    { path: "limit", message: "must be at least 1" },
    { path: "colour", message: "is not a known property" },
  ]);
});

test("requestId: the proxy's ID only when the proxy is trusted", () => {
  const request = new Request("http://quaso.test/", { headers: { "X-Request-Id": "abc-123" } });
  assertEquals(requestId(request, true), "abc-123");
  assertEquals(requestId(request, false) === "abc-123", false);
  const odd = new Request("http://quaso.test/", { headers: { "X-Request-Id": "a b<script>" } });
  assertEquals(requestId(odd, true) === "a b<script>", false);
});

test("clientIp: X-Forwarded-For only when the proxy is trusted", () => {
  const request = new Request("http://quaso.test/", {
    headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.2" },
  });
  const info = { remoteAddr: { hostname: "10.0.0.2" } };
  assertEquals(clientIp(request, info, true), "203.0.113.7");
  assertEquals(clientIp(request, info, false), "10.0.0.2");
  assertEquals(clientIp(new Request("http://quaso.test/"), undefined, true), null);
});
