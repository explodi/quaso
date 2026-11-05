// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

// The text last uploaded from a context file, or NULL without one: comparing it with `context`
// tells a person's edit from a changed file.
export const CONTEXT_FILE_STATEMENTS: Statement[] = [
  { sql: "ALTER TABLE files ADD COLUMN uploaded_context TEXT" },
  { sql: "ALTER TABLE folders ADD COLUMN uploaded_context TEXT" },
];
export const MIGRATION_9: Migration = {
  version: 9,
  name: "Context files",
  sql: CONTEXT_FILE_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
