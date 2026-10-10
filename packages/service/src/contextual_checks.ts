// SPDX-License-Identifier: MIT
/** File-wide warnings refresh after source or translation writes without changing human text. */
import {
  checkDuplicateTranslations,
  checkTranslationConsistency,
  type CheckResult,
  type EntryKind,
  type TextValue,
} from "@quaso/core";
import { fromJson, getRevision } from "./db.ts";
import type { Sql, SqlRow, Statement, SyncSql } from "./ports.ts";

const SNAPSHOT = `SELECT t.string_id, t.language, t.value, t.revision, t.extra_checks,
  s.file_id, f.path, s.display_key, s.kind, s.source, s.source_hash FROM translations t
  JOIN strings s ON s.id = t.string_id JOIN files f ON f.id = s.file_id
  WHERE s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')`;

function updates(rows: SqlRow[], revision: number): Statement[] {
  const entries = rows.map((row) => ({
    id: Number(row.string_id),
    fileId: Number(row.file_id),
    file: String(row.path),
    language: String(row.language),
    key: String(row.display_key),
    kind: row.kind as EntryKind,
    source: fromJson<TextValue>(row.source),
    translation: fromJson<TextValue>(row.value),
  }));
  const duplicates = checkDuplicateTranslations(entries);
  const consistency = checkTranslationConsistency(entries);
  const statements: Statement[] = [];
  for (const row of rows) {
    const key = JSON.stringify([Number(row.string_id), row.language]);
    const other = fromJson<CheckResult[]>(row.extra_checks).filter(
      (check) => check.check !== "duplicate_translation" && check.check !== "consistency",
    );
    const checks = JSON.stringify([
      ...other,
      ...(duplicates.get(key) ?? []),
      ...(consistency.get(key) ?? []),
    ]);
    if (checks === row.extra_checks) continue;
    statements.push({
      sql: `UPDATE translations SET extra_checks = ? WHERE string_id = ? AND language = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM strings WHERE id = ? AND source_hash = ?)
        AND (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision') = ?`,
      params: [
        checks,
        row.string_id,
        row.language,
        row.revision,
        row.string_id,
        row.source_hash,
        revision,
      ],
    });
  }
  return statements;
}

export function refreshContextualChecksSync(sql: SyncSql): void {
  for (const statement of updates(sql.query(SNAPSHOT), getRevision(sql)))
    sql.run(statement.sql, ...(statement.params ?? []));
}

export async function refreshContextualChecks(sql: Sql): Promise<void> {
  const [revision, rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
    { sql: SNAPSHOT },
  ]);
  const statements = updates(rows, Number(revision[0]?.revision ?? 0));
  if (statements.length > 0) await sql.migrate(statements);
}

export function withContextualChecks(sql: Sql): Sql {
  return {
    ...sql,
    async commit(revision, statements) {
      const next = await sql.commit(revision, statements);
      const changedText = statements.some((statement) =>
        /(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:translations|strings|files)\b/i.test(
          statement.sql,
        ),
      );
      if (changedText) await refreshContextualChecks(sql);
      return next;
    },
  };
}
