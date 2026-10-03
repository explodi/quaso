// SPDX-License-Identifier: MIT
import { writeSync } from "node:fs";
/**
 * Structured logs (design §8, Observability): one JSON object per line on stdout,
 * `{"time","level","msg",...fields}`, which `docker compose logs` shows. The logger also
 * keeps the most recent errors for the admin page.
 */
import type { Logger } from "@quaso/service";
import { LOG_LEVELS, type LogLevel } from "./config.ts";

/** An error, as the admin page lists it. */
export interface RecentError {
  at: number;
  message: string;
  requestId?: string;
}

export interface ServerLogger extends Logger {
  /** The last errors, oldest first. */
  recentErrors(): RecentError[];
}

export interface LoggerOptions {
  /** Messages below this level are dropped. Default: `info`. */
  level?: LogLevel;
  /** Writes one line. Default: stdout. */
  write?: (line: string) => void;
  now?: () => number;
  /** How many errors to keep. Default: 50. */
  keepErrors?: number;
}

/** A logger that writes JSON lines. */
export function createLogger(options: LoggerOptions = {}): ServerLogger {
  const minimum = LOG_LEVELS.indexOf(options.level ?? "info");
  const write = options.write ?? writeStdout;
  const now = options.now ?? Date.now;
  const keep = options.keepErrors ?? 50;
  const errors: RecentError[] = [];

  function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const time = now();
    if (level === "error") {
      const requestId = typeof fields.requestId === "string" ? fields.requestId : undefined;
      errors.push({ at: time, message: msg, ...(requestId ? { requestId } : {}) });
      if (errors.length > keep) errors.splice(0, errors.length - keep);
    }
    if (LOG_LEVELS.indexOf(level) < minimum) return;
    write(formatLine({ time: new Date(time).toISOString(), level, msg, ...fields }));
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    recentErrors: () => [...errors],
  };
}

/** One line of JSON. Errors become `{ name, message, stack }`; bigints become strings. */
export function formatLine(record: Record<string, unknown>): string {
  return JSON.stringify(record, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

const encoder = new TextEncoder();

function writeStdout(line: string): void {
  const bytes = encoder.encode(line + "\n");
  let written = 0;
  while (written < bytes.length) written += writeSync(1, bytes.subarray(written));
}
