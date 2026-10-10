// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import {
  askServer,
  AWAKE,
  parseWake,
  resetServerStateForTests,
  serverStateForTests,
  waitUntilAwake,
} from "./wake.ts";

const NOW = 1_000_000;

/** A `/wake` that gives these answers in turn, and counts the questions. */
function answering(...answers: Response[]) {
  const asked = { count: 0 };
  const fetcher = (() => Promise.resolve(answers[asked.count++])) as Fetch;
  return { fetcher, asked };
}

const starting = (elapsedMs: number) =>
  Response.json({ state: "starting", elapsedMs, expectedMs: 60_000 });

test("parseWake reads a start in progress", () => {
  assertEquals(parseWake({ state: "starting", elapsedMs: 5000, expectedMs: 60_000 }, NOW), {
    state: "starting",
    elapsedMs: 5000,
    expectedMs: 60_000,
    receivedAt: NOW,
  });
});

test("parseWake reads a pause", () => {
  assertEquals(parseWake({ state: "paused" }, NOW), { state: "paused" });
});

test("parseWake takes a ready server, and anything else, as awake", () => {
  assertEquals(parseWake({ state: "ready" }, NOW), AWAKE);
  assertEquals(parseWake({ state: "starting" }, NOW), AWAKE);
  assertEquals(parseWake("<!doctype html>", NOW), AWAKE);
  assertEquals(parseWake(null, NOW), AWAKE);
});

test("askServer takes a server without /wake as awake", async () => {
  const page = new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
  assertEquals(await askServer(answering(page).fetcher), AWAKE);
  const missing = new Response("Not found", { status: 404 });
  assertEquals(await askServer(answering(missing).fetcher), AWAKE);
});

test("askServer takes a network failure as awake", async () => {
  const failing = (() => Promise.reject(new TypeError("offline"))) as Fetch;
  assertEquals(await askServer(failing), AWAKE);
});

test("waitUntilAwake asks until the server is ready, then says it is awake", async () => {
  resetServerStateForTests();
  const wake = answering(starting(1000), starting(3000), Response.json({ state: "ready" }));
  const seen: string[] = [];
  await waitUntilAwake(wake.fetcher, () => {
    seen.push(serverStateForTests().state);
    return Promise.resolve();
  });
  assertEquals(wake.asked.count, 3);
  assertEquals(seen, ["starting", "starting"]);
  assertEquals(serverStateForTests(), AWAKE);
});

test("waitUntilAwake shares one wait between callers", async () => {
  resetServerStateForTests();
  const wake = answering(starting(1000), Response.json({ state: "ready" }));
  const sleep = () => Promise.resolve();
  await Promise.all([waitUntilAwake(wake.fetcher, sleep), waitUntilAwake(wake.fetcher, sleep)]);
  assertEquals(wake.asked.count, 2);
});
