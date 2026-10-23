// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const FOLDER_CONTEXT_STATEMENTS: Statement[] = [
  {
    sql: `CREATE TABLE folders (path TEXT PRIMARY KEY, context TEXT NOT NULL,
    updated_at INTEGER NOT NULL) STRICT`,
  },
];
export const MIGRATION_6: Migration = {
  version: 6,
  name: "Folder context",
  sql: FOLDER_CONTEXT_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
