// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const MEMORY_STATEMENTS: Statement[] = [
  { sql: "ALTER TABLE jobs ADD COLUMN reused INTEGER NOT NULL DEFAULT 0" },
  { sql: "ALTER TABLE job_items RENAME TO job_items_previous" },
  {
    sql: `CREATE TABLE job_items (job_id INTEGER NOT NULL, string_id INTEGER NOT NULL, language TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('translated', 'proposed', 'failed', 'skipped', 'reused')),
    PRIMARY KEY (job_id, string_id, language)) STRICT`,
  },
  { sql: "INSERT INTO job_items SELECT * FROM job_items_previous" },
  { sql: "DROP TABLE job_items_previous" },
];
export const MIGRATION_3: Migration = {
  version: 3,
  name: "Translation memory job progress",
  sql: MEMORY_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
