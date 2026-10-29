// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig, resetConfigForTests } from "./config.ts";

test("parseConfig takes a path or an http(s) address, without trailing slashes", () => {
  expect(parseConfig({ apiBase: "/api/v1/" })).toStrictEqual({ apiBase: "/api/v1" });
  expect(parseConfig({ apiBase: "https://api.example.com/api/v1" })).toStrictEqual({
    apiBase: "https://api.example.com/api/v1",
  });
  expect(parseConfig({ apiBase: "javascript:alert(1)" })).toStrictEqual(DEFAULT_CONFIG);
  expect(parseConfig({ apiBase: 5 })).toStrictEqual(DEFAULT_CONFIG);
  expect(parseConfig(null)).toStrictEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.apiBase).toBe("/api/v1");
});

test("loadConfig fetches once and falls back to the defaults", async () => {
  resetConfigForTests();
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(Response.json({ apiBase: "/elsewhere/api" }));
  }) as Fetch;
  expect(await loadConfig(fetcher)).toStrictEqual({ apiBase: "/elsewhere/api" });
  expect(await loadConfig(fetcher)).toStrictEqual({ apiBase: "/elsewhere/api" });
  expect(calls).toBe(1);

  resetConfigForTests();
  const missing = (() => Promise.resolve(new Response("no", { status: 404 }))) as Fetch;
  expect(await loadConfig(missing)).toStrictEqual(DEFAULT_CONFIG);
  resetConfigForTests();
  const offline = (() => Promise.reject(new TypeError("offline"))) as Fetch;
  expect(await loadConfig(offline)).toStrictEqual(DEFAULT_CONFIG);
  resetConfigForTests();
});
