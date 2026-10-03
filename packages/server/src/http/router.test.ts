// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@quaso/runtime/assert";
import { Router } from "./router.ts";

const router = new Router<string>()
  .add("GET", "/api/v1/strings", "list")
  .add("GET", "/api/v1/strings/:id", "get")
  .add("GET", "/api/v1/strings/:id/history", "history")
  .add("POST", "/api/v1/api-tokens", "create")
  .add("GET", "/api/v1/api-tokens", "tokens")
  .add("DELETE", "/api/v1/api-tokens/:id", "revoke");

test("router: matches the method and path, with parameters", () => {
  assertEquals(router.match("GET", "/api/v1/strings"), {
    found: true,
    handler: "list",
    params: {},
  });
  assertEquals(router.match("GET", "/api/v1/strings/42"), {
    found: true,
    handler: "get",
    params: { id: "42" },
  });
  assertEquals(router.match("GET", "/api/v1/strings/42/history"), {
    found: true,
    handler: "history",
    params: { id: "42" },
  });
  assertEquals(router.match("POST", "/api/v1/api-tokens"), {
    found: true,
    handler: "create",
    params: {},
  });
});

test("router: parameters are decoded", () => {
  assertEquals(router.match("GET", "/api/v1/strings/a%20b"), {
    found: true,
    handler: "get",
    params: { id: "a b" },
  });
});

test("router: HEAD uses the GET routes", () => {
  assertEquals(router.match("HEAD", "/api/v1/strings")?.found, true);
});

test("router: the path with another method lists the allowed ones", () => {
  assertEquals(router.match("DELETE", "/api/v1/strings/1"), {
    found: false,
    allowed: ["GET", "HEAD"],
  });
  assertEquals(router.match("PUT", "/api/v1/api-tokens"), {
    found: false,
    allowed: ["POST", "GET", "HEAD"],
  });
});

test("router: an unknown path is null", () => {
  assertEquals(router.match("GET", "/api/v1/nothing"), null);
  assertEquals(router.match("GET", "/api/v1/strings/1/2/3"), null);
});
