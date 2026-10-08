// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { DEFAULT_CONFIG, loadConfig, parseConfig, resetConfigForTests } from "./config.ts";

test("parseConfig takes a path or an http(s) address, without trailing slashes", () => {
  assertEquals(parseConfig({ apiBase: "/api/v1/" }), { apiBase: "/api/v1" });
  assertEquals(parseConfig({ apiBase: "https://api.example.com/api/v1" }), {
    apiBase: "https://api.example.com/api/v1",
  });
  assertEquals(parseConfig({ apiBase: "javascript:alert(1)" }), DEFAULT_CONFIG);
  assertEquals(parseConfig({ apiBase: 5 }), DEFAULT_CONFIG);
  assertEquals(parseConfig(null), DEFAULT_CONFIG);
  assertEquals(DEFAULT_CONFIG.apiBase, "/api/v1");
});

test("loadConfig fetches once and falls back to the defaults", async () => {
  resetConfigForTests();
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(Response.json({ apiBase: "/elsewhere/api" }));
  }) as Fetch;
  assertEquals(await loadConfig(fetcher), { apiBase: "/elsewhere/api" });
  assertEquals(await loadConfig(fetcher), { apiBase: "/elsewhere/api" });
  assertEquals(calls, 1);

  resetConfigForTests();
  const missing = (() => Promise.resolve(new Response("no", { status: 404 }))) as Fetch;
  assertEquals(await loadConfig(missing), DEFAULT_CONFIG);
  resetConfigForTests();
  const offline = (() => Promise.reject(new TypeError("offline"))) as Fetch;
  assertEquals(await loadConfig(offline), DEFAULT_CONFIG);
  resetConfigForTests();
});
