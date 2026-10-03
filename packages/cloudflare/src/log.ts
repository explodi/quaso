// SPDX-License-Identifier: MIT
/**
 * Logs for Workers Logs (design §8, Observability): one JSON object per message,
 * `{"level","msg",...fields}`, which Workers Logs indexes field by field. Errors become
 * `{ name, message, stack }`.
 */
import type { Logger } from "@quaso/service";

type Level = "debug" | "info" | "warn" | "error";

/** Writes one record. Default: the console, at the record's level. */
export type LogWriter = (level: Level, line: string) => void;

const consoleWriter: LogWriter = (level, line) => console[level](line);

/** A logger that writes JSON records, each with `component` (such as "data" or "worker"). */
export function createLogger(component: string, write: LogWriter = consoleWriter): Logger {
  const log =
    (level: Level) =>
    (msg: string, fields: Record<string, unknown> = {}) =>
      write(level, formatRecord({ level, msg, component, ...fields }));
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** One record as JSON. */
export function formatRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}
