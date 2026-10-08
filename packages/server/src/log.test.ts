// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import { createLogger, formatLine } from "./log.ts";

test("log: JSON lines with time, level, message and fields", () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), now: () => Date.UTC(2026, 8, 24) });
  log.info("Listening", { port: 8000 });
  assertEquals(lines, [
    '{"time":"2026-09-24T00:00:00.000Z","level":"info","msg":"Listening","port":8000}',
  ]);
});

test("log: LOG_LEVEL drops the lower levels", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "warn", write: (line) => lines.push(line) });
  log.debug("a");
  log.info("b");
  log.warn("c");
  log.error("d");
  assertEquals(
    lines.map((line) => JSON.parse(line).msg),
    ["c", "d"],
  );
});

test("log: errors become name, message and stack; bigints become strings", () => {
  const line = JSON.parse(formatLine({ error: new TypeError("boom"), rows: 12n }));
  assertEquals(line.error.name, "TypeError");
  assertEquals(line.error.message, "boom");
  assertEquals(typeof line.error.stack, "string");
  assertEquals(line.rows, "12");
});

test("log: the last 50 errors are kept for the admin page", () => {
  let time = 0;
  const log = createLogger({ write: () => {}, now: () => ++time });
  for (let i = 1; i <= 60; i++) log.error(`failure ${i}`, i === 60 ? { requestId: "r-60" } : {});
  log.warn("not an error");
  const errors = log.recentErrors();
  assertEquals(errors.length, 50);
  assertEquals(errors[0], { at: 11, message: "failure 11" });
  assertEquals(errors[49], { at: 60, message: "failure 60", requestId: "r-60" });
});
