// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import { conflict, ServiceError } from "@quaso/service";
import { memoryLogger } from "../testing/helpers.ts";
import { methodNotAllowedResponse, notFoundResponse, toErrorResponse } from "./errors.ts";

const context = (log = memoryLogger()) => ({
  requestId: "req-1",
  log,
  method: "POST",
  path: "/api/v1/sources",
});

test("errors: a service error becomes its status and body", async () => {
  const error = new ServiceError("qa_failed", "Placeholder {{total}} is missing.", {
    details: [{ file: "common.json", key: "level", language: "pl", check: "placeholder_missing" }],
  });
  const response = toErrorResponse(error, context());
  assertEquals(response.status, 422);
  assertEquals(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertEquals(await response.json(), {
    error: {
      code: "qa_failed",
      message: "Placeholder {{total}} is missing.",
      details: [
        {
          file: "common.json",
          key: "level",
          language: "pl",
          check: "placeholder_missing",
        },
      ],
    },
  });
  const clash = toErrorResponse(conflict("Changed meanwhile.", null), context());
  assertEquals(clash.status, 409);
  assertEquals((await clash.json()).error.current, null);
});

test("errors: anything else is a 500 with the request ID, and is logged", async () => {
  const log = memoryLogger();
  const response = toErrorResponse(new TypeError("undefined is not a function"), context(log));
  assertEquals(response.status, 500);
  assertEquals(await response.json(), {
    error: {
      code: "internal",
      message: "Something went wrong on the server. The request ID is req-1.",
    },
  });
  assertEquals(log.lines.length, 1);
  assertEquals(log.lines[0].level, "error");
  assertEquals(log.lines[0].requestId, "req-1");
  assertEquals((log.lines[0].error as { message: string }).message, "undefined is not a function");
  assertEquals(log.recentErrors()[0].requestId, "req-1");
});

test("errors: 404 and 405 have the API's shape", async () => {
  const missing = notFoundResponse("/api/v1/nothing");
  assertEquals(missing.status, 404);
  assertEquals((await missing.json()).error.code, "not_found");
  const wrong = methodNotAllowedResponse("PUT", "/api/v1/project", ["GET", "HEAD"]);
  assertEquals(wrong.status, 405);
  assertEquals(wrong.headers.get("Allow"), "GET, HEAD");
  assertEquals(await wrong.json(), {
    error: {
      code: "bad_request",
      message: "PUT is not allowed on /api/v1/project. Allowed: GET, HEAD.",
    },
  });
});
