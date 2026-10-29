// SPDX-License-Identifier: MIT
import type { Fetch } from "@quaso/core";
import { expect, test } from "vitest";
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
  expect(parseWake({ state: "starting", elapsedMs: 5000, expectedMs: 60_000 }, NOW)).toStrictEqual({
    state: "starting",
    elapsedMs: 5000,
    expectedMs: 60_000,
    receivedAt: NOW,
  });
});

test("parseWake reads a pause", () => {
  expect(parseWake({ state: "paused" }, NOW)).toStrictEqual({ state: "paused" });
});

test("parseWake takes a ready server, and anything else, as awake", () => {
  expect(parseWake({ state: "ready" }, NOW)).toStrictEqual(AWAKE);
  expect(parseWake({ state: "starting" }, NOW)).toStrictEqual(AWAKE);
  expect(parseWake("<!doctype html>", NOW)).toStrictEqual(AWAKE);
  expect(parseWake(null, NOW)).toStrictEqual(AWAKE);
});

test("askServer takes a server without /wake as awake", async () => {
  const page = new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
  expect(await askServer(answering(page).fetcher)).toStrictEqual(AWAKE);
  const missing = new Response("Not found", { status: 404 });
  expect(await askServer(answering(missing).fetcher)).toStrictEqual(AWAKE);
});

test("askServer takes a network failure as awake", async () => {
  const failing = (() => Promise.reject(new TypeError("offline"))) as Fetch;
  expect(await askServer(failing)).toStrictEqual(AWAKE);
});

test("waitUntilAwake asks until the server is ready, then says it is awake", async () => {
  resetServerStateForTests();
  const wake = answering(starting(1000), starting(3000), Response.json({ state: "ready" }));
  const seen: string[] = [];
  await waitUntilAwake(wake.fetcher, () => {
    seen.push(serverStateForTests().state);
    return Promise.resolve();
  });
  expect(wake.asked.count).toBe(3);
  expect(seen).toStrictEqual(["starting", "starting"]);
  expect(serverStateForTests()).toStrictEqual(AWAKE);
});

test("waitUntilAwake shares one wait between callers", async () => {
  resetServerStateForTests();
  const wake = answering(starting(1000), Response.json({ state: "ready" }));
  const sleep = () => Promise.resolve();
  await Promise.all([waitUntilAwake(wake.fetcher, sleep), waitUntilAwake(wake.fetcher, sleep)]);
  expect(wake.asked.count).toBe(2);
});
