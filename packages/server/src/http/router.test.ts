// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { Router } from "./router.ts";

const router = new Router<string>()
  .add("GET", "/api/v1/strings", "list")
  .add("GET", "/api/v1/strings/:id", "get")
  .add("GET", "/api/v1/strings/:id/history", "history")
  .add("POST", "/api/v1/api-tokens", "create")
  .add("GET", "/api/v1/api-tokens", "tokens")
  .add("DELETE", "/api/v1/api-tokens/:id", "revoke");

test("router: matches the method and path, with parameters", () => {
  expect(router.match("GET", "/api/v1/strings")).toStrictEqual({
    found: true,
    handler: "list",
    params: {},
  });
  expect(router.match("GET", "/api/v1/strings/42")).toStrictEqual({
    found: true,
    handler: "get",
    params: { id: "42" },
  });
  expect(router.match("GET", "/api/v1/strings/42/history")).toStrictEqual({
    found: true,
    handler: "history",
    params: { id: "42" },
  });
  expect(router.match("POST", "/api/v1/api-tokens")).toStrictEqual({
    found: true,
    handler: "create",
    params: {},
  });
});

test("router: parameters are decoded", () => {
  expect(router.match("GET", "/api/v1/strings/a%20b")).toStrictEqual({
    found: true,
    handler: "get",
    params: { id: "a b" },
  });
});

test("router: HEAD uses the GET routes", () => {
  expect(router.match("HEAD", "/api/v1/strings")?.found).toBe(true);
});

test("router: the path with another method lists the allowed ones", () => {
  expect(router.match("DELETE", "/api/v1/strings/1")).toStrictEqual({
    found: false,
    allowed: ["GET", "HEAD"],
  });
  expect(router.match("PUT", "/api/v1/api-tokens")).toStrictEqual({
    found: false,
    allowed: ["POST", "GET", "HEAD"],
  });
});

test("router: an unknown path is null", () => {
  expect(router.match("GET", "/api/v1/nothing")).toBe(null);
  expect(router.match("GET", "/api/v1/strings/1/2/3")).toBe(null);
});
