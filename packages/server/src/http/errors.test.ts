// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
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
  expect(response.status).toBe(422);
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(await response.json()).toStrictEqual({
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
  expect(clash.status).toBe(409);
  expect((await clash.json()).error.current).toBe(null);
});

test("errors: anything else is a 500 with the request ID, and is logged", async () => {
  const log = memoryLogger();
  const response = toErrorResponse(new TypeError("undefined is not a function"), context(log));
  expect(response.status).toBe(500);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "internal",
      message: "Something went wrong on the server. The request ID is req-1.",
    },
  });
  expect(log.lines.length).toBe(1);
  expect(log.lines[0].level).toBe("error");
  expect(log.lines[0].requestId).toBe("req-1");
  expect((log.lines[0].error as { message: string }).message).toStrictEqual(
    "undefined is not a function",
  );
  expect(log.recentErrors()[0].requestId).toBe("req-1");
});

test("errors: 404 and 405 have the API's shape", async () => {
  const missing = notFoundResponse("/api/v1/nothing");
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe("not_found");
  const wrong = methodNotAllowedResponse("PUT", "/api/v1/project", ["GET", "HEAD"]);
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("Allow")).toBe("GET, HEAD");
  expect(await wrong.json()).toStrictEqual({
    error: {
      code: "bad_request",
      message: "PUT is not allowed on /api/v1/project. Allowed: GET, HEAD.",
    },
  });
});
