// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const DECLARED_ARGUMENT_STATEMENTS: Statement[] = [
  // JSON: the declared arguments the string receives (StringArgument[]), or NULL for none
  { sql: "ALTER TABLE strings ADD COLUMN arguments TEXT" },
];
export const MIGRATION_7: Migration = {
  version: 7,
  name: "Declared arguments",
  sql: DECLARED_ARGUMENT_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
