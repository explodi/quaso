// SPDX-License-Identifier: MIT
/**
 * What every part of the service works with: the database, the clock, the logger and the
 * options that shape defaults.
 */
import type { Clock, Logger, SyncSql } from "./ports.ts";

export interface Context {
  sql: SyncSql;
  clock: Clock;
  logger: Logger;
  /** The LLM model for new settings (`GEMINI_MODEL`). */
  defaultModel: string;
}

/** The model new instances use when `GEMINI_MODEL` isn't set. */
export const FALLBACK_MODEL = "gemini-flash-latest";
