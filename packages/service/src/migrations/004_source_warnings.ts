// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const SOURCE_WARNING_STATEMENTS: Statement[] = [
  {
    sql: `CREATE TABLE source_warnings (string_id INTEGER NOT NULL, kind TEXT NOT NULL,
    source_hash TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (string_id, kind)) STRICT`,
  },
  { sql: "ALTER TABLE jobs ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'" },
];
export const MIGRATION_4: Migration = {
  version: 4,
  name: "Source ambiguity reports",
  sql: SOURCE_WARNING_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
