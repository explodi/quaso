// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { createLogger, formatLine } from "./log.ts";

test("log: JSON lines with time, level, message and fields", () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), now: () => Date.UTC(2026, 8, 24) });
  log.info("Listening", { port: 8000 });
  expect(lines).toStrictEqual([
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
  expect(lines.map((line) => JSON.parse(line).msg)).toStrictEqual(["c", "d"]);
});

test("log: errors become name, message and stack; bigints become strings", () => {
  const line = JSON.parse(formatLine({ error: new TypeError("boom"), rows: 12n }));
  expect(line.error.name).toBe("TypeError");
  expect(line.error.message).toBe("boom");
  expect(typeof line.error.stack).toBe("string");
  expect(line.rows).toBe("12");
});

test("log: the last 50 errors are kept for the admin page", () => {
  let time = 0;
  const log = createLogger({ write: () => {}, now: () => ++time });
  for (let i = 1; i <= 60; i++) log.error(`failure ${i}`, i === 60 ? { requestId: "r-60" } : {});
  log.warn("not an error");
  const errors = log.recentErrors();
  expect(errors.length).toBe(50);
  expect(errors[0]).toStrictEqual({ at: 11, message: "failure 11" });
  expect(errors[49]).toStrictEqual({ at: 60, message: "failure 60", requestId: "r-60" });
});
