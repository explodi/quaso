// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const CONTEXTUAL_CHECK_STATEMENTS: Statement[] = [
  { sql: "ALTER TABLE translations ADD COLUMN extra_checks TEXT NOT NULL DEFAULT '[]'" },
  {
    sql: `CREATE TRIGGER clear_translation_checks AFTER UPDATE OF value, source_hash ON translations
      WHEN OLD.value <> NEW.value OR OLD.source_hash <> NEW.source_hash
      BEGIN UPDATE translations SET extra_checks = '[]' WHERE string_id = NEW.string_id AND language = NEW.language; END`,
  },
];
export const MIGRATION_2: Migration = {
  version: 2,
  name: "Contextual translation quality checks",
  sql: CONTEXTUAL_CHECK_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
