// SPDX-License-Identifier: MIT
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";

export const PROOFREAD_TRANSLATION_STATEMENTS: Statement[] = [
  {
    // A proofread translation replaced after its source text changed: it comes back, blue,
    // should the source text return to the one it was proofread for.
    sql: `CREATE TABLE proofread_translations (
  string_id INTEGER NOT NULL REFERENCES strings (id),
  language TEXT NOT NULL,
  -- The hash of the source text it was proofread for
  source_hash TEXT NOT NULL,
  -- canonicalValue() JSON
  value TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id INTEGER,
  author_label TEXT,
  approver_id INTEGER,
  set_aside_at INTEGER NOT NULL,
  PRIMARY KEY (string_id, language, source_hash)
) STRICT`,
  },
];
export const MIGRATION_8: Migration = {
  version: 8,
  name: "Proofread translations",
  sql: PROOFREAD_TRANSLATION_STATEMENTS.map((statement) => statement.sql).join(";\n") + ";",
};
