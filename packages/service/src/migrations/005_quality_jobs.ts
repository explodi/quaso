// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const QUALITY_JOB_STATEMENTS: Statement[] = [
  {
    sql: `CREATE TABLE quality_jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL,
    targets TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', model TEXT NOT NULL, counts_budget INTEGER NOT NULL DEFAULT 1,
    total INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '[]', error TEXT, wake_at INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER) STRICT`,
  },
  { sql: "ALTER TABLE llm_requests ADD COLUMN counts_budget INTEGER NOT NULL DEFAULT 1" },
  { sql: "ALTER TABLE suggestions ADD COLUMN extra_checks TEXT NOT NULL DEFAULT '[]'" },
];
export const MIGRATION_5: Migration = {
  version: 5,
  name: "Meaning check jobs and budget accounting",
  sql: QUALITY_JOB_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
